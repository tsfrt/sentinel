import { sql } from 'drizzle-orm';
import { getExecutionContext } from '@databricks/appkit';
import type { AppDb } from './index.js';
import {
  paymentPosition,
  openQueue,
  dispositionRecommendations,
} from './schema.js';
import type { ActionOption } from './schema.js';

/**
 * One-shot Delta → Lakebase sync — Sentinel Payment Integrity.
 *
 * > In production this is Lakebase Synced Tables (managed, continuous
 * > Delta→Lakebase replication with the same UC governance). For the demo
 * > build we keep it simple: a manual one-shot sync at boot, code we can
 * > show, no extra resource. Same outcome on screen.
 *
 * Pulls the three READ-ONLY Gold mirrors:
 *   - payment_position         (the flagged payments + flagged count)
 *   - open_queue               (open flag + risk metrics)
 *   - disposition_recommendations (the ML model's ranked dispositions)
 *
 * `case_actions` is the app's own WRITABLE table — never synced, starts empty.
 *
 * The disposition_recommendations table is BUILT BY THE TRAINEE (the ML step of
 * the workshop). So its query is fault-tolerant: if the table doesn't exist
 * yet, we log + leave the mirror empty rather than failing boot.
 *
 * Idempotent in the "only-if-destination-empty" sense — if the position
 * mirror has rows, we skip. Pass `{ forceIfAnyEmpty: true }` to re-sync
 * on demand (used by the "Reset demo" button).
 */

type DataConfig = {
  catalog: string;
  schema: string;
  tables: {
    /** gold_queue_scored — one row per payment with risk metrics. */
    paymentPosition: string;
    /** gold_open_queue — open flag + risk metrics. */
    openQueue: string;
    /** gold_disposition_recommendations — the ML model's ranked dispositions.
     *  Built by the trainee; sync tolerates it not existing yet. */
    dispositionRecommendations?: string;
  };
};

export async function syncFromDelta(
  db: AppDb,
  cfg: DataConfig,
  opts: { forceIfAnyEmpty?: boolean } = {},
): Promise<void> {
  const exists = await db.execute(
    sql`SELECT COUNT(*)::int AS n FROM app.payment_position`,
  );
  const n = (exists.rows[0] as { n: number } | undefined)?.n ?? 0;
  if (n > 0 && !opts.forceIfAnyEmpty) return;

  const warehouseId = process.env.DATABRICKS_WAREHOUSE_ID;
  if (!warehouseId) {
    console.warn('[sync] DATABRICKS_WAREHOUSE_ID not set — skipping Delta sync');
    return;
  }

  console.log('[sync] Starting Delta → Lakebase sync (parallel)…');
  const t0 = Date.now();

  const fq = (name: 'paymentPosition' | 'openQueue' | 'dispositionRecommendations') =>
    `${cfg.catalog}.${cfg.schema}.${cfg.tables[name]}`;

  const hasDispositionTable = Boolean(cfg.tables.dispositionRecommendations);

  // Fire the position + queue queries in parallel (the slow part). The
  // disposition-recommendations query is BEST-EFFORT (the trainee may not have
  // built that Gold table yet), so run it defensively and swallow a
  // TABLE_OR_VIEW_NOT_FOUND into an empty result.
  const [positionRows, queueRows, dispositionRows] = await Promise.all([
    execSql<{
      payment_id: string;
      payment_amount: number | null;
      signal_type: string;
      signal_name: string | null;
      category: string | null;
      risk_level: string | null;
      improper_payment_exposure_usd: number | null;
      flag_risk_score: number | null;
      flag_frequency: number | null;
      recommended_disposition: string | null;
      hold_duration_hours: number | null;
      flag_status: string | null;
    }>(
      warehouseId,
      `SELECT payment_id, payment_amount, signal_type, signal_name, category,
              risk_level, improper_payment_exposure_usd, flag_risk_score,
              flag_frequency, recommended_disposition, hold_duration_hours,
              flag_status
       FROM ${fq('paymentPosition')}`,
    ),
    execSql<{
      payment_id: string;
      signal_type: string;
      improper_payment_exposure_usd: number | null;
      risk_level: string | null;
      signal_list: string | null;
      flag_frequency: number | null;
      hold_duration_hours: number | null;
    }>(
      warehouseId,
      `SELECT payment_id, signal_type, improper_payment_exposure_usd,
              risk_level, signal_list, flag_frequency, hold_duration_hours
       FROM ${fq('openQueue')}`,
    ),
    hasDispositionTable
      ? execSql<{
          payment_id: string;
          signal_type: string;
          recommended_disposition: string | null;
          recommended_hold_hours: number | null;
          predicted_recovery_usd: number | null;
          predicted_cost_usd: number | null;
          action_ranking: string | null;
          scored_at: string | null;
        }>(
          warehouseId,
          `SELECT payment_id, signal_type, recommended_disposition,
                  recommended_hold_hours, predicted_recovery_usd,
                  predicted_cost_usd,
                  to_json(action_ranking) AS action_ranking, scored_at
           FROM ${fq('dispositionRecommendations')}`,
        ).catch((e) => {
          // The trainee builds this table in the ML step — until then it
          // won't exist. Degrade gracefully so the app still boots + the
          // Visualize layer works; the agent's rank tool is the trainee's
          // Build-2 task anyway.
          console.warn(
            `[sync] disposition_recommendations not available yet (this is the trainee's ML step) — leaving that mirror empty: ${(e as Error).message}`,
          );
          return [] as never[];
        })
      : Promise.resolve([] as never[]),
  ]);
  console.log(
    `[sync]   queries done (${((Date.now() - t0) / 1000).toFixed(1)}s) — inserting…`,
  );

  if (positionRows.length) {
    await chunkInsert(positionRows, 2_000, (chunk) =>
      db
        .insert(paymentPosition)
        .values(
          chunk.map((r) => ({
            id: `${r.payment_id}:${r.signal_type}`,
            paymentId: r.payment_id,
            paymentAmount: r.payment_amount === null ? null : Number(r.payment_amount),
            signalType: r.signal_type,
            signalName: r.signal_name,
            category: r.category,
            riskLevel: r.risk_level,
            improperPaymentExposureUsd:
              r.improper_payment_exposure_usd === null
                ? null
                : Number(r.improper_payment_exposure_usd),
            flagRiskScore: r.flag_risk_score === null ? null : Number(r.flag_risk_score),
            flagFrequency:
              r.flag_frequency === null ? null : Number(r.flag_frequency),
            recommendedDisposition: r.recommended_disposition,
            holdDurationHours:
              r.hold_duration_hours === null ? null : Number(r.hold_duration_hours),
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
            flagStatus: (r.flag_status === 'flagged' ||
            r.flag_status === 'verified' ||
            r.flag_status === 'cleared' ||
            r.flag_status === 'escalated'
              ? r.flag_status
              : 'flagged') as 'flagged' | 'verified' | 'cleared' | 'escalated',
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   positions: ${positionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (queueRows.length) {
    await chunkInsert(queueRows, 5_000, (chunk) =>
      db
        .insert(openQueue)
        .values(
          chunk.map((r) => ({
            id: `${r.payment_id}:${r.signal_type}`,
            paymentId: r.payment_id,
            signalType: r.signal_type,
            improperPaymentExposureUsd:
              r.improper_payment_exposure_usd === null
                ? null
                : Number(r.improper_payment_exposure_usd),
            riskLevel: r.risk_level,
            signalList: r.signal_list,
            flagFrequency:
              r.flag_frequency === null ? null : Number(r.flag_frequency),
            holdDurationHours:
              r.hold_duration_hours === null ? null : Number(r.hold_duration_hours),
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   queue: ${queueRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  if (dispositionRows.length) {
    await chunkInsert(dispositionRows, 5_000, (chunk) =>
      db
        .insert(dispositionRecommendations)
        .values(
          chunk.map((r) => ({
            id: `${r.payment_id}:${r.signal_type}`,
            paymentId: r.payment_id,
            signalType: r.signal_type,
            recommendedDisposition: (r.recommended_disposition === 'release' ||
            r.recommended_disposition === 'hold_for_verification' ||
            r.recommended_disposition === 'refer_to_investigation'
              ? r.recommended_disposition
              : null) as
              | 'release'
              | 'hold_for_verification'
              | 'refer_to_investigation'
              | null,
            recommendedHoldHours:
              r.recommended_hold_hours === null ? null : Number(r.recommended_hold_hours),
            predictedRecoveryUsd:
              r.predicted_recovery_usd === null
                ? null
                : Number(r.predicted_recovery_usd),
            predictedCostUsd:
              r.predicted_cost_usd === null ? null : Number(r.predicted_cost_usd),
            actionRanking: parseActionRanking(r.action_ranking),
          })),
        )
        .onConflictDoNothing(),
    );
  }
  console.log(
    `[sync]   disposition recommendations: ${dispositionRows.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`,
  );

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[sync] Done in ${dt}s`);
}

/** `action_ranking` comes back as a JSON string (we `to_json(...)` it in SQL
 *  because the SQL Statements API serializes complex types as strings).
 *  Parse defensively — a malformed ranking just becomes []. */
function parseActionRanking(raw: string | null): ActionOption[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ActionOption[]) : [];
  } catch {
    return [];
  }
}

/**
 * Reset: truncate the app's writable table + chat state, then re-sync the
 * read-only mirrors. All agent writes are wiped — flags return to open,
 * exposure returns to full. Intentional: between presentations the backlog
 * should look untouched.
 */
export async function wipeMirroredTables(db: AppDb): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`TRUNCATE TABLE app.feedback RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.messages RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.conversations RESTART IDENTITY CASCADE`);
    // The writable action table — the only place agent writes land.
    await tx.execute(sql`TRUNCATE TABLE app.case_actions RESTART IDENTITY CASCADE`);
    // Read-only mirrors — re-pulled by syncFromDelta after this.
    await tx.execute(sql`TRUNCATE TABLE app.disposition_recommendations RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.open_queue RESTART IDENTITY CASCADE`);
    await tx.execute(sql`TRUNCATE TABLE app.payment_position RESTART IDENTITY CASCADE`);
  });
}

async function execSql<T>(
  warehouseId: string,
  statement: string,
): Promise<T[]> {
  const { client } = getExecutionContext();
  type StmtResp = {
    statement_id: string;
    status: { state: string; error?: { message: string } };
    manifest?: {
      schema: { columns: Array<{ name: string }> };
      chunks?: Array<{ chunk_index: number; row_count: number }>;
    };
    result?: {
      chunk_index: number;
      row_count: number;
      data_array?: Array<Array<unknown>>;
      next_chunk_index?: number;
    };
  };

  const initial = (await client.apiClient.request({
    method: 'POST',
    path: '/api/2.0/sql/statements',
    payload: {
      statement,
      warehouse_id: warehouseId,
      wait_timeout: '50s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
    },
    headers: new Headers(),
    raw: false,
    query: {},
  })) as StmtResp;

  // Cap total polling at 10 minutes. The warehouse can take a couple of
  // minutes to spin from idle + scan, but a state stuck in RUNNING beyond
  // 10 min is broken — fail loud instead of silently blocking boot forever.
  const POLL_DEADLINE_MS = 10 * 60 * 1000;
  const startedAt = Date.now();

  let cur = initial;
  while (
    cur.status.state !== 'SUCCEEDED' &&
    cur.status.state !== 'FAILED' &&
    cur.status.state !== 'CANCELED'
  ) {
    if (Date.now() - startedAt > POLL_DEADLINE_MS) {
      throw new Error(
        `[sync] SQL still ${cur.status.state} after 10 minutes — aborting (statement_id=${cur.statement_id})`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
    cur = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp;
  }
  if (cur.status.state !== 'SUCCEEDED') {
    throw new Error(
      `[sync] SQL failed: ${cur.status.error?.message ?? cur.status.state}`,
    );
  }

  const cols = cur.manifest?.schema.columns.map((c) => c.name) ?? [];
  const rows: T[] = [];
  let chunk = cur.result;
  while (chunk) {
    for (const row of chunk.data_array ?? []) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < cols.length; i++) obj[cols[i]] = row[i];
      rows.push(obj as T);
    }
    if (chunk.next_chunk_index === undefined || chunk.next_chunk_index === null) break;
    chunk = (await client.apiClient.request({
      method: 'GET',
      path: `/api/2.0/sql/statements/${cur.statement_id}/result/chunks/${chunk.next_chunk_index}`,
      headers: new Headers(),
      raw: false,
      query: {},
    })) as StmtResp['result'];
  }
  return rows;
}

async function chunkInsert<T>(
  rows: T[],
  size: number,
  fn: (chunk: T[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}
