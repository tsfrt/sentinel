import { sql } from 'drizzle-orm';
import type { AppDb } from '../index.js';
import type { AuditEntry, ActionOption } from '../schema.js';

export type { AuditEntry, ActionOption };

export type RiskLevel = 'high' | 'moderate';
export type Disposition =
  | 'release'
  | 'hold_for_verification'
  | 'refer_to_investigation';
export type ActionStatus = 'proposed' | 'approved' | 'executed' | 'overridden';

const num = (v: number | string | null): number | null =>
  v === null || v === undefined ? null : Number(v);

const asRisk = (v: string | null): RiskLevel =>
  v === 'high' ? 'high' : 'moderate';

const asDisposition = (v: string | null): Disposition | null =>
  v === 'release' || v === 'hold_for_verification' || v === 'refer_to_investigation'
    ? v
    : null;

const asActionStatus = (v: string | null): ActionStatus | null =>
  v === 'proposed' || v === 'approved' || v === 'executed' || v === 'overridden'
    ? v
    : null;

// ============================================================================
// PaymentRow — the Operations queue's primary entity. Reads the synced
// read-only queue mirror (payment_position / gold_queue_scored), LEFT JOIN-ed
// to its LATEST case_actions row (so `live_disposition` / `action_status`
// reflect the writable table) and to disposition_recommendations (the model's
// recommended disposition per flagged payment).
// ============================================================================

export type PaymentRow = {
  paymentId: string;
  program: string | null;
  state: string | null;
  paymentAmountUsd: number | null;
  queueDate: string | null;
  nSignals: number | null;
  signals: string | null;
  riskLevel: RiskLevel;
  improperPaymentExposureUsd: number | null;
  projectedRecoveryIfInvestigatedUsd: number | null;
  recommendedDisposition: Disposition | null;
  confidenceScore: number | null;
  liveDisposition: Disposition | null;
  actionStatus: ActionStatus | null;
};

type PaymentSqlRow = {
  payment_id: string;
  program: string | null;
  state: string | null;
  payment_amount_usd: number | string | null;
  queue_date: string | null;
  n_signals: number | null;
  signals: string | null;
  risk_level: string | null;
  improper_payment_exposure_usd: number | string | null;
  projected_recovery_if_investigated_usd: number | string | null;
  recommended_disposition: string | null;
  confidence_score: number | string | null;
  live_disposition: string | null;
  action_status: string | null;
};

function toPaymentRow(r: PaymentSqlRow): PaymentRow {
  return {
    paymentId: r.payment_id,
    program: r.program,
    state: r.state,
    paymentAmountUsd: num(r.payment_amount_usd),
    queueDate: r.queue_date,
    nSignals: r.n_signals === null ? null : Number(r.n_signals),
    signals: r.signals,
    riskLevel: asRisk(r.risk_level),
    improperPaymentExposureUsd: num(r.improper_payment_exposure_usd),
    projectedRecoveryIfInvestigatedUsd: num(r.projected_recovery_if_investigated_usd),
    recommendedDisposition: asDisposition(r.recommended_disposition),
    confidenceScore: num(r.confidence_score),
    liveDisposition: asDisposition(r.live_disposition),
    actionStatus: asActionStatus(r.action_status),
  };
}

// SELECT list shared by list + single-payment reads. Reads payment_position
// (the synced queue mirror), LEFT JOIN-ing:
//   - disposition_recommendations → the model's recommended disposition,
//   - the LATEST case_actions row for that payment (DISTINCT via LATERAL) →
//     the live disposition badge + "case in progress".
const PAYMENT_SELECT = sql`
  SELECT
    p.payment_id, p.program, p.state, p.payment_amount_usd, p.queue_date,
    p.n_signals, p.signals, p.risk_level,
    p.improper_payment_exposure_usd, p.projected_recovery_if_investigated_usd,
    dr.recommended_disposition,
    dr.confidence_score,
    la.action_type AS live_disposition,
    la.status AS action_status
  FROM app.payment_position p
  LEFT JOIN app.disposition_recommendations dr
    ON dr.payment_id = p.payment_id
  LEFT JOIN LATERAL (
    SELECT a.action_type, a.status
    FROM app.case_actions a
    WHERE a.payment_id = p.payment_id
    ORDER BY a.created_at DESC
    LIMIT 1
  ) la ON true
`;

/**
 * The pre-disbursement queue. Reads payment_position, LEFT JOIN-ing the model's
 * recommended disposition + the latest case action.
 *
 * `statusGroup='open'` (default) filters to payments without a recorded case
 * action yet (still in the work queue). Pass `riskLevel`, `program`, or a
 * specific `payment` to narrow.
 */
export async function listPayments(
  db: AppDb,
  opts: {
    /** 'open' = no case action yet (the work queue); 'all' = everything. */
    statusGroup?: 'open' | 'all';
    riskLevel?: RiskLevel;
    program?: string;
    payment?: string;
    /** 'exposure' = ORDER BY improper_payment_exposure DESC (default);
     *  'recovery' = ORDER BY projected_recovery DESC. */
    sort?: 'exposure' | 'recovery';
    limit?: number;
  } = {},
): Promise<PaymentRow[]> {
  const limit = opts.limit ?? 300;
  const statusGroup = opts.statusGroup ?? 'all';

  const whereOpen =
    statusGroup === 'open' ? sql`AND la.action_type IS NULL` : sql``;
  const whereRisk = opts.riskLevel
    ? sql`AND p.risk_level = ${opts.riskLevel}`
    : sql``;
  const whereProgram = opts.program ? sql`AND p.program = ${opts.program}` : sql``;
  const wherePayment = opts.payment ? sql`AND p.payment_id = ${opts.payment}` : sql``;
  const orderBy =
    opts.sort === 'recovery'
      ? sql`ORDER BY p.projected_recovery_if_investigated_usd DESC NULLS LAST`
      : sql`ORDER BY p.improper_payment_exposure_usd DESC NULLS LAST`;

  const result = await db.execute(sql`
    ${PAYMENT_SELECT}
    WHERE 1=1 ${whereOpen} ${whereRisk} ${whereProgram} ${wherePayment}
    ${orderBy}
    LIMIT ${limit}
  `);
  return (result.rows as PaymentSqlRow[]).map(toPaymentRow);
}

export async function getPayment(
  db: AppDb,
  paymentId: string,
): Promise<PaymentRow | null> {
  const result = await db.execute(sql`
    ${PAYMENT_SELECT}
    WHERE p.payment_id = ${paymentId}
    LIMIT 1
  `);
  const row = result.rows[0] as PaymentSqlRow | undefined;
  return row ? toPaymentRow(row) : null;
}

// ============================================================================
// OpenFlag — the flagged payment's open-queue context (read-only mirror).
// ============================================================================

export type OpenFlag = {
  paymentId: string;
  nSignals: number | null;
  signalList: string | null;
  riskLevel: RiskLevel | null;
  improperPaymentExposureUsd: number | null;
};

export async function getOpenFlag(
  db: AppDb,
  paymentId: string,
): Promise<OpenFlag | null> {
  const res = await db.execute(sql`
    SELECT payment_id, n_signals, signal_list, risk_level,
           improper_payment_exposure_usd
    FROM app.open_queue
    WHERE payment_id = ${paymentId}
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        payment_id: string;
        n_signals: number | null;
        signal_list: string | null;
        risk_level: string | null;
        improper_payment_exposure_usd: number | string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    paymentId: r.payment_id,
    nSignals: r.n_signals === null ? null : Number(r.n_signals),
    signalList: r.signal_list,
    riskLevel: r.risk_level === 'high' || r.risk_level === 'moderate' ? r.risk_level : null,
    improperPaymentExposureUsd: num(r.improper_payment_exposure_usd),
  };
}

/**
 * The worst OPEN flagged payment by improper-payment exposure. Used by the
 * agent's `find_flag` tool (Build 2) when the user doesn't name a payment.
 * Ships as a helper so the trainee's tool has a ready query.
 */
export async function worstFlag(db: AppDb): Promise<OpenFlag | null> {
  const res = await db.execute(sql`
    SELECT payment_id, n_signals, signal_list, risk_level,
           improper_payment_exposure_usd
    FROM app.open_queue
    ORDER BY improper_payment_exposure_usd DESC NULLS LAST
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        payment_id: string;
        n_signals: number | null;
        signal_list: string | null;
        risk_level: string | null;
        improper_payment_exposure_usd: number | string | null;
      }
    | undefined;
  if (!r) return null;
  return {
    paymentId: r.payment_id,
    nSignals: r.n_signals === null ? null : Number(r.n_signals),
    signalList: r.signal_list,
    riskLevel: r.risk_level === 'high' || r.risk_level === 'moderate' ? r.risk_level : null,
    improperPaymentExposureUsd: num(r.improper_payment_exposure_usd),
  };
}

// ============================================================================
// DispositionRecommendation — the model's ranked dispositions (read-only mirror).
// ============================================================================

export type DispositionRecommendation = {
  paymentId: string;
  recommendedDisposition: Disposition | null;
  recommendedHoldHours: number | null;
  predictedRecoveryUsd: number | null;
  predictedCostUsd: number | null;
  actionRanking: ActionOption[];
};

export async function getRecommendation(
  db: AppDb,
  paymentId: string,
): Promise<DispositionRecommendation | null> {
  const res = await db.execute(sql`
    SELECT payment_id, recommended_disposition, recommended_hold_hours,
           predicted_recovery_usd, predicted_cost_usd, action_ranking
    FROM app.disposition_recommendations
    WHERE payment_id = ${paymentId}
    LIMIT 1
  `);
  const r = res.rows[0] as
    | {
        payment_id: string;
        recommended_disposition: string | null;
        recommended_hold_hours: number | null;
        predicted_recovery_usd: number | string | null;
        predicted_cost_usd: number | string | null;
        action_ranking: ActionOption[] | null;
      }
    | undefined;
  if (!r) return null;
  return {
    paymentId: r.payment_id,
    recommendedDisposition: asDisposition(r.recommended_disposition),
    recommendedHoldHours:
      r.recommended_hold_hours === null ? null : Number(r.recommended_hold_hours),
    predictedRecoveryUsd: num(r.predicted_recovery_usd),
    predictedCostUsd: num(r.predicted_cost_usd),
    actionRanking: Array.isArray(r.action_ranking) ? r.action_ranking : [],
  };
}

// ============================================================================
// CaseAction — the writable table (the app's own disposition records).
// ============================================================================

export type CaseAction = {
  id: string;
  paymentId: string;
  actionType: Disposition;
  holdDurationHours: number | null;
  draftedRequest: string | null;
  predictedRecoveryUsd: number | null;
  status: ActionStatus;
  approvedBy: string | null;
  auditTrail: AuditEntry[];
  createdAt: string;
  decidedAt: string | null;
};

type CaseActionSqlRow = {
  id: string;
  payment_id: string;
  action_type: string;
  hold_duration_hours: number | null;
  drafted_request: string | null;
  predicted_recovery_usd: number | string | null;
  status: string;
  approved_by: string | null;
  audit_trail: AuditEntry[];
  created_at: string;
  decided_at: string | null;
};

function toCaseAction(r: CaseActionSqlRow): CaseAction {
  return {
    id: r.id,
    paymentId: r.payment_id,
    actionType: (asDisposition(r.action_type) ?? 'hold_for_verification') as Disposition,
    holdDurationHours: r.hold_duration_hours === null ? null : Number(r.hold_duration_hours),
    draftedRequest: r.drafted_request,
    predictedRecoveryUsd: num(r.predicted_recovery_usd),
    status: asActionStatus(r.status) ?? 'approved',
    approvedBy: r.approved_by,
    auditTrail: Array.isArray(r.audit_trail) ? r.audit_trail : [],
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

/** All recorded case actions for a payment (the drawer's Activity timeline). */
export async function listActionsForPayment(
  db: AppDb,
  paymentId: string,
): Promise<CaseAction[]> {
  const res = await db.execute(sql`
    SELECT id, payment_id, action_type, hold_duration_hours,
           drafted_request, predicted_recovery_usd, status, approved_by,
           audit_trail, created_at, decided_at
    FROM app.case_actions
    WHERE payment_id = ${paymentId}
    ORDER BY created_at DESC
  `);
  return (res.rows as CaseActionSqlRow[]).map(toCaseAction);
}

// ============================================================================
// KPI summary for the Operations header.
// ============================================================================

export type QueueSummary = {
  improperPaymentExposureUsd: number;
  projectedRecoveryUsd: number;
  flaggedCount: number;
  referRecommendedCount: number;
};

/**
 * KPI rollup. Improper-payment exposure sums flagged payments that DON'T yet
 * have a recorded case action (so the number ticks down as the examiner acts).
 * Flagged count = open flagged payments; refer-recommended counts those the
 * model recommends for investigation.
 */
export async function queueSummary(db: AppDb): Promise<QueueSummary> {
  const res = await db.execute(sql`
    WITH acted AS (
      SELECT DISTINCT payment_id FROM app.case_actions
    )
    SELECT
      COALESCE(SUM(p.improper_payment_exposure_usd) FILTER (
        WHERE a.payment_id IS NULL
      ), 0)::float8 AS improper_payment_exposure_usd,
      COALESCE(SUM(p.projected_recovery_if_investigated_usd) FILTER (
        WHERE a.payment_id IS NULL
      ), 0)::float8 AS projected_recovery_usd,
      COUNT(*) FILTER (WHERE a.payment_id IS NULL)::int AS flagged_count,
      COUNT(*) FILTER (
        WHERE a.payment_id IS NULL
          AND dr.recommended_disposition = 'refer_to_investigation'
      )::int AS refer_recommended_count
    FROM app.payment_position p
    LEFT JOIN acted a ON a.payment_id = p.payment_id
    LEFT JOIN app.disposition_recommendations dr ON dr.payment_id = p.payment_id
  `);
  const r = (res.rows[0] ?? {}) as {
    improper_payment_exposure_usd: number | string;
    projected_recovery_usd: number | string;
    flagged_count: number;
    refer_recommended_count: number;
  };
  return {
    improperPaymentExposureUsd: Number(r.improper_payment_exposure_usd ?? 0),
    projectedRecoveryUsd: Number(r.projected_recovery_usd ?? 0),
    flaggedCount: r.flagged_count ?? 0,
    referRecommendedCount: r.refer_recommended_count ?? 0,
  };
}

// ============================================================================
// Program-level aggregation for the risk breakdown chart. One row per program
// with its flagged count + exposure + worst risk level.
// ============================================================================

export type ProgramBucket = {
  program: string;
  flaggedCount: number;
  improperPaymentExposureUsd: number;
  riskLevel: RiskLevel;
};

export async function programBreakdown(
  db: AppDb,
  opts: { riskLevel?: RiskLevel; limit?: number } = {},
): Promise<ProgramBucket[]> {
  const limit = opts.limit ?? 50;
  const whereRisk = opts.riskLevel ? sql`AND p.risk_level = ${opts.riskLevel}` : sql``;
  const res = await db.execute(sql`
    SELECT
      COALESCE(p.program, 'Unknown') AS program,
      COUNT(*)::int AS flagged_count,
      COALESCE(SUM(p.improper_payment_exposure_usd), 0)::float8 AS improper_payment_exposure_usd,
      MIN(CASE p.risk_level WHEN 'high' THEN 0 ELSE 1 END) AS worst_rank
    FROM app.payment_position p
    WHERE 1=1 ${whereRisk}
    GROUP BY p.program
    ORDER BY improper_payment_exposure_usd DESC
    LIMIT ${limit}
  `);
  return (
    res.rows as Array<{
      program: string;
      flagged_count: number;
      improper_payment_exposure_usd: number | string;
      worst_rank: number;
    }>
  ).map((r) => ({
    program: r.program,
    flaggedCount: r.flagged_count,
    improperPaymentExposureUsd: Number(r.improper_payment_exposure_usd),
    riskLevel: r.worst_rank === 0 ? 'high' : 'moderate',
  }));
}

// ============================================================================
// Recent activity — the app's case_actions rows, newest first. Powers the
// Home page activity feed.
// ============================================================================

export type ActivityEvent = {
  kind: 'action';
  action_id: string;
  payment_id: string;
  at: string;
  by: string;
  action_type: Disposition;
  status: ActionStatus;
  hold_duration_hours: number | null;
  predicted_recovery_usd: number | null;
  notes: string | null;
};

export async function recentActivity(
  db: AppDb,
  limit = 20,
): Promise<ActivityEvent[]> {
  const res = await db.execute(sql`
    SELECT
      a.id AS action_id,
      a.payment_id,
      COALESCE(a.decided_at, a.created_at) AS at,
      COALESCE(a.approved_by, 'system') AS by,
      a.action_type,
      a.status,
      a.hold_duration_hours,
      a.predicted_recovery_usd,
      a.drafted_request AS notes
    FROM app.case_actions a
    ORDER BY COALESCE(a.decided_at, a.created_at) DESC NULLS LAST
    LIMIT ${limit}
  `);
  return (
    res.rows as Array<{
      action_id: string;
      payment_id: string;
      at: string;
      by: string;
      action_type: string;
      status: string;
      hold_duration_hours: number | null;
      predicted_recovery_usd: number | string | null;
      notes: string | null;
    }>
  ).map((r) => ({
    kind: 'action' as const,
    action_id: r.action_id,
    payment_id: r.payment_id,
    at: r.at,
    by: r.by,
    action_type: (asDisposition(r.action_type) ?? 'hold_for_verification') as Disposition,
    status: asActionStatus(r.status) ?? 'approved',
    hold_duration_hours: r.hold_duration_hours === null ? null : Number(r.hold_duration_hours),
    predicted_recovery_usd: num(r.predicted_recovery_usd),
    notes: r.notes,
  }));
}
