/**
 * The case-ops action-taking agent — the DEMO'S DEFINING PIECE, and the
 * WORKSHOP'S main graded surface.
 *
 * Built on `@openai/agents` (OpenAI Agents SDK) pointed at Databricks'
 * Responses API. Tools capture `db` + `userEmail` via closure so every
 * action is attributed to the viewing user (OBO).
 *
 * ════════════════════════════════════════════════════════════════════════
 * WHAT SHIPS WORKING vs WHAT THE TRAINEE BUILDS  (see APP_WORKSHOP.md)
 * ════════════════════════════════════════════════════════════════════════
 * SHIPS WORKING:
 *   - The full agent loop (Responses API wiring, streaming, MLflow spans).
 *   - `ask_data` — the investigation tool. Config-driven MAS-OR-Genie:
 *     uses the MAS endpoint if `masEndpointName` is set, else the Genie
 *     space if `genieSpaceId` is set. This is the trainee's Build-1 choice
 *     (they wire ONE backend); the app registers whichever is configured.
 *
 * TRAINEE BUILDS (stubbed here — they THROW "not implemented" so the app
 * still compiles + boots, and the model knows the tools exist):
 *   - `find_flag`         → Build 2 (Assist): read the live shortfall
 *   - `rank_dispositions`    → Build 2 (Assist): read the ML recommendation
 *   - `execute_case_action`→ Build 3 (Act):   the human-in-the-loop write
 *
 * The three-phase chain (Discover → Draft+confirm → Execute) is described in
 * the instructions below so the model attempts it — but Phases 2/3 depend on
 * the stubbed tools, which is the point: the trainee implements them and the
 * chain lights up. Until then, the model can still investigate via ask_data.
 *
 * KEEP `configureAgentsSdk()` as-is — it handles the Databricks Responses API
 * wiring, the `Connection: close` stale-socket workaround, and the 64-char
 * `input[*].id` strip.
 */
import type { Request } from 'express';
import OpenAI from 'openai';
import {
  Agent,
  run,
  setDefaultOpenAIClient,
  setTracingDisabled,
} from '@openai/agents';
import type { Tool } from '@openai/agents';
import { loggedTool as tool } from './tools/logged-tool.js';
import * as mlflow from 'mlflow-tracing';
import { z } from 'zod';
import { authHeaders } from '../lib/auth.js';
import type { AppDb } from '../db/index.js';
// The data-backend helpers. Both are config-driven and share the same
// DataCallResult shape + ToolProgressEvent stream, so the `ask_data` tool
// below can delegate to EITHER without the UI caring which powers it. This
// preserves the template's MAS-OR-Genie flexibility exactly.
import { callMasEndpoint } from './tools/mas.js';
import { callGenieSpace } from './tools/genie.js';
export type { ToolProgressEvent } from './tools/types.js';

/** Captured detail of the last failing call to the model serving endpoint. */
export type ModelErrorDetail = {
  status: number;
  url: string;
  bodyText: string;
  code?: string;
  message?: string;
};

export type AgentContext = {
  db: AppDb;
  userEmail: string;
  req: Request;
  /** MAS serving-endpoint name the `ask_data` tool talks to WHEN SET. Set in
   * `config/app.json` as `masEndpointName` (env `MAS_ENDPOINT_NAME`). Leave
   * empty to use Genie instead. This is the trainee's Build-1 backend choice
   * — the app registers whichever of MAS/Genie is configured. */
  masEndpointName: string;
  /** Genie space id the `ask_data` tool talks to WHEN `masEndpointName` is
   * empty. Set as `genieSpaceId` (env `GENIE_SPACE_ID`). */
  genieSpaceId: string;
  databricksHost: string;
  model: string;
  /** Called by long-running tools to surface progress to the UI. */
  onToolProgress?: (ev: import('./tools/types.js').ToolProgressEvent) => void;
  /** Mutated by the OpenAI fetch shim on any non-2xx. */
  modelError?: { current: ModelErrorDetail | null };
};

// ────────────────────────────────────────────────────────────────────────────
// Adding / editing tools — READ THIS before touching `parameters: z.object(...)`.
//
// The Agents SDK ships every tool's zod schema to the Responses API with
// `strict: true`. Strict mode requires EVERY property in `required`. So use
// `.nullable()`, NOT `.optional()`:
//   ❌  reason: z.string().optional()   // breaks with strict:true (masked 502)
//   ✅  reason: z.string().nullable()   // field required, value may be null
// Every field needs a `.describe(...)`. Keep property names snake_case.
// Use the `loggedTool` wrapper (imported as `tool`), not the raw SDK `tool`.
// ────────────────────────────────────────────────────────────────────────────
function makeTools(ctx: AgentContext): Tool[] {
  // ── ask_data — SHIPS WORKING. Config-driven MAS-OR-Genie. ─────────────────
  // Delegates to the MAS endpoint if one is configured, else the Genie space.
  // Both helpers return {answer, trace_id} and stream progress via
  // ctx.onToolProgress → the Thinking panel. Registered ONLY when a backend
  // is configured (otherwise the tool would 404 confusingly).
  const askData = tool({
    name: 'ask_data',
    description:
      'Investigate the governed lakehouse with a natural-language question — the tool generates SQL / retrieves knowledge and returns a synthesized answer. Use for any "why" / "what happened" / investigative question about store positions, sell-through, shortfalls, or surplus. Prefer ONE narrow, well-formed question over many small ones.',
    parameters: z.object({
      question: z
        .string()
        .describe(
          'A clear, focused English question about the data. Narrow questions finish in 20–40s; broad multi-part questions take longer.',
        ),
    }),
    execute: async ({ question }) =>
      mlflow.withSpan(
        async () =>
          ctx.masEndpointName
            ? callMasEndpoint(ctx, ctx.masEndpointName, question)
            : callGenieSpace(ctx, ctx.genieSpaceId, question),
        {
          name: 'ask_data',
          spanType: mlflow.SpanType.TOOL,
          inputs: { question },
        },
      ),
  });

  // ── find_flag — TRAINEE BUILDS (Build 2 · Assist). STUB. ─────────────
  // TODO — BUILD 2 (trainee): implement this. Read the open flag for a
  // payment (or the worst one) from Lakebase app.open_queue + app.payment_position:
  // the fraud/eligibility signals on it, n_signals, risk_level, and
  // improper-payment exposure. Helper queries are READY in
  // server/db/queries/cases.ts: `getOpenFlag`, `worstFlag`, `getPayment`.
  // See APP_WORKSHOP.md → "Layer 2 — Assist".
  const findShortfall = tool({
    name: 'find_flag',
    description:
      'Read the live flag for a payment (or the worst open flagged payment) from Lakebase: the fraud/eligibility signals on it, the signal count, risk level, and improper-payment exposure. Read-only.',
    parameters: z.object({
      payment_id: z
        .string()
        .nullable()
        .describe('Payment id, e.g. PAY-0000214. Null → return the worst open flagged payment.'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── rank_dispositions — TRAINEE BUILDS (Build 2 · Assist). STUB. ────────
  // TODO — BUILD 2 (trainee): implement this. Read app.disposition_recommendations
  // for {payment_id} and return the model's recommended_disposition,
  // predicted_recovery_usd, predicted_cost_usd, and the full action_ranking
  // (all three dispositions with predicted recovery $ + net $ + cost). This is the
  // demo's "ML in the loop" moment — the agent quotes the ranked options + the
  // recommended disposition in the draft, and recomputes the what-if
  // arithmetically from action_ranking. Helper query READY: `getRecommendation`
  // in cases.ts. See APP_WORKSHOP.md → "Layer 2 — Assist".
  const rankRecoveryMoves = tool({
    name: 'rank_dispositions',
    description:
      "Read the model's ranked dispositions for a payment from Lakebase app.disposition_recommendations: the recommended disposition, its predicted recovery $ + net value, and the full ranking of all three options (release / hold_for_verification / refer_to_investigation) with each option's hold hours, cost, predicted recovery $ and net $. Read-only. Quote these in the draft; do the what-if (recovery vs. citizen-delay cost) arithmetically from the ranking.",
    parameters: z.object({
      payment_id: z.string().describe('Payment id, e.g. PAY-0000214.'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2 Assist task; see APP_WORKSHOP.md',
      );
    },
  });

  // ── execute_case_action — TRAINEE BUILDS (Build 3 · Act). STUB. ───────
  // TODO — BUILD 3 (trainee): implement this — the human-in-the-loop WRITE.
  // ONLY call this AFTER the examiner has explicitly approved. Write the approved
  // disposition to Lakebase app.case_actions (action_type, hold_duration_hours,
  // the drafted memo text, predicted_recovery_usd, status='approved',
  // approved_by=ctx.userEmail, an appended audit entry). Inputs are a FILTER
  // ({payment_id, action_type, hold_duration_hours?}) + the drafted memo text —
  // NEVER a list of ids. Wrap the write in db.transaction(...). On commit the
  // caller emits dataMutated so the Operations page cascades. See
  // APP_WORKSHOP.md → "Layer 3 — Act".
  const executeRecoveryAction = tool({
    name: 'execute_case_action',
    description:
      "WRITE (requires prior examiner approval): record the approved disposition to Lakebase app.case_actions — action_type (release / hold_for_verification / refer_to_investigation), hold duration, the drafted memo, predicted recovery $ — and append an audit entry. Inputs are a FILTER + the drafted memo text, never a list of ids. Use ONLY after the examiner says yes.",
    parameters: z.object({
      payment_id: z.string().describe('The payment being dispositioned, e.g. PAY-0000214.'),
      action_type: z
        .enum(['release', 'hold_for_verification', 'refer_to_investigation'])
        .describe('The approved disposition.'),
      hold_duration_hours: z
        .number()
        .int()
        .nullable()
        .describe('For a hold: how long to hold the payment (hours), e.g. 48. Null otherwise.'),
      drafted_request: z
        .string()
        .describe('The case memo / investigation referral the agent drafted.'),
      predicted_recovery_usd: z
        .number()
        .describe('Predicted recovery for this disposition (from rank_dispositions).'),
    }),
    execute: async () => {
      throw new Error(
        'Not implemented — this is your Build 2/3 Assist/Act task; see APP_WORKSHOP.md',
      );
    },
  });

  // find_flag / rank_dispositions / execute_case_action are
  // registered so the MODEL knows they exist (and the trainee sees them in
  // the tool list) — they throw until implemented. ask_data is registered
  // only when a backend is configured.
  const tools: Tool[] = [findShortfall, rankRecoveryMoves, executeRecoveryAction];
  if (ctx.masEndpointName || ctx.genieSpaceId) {
    tools.unshift(askData);
  }
  return tools;
}

export async function configureAgentsSdk(ctx: AgentContext): Promise<void> {
  const headers = await authHeaders(ctx.req);
  const bearer = headers.get('Authorization')?.replace(/^Bearer /, '') ?? '';
  // Custom fetch: fresh TCP connection per call (avoids the stale-socket 502
  // after a long ask_data hop) + strip the >64-char `input[*].id` the SDK
  // echoes back on round 2 (Databricks' Responses API rejects long ids and
  // the streaming gateway masks the 400 as a bare 502). See git history.
  const client = new OpenAI({
    apiKey: bearer,
    baseURL: `${ctx.databricksHost}/serving-endpoints`,
    maxRetries: 4,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Connection', 'close');
      let body = init?.body;
      if (typeof body === 'string' && body.startsWith('{')) {
        try {
          const parsed = JSON.parse(body) as {
            input?: Array<Record<string, unknown>>;
            messages?: Array<Record<string, unknown>>;
          };
          if (Array.isArray(parsed.input)) {
            for (const item of parsed.input) {
              const id = item.id;
              if (typeof id === 'string' && id.length > 64) {
                delete item.id;
              }
            }
          }
          if (Array.isArray(parsed.messages)) {
            for (const m of parsed.messages) {
              const content = (m as { content?: unknown }).content;
              if (Array.isArray(content)) {
                for (const part of content as Array<Record<string, unknown>>) {
                  if (part && typeof part === 'object') {
                    delete part.annotations;
                  }
                }
              }
            }
          }
          body = JSON.stringify(parsed);
        } catch {
          /* not JSON — pass through */
        }
      }
      const url =
        typeof input === 'string'
          ? input
          : (input as URL | Request).toString?.() ?? String(input);
      console.debug(
        `[openai-shim] → ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 2000) : '(non-string)'}`,
      );
      const tShim = Date.now();
      let resp: Response;
      try {
        resp = await fetch(input as Parameters<typeof fetch>[0], {
          ...init,
          headers,
          body,
          keepalive: false,
        });
      } catch (e) {
        console.error('[openai-shim] fetch threw', { url, error: e });
        throw e;
      }
      console.debug(
        `[openai-shim] ← ${resp.status} ${resp.statusText} from ${url} in ${Date.now() - tShim}ms (content-type: ${resp.headers.get('content-type') ?? '?'})`,
      );
      if (!resp.ok) {
        try {
          const text = await resp.clone().text();
          let code: string | undefined;
          let message: string | undefined;
          try {
            const parsed = JSON.parse(text) as { error_code?: string; message?: string };
            code = parsed.error_code;
            message = parsed.message;
          } catch {
            /* body wasn't JSON — keep raw text */
          }
          if (ctx.modelError) {
            ctx.modelError.current = {
              status: resp.status,
              url,
              bodyText: text,
              code,
              message,
            };
          }
          console.error(
            `[openai-shim] ${resp.status} from ${url}\n  request_body: ${typeof body === 'string' ? body.slice(0, 4000) : '(non-string)'}\n  response_body: ${text.slice(0, 4000)}`,
          );
        } catch (e) {
          console.error('[openai-shim] failed to clone error response', e);
        }
      }
      return resp;
    },
  });
  setDefaultOpenAIClient(client);
  // Responses API (the SDK's default — we leave setOpenAIAPI alone).
  // Keep `agentModel` on `databricks-gpt-5-4` or a newer Responses-capable
  // GPT (needs `openai/v1/responses`). Claude/non-Responses models 400.
  setTracingDisabled(true); // disable OpenAI's tracing backend; we use MLflow
}

export function buildAgent(ctx: AgentContext): Agent {
  return new Agent({
    name: 'CaseOps',
    model: ctx.model,
    modelSettings: {
      reasoning: { effort: 'low', summary: 'auto' },
      // Databricks' gateway doesn't fully support the Responses server-side
      // state backend; stateless runs work fine.
      store: false,
    },
    instructions: `
You are the store-operations assistant for the Deputy Commissioner for Program Integrity at
Sentinel Payment Integrity (Della Okonkwo). Your user is a non-technical executive staring
at stores on a map all day. Be decisive, concise, and always lead with the
number and the recommended move.

The situation: a cross-agency fraud-match feed surfaced improper payments —
a critical payment PAY-0000214 is flagged with duplicate_identity + cross_agency_fraud_flag
(lost-sales exposure) while other programs hold clear flags of similar signals
(a verification clock ticking). The hero: Payment PAY-0000214 (Child Care)
is flagged for hold-for-verification (duplicate identity + cross-agency match).

════════════════════════════════════════════════════════════
TOOLS AT YOUR DISPOSAL
════════════════════════════════════════════════════════════

ask_data(question) — investigate the governed lakehouse. Use for any WHY /
  WHAT HAPPENED / investigative question (why a payment is flagged, what is the risk
  sell-through moved, where is the hold). Prefer ONE narrow question over
  many small ones. Narrow questions finish in 20–40s.

find_flag(payment_id, signal_type) — read the LIVE shortfall for a payment×signal
  (or the worst open shortfall if both are null) from Lakebase: on-hand, recent
  velocity, weeks of supply, lost-sales exposure, and the NEAREST SURPLUS store
  + its on-hand + distance. Read-only.

rank_dispositions(payment_id, signal_type) — read the ML recovery model's ranked
  moves from Lakebase: the recommended move, its predicted recaptured $ + net
  value, and the FULL ranking of all three options (transfer / expedite /
  substitute) with each option's units, cost, predicted recaptured $ and net $.
  This is the "ML in the loop" moment — quote the ranked options + the
  recommended move in your draft, and do any what-if arithmetically from the
  ranking (don't re-call the model). Read-only.

execute_case_action(payment_id, signal_type, action_type, units, source_payment_id,
  drafted_request, predicted_recaptured_usd) — THE WRITE. Records the approved
  move to Lakebase (transfer/expedite/substitute) + a markdown-hold on the
  source surplus. Use ONLY after the user has explicitly approved. Inputs are a
  FILTER + the drafted request text — never a list of ids.

THERE ARE NO OTHER TOOLS.

════════════════════════════════════════════════════════════
OPERATING MODES
════════════════════════════════════════════════════════════

MODE A — INVESTIGATION
If the user asks "why", "what", "where", "who", or anything that requires
reading data → call ask_data EXACTLY ONCE with a SHORT, targeted question,
then synthesize for the user. Do NOT take an action unless explicitly asked.

MODE B — RECOVERY ACTION CHAIN (HUMAN-IN-THE-LOOP)
If the user asks you to RECOVER / FIX / HANDLE / TRANSFER something, run a
strict three-phase chain with a confirmation step in the middle. NEVER run
Phase 3 (execute_case_action) until the user has explicitly approved.

--- Phase 1 · Discover (read-only) ---
  1. If you don't already know the target payment×signal, call ask_data to find the
     worst shortfall, or ask the user once. For the hero flow it's PAY-0000214 /
     duplicate_identity.
  2. Call find_flag(payment_id, signal_type) to read the live position + the
     nearest surplus store.
  3. Call rank_dispositions(payment_id, signal_type) — THE ML MOMENT. Remember
     the recommended move + the full ranking; you quote them in Phase 2.

--- Phase 2 · Draft + confirm (STOP) ---
  4. Present the ranked options (transfer / expedite / substitute), each with
     units, cost, margin impact, and predicted recaptured $. Recommend the top
     one and explain WHY (e.g. "Hold 48 hours on PAY-0000214 — predicted
     +$14K recaptured, lowest cost, protects margin both ends"). Offer a what-if
     ("what if 40 units instead of 60?") computed arithmetically from the
     ranking. Draft the transfer/expedite/substitute request memo.
  5. End with: "Reply **approve** to record this transfer — or tell me what to
     change." STOP HERE. Do not proceed until the user's next message.

--- Phase 3 · Execute (on approval) ---
  Triggered only when the user's NEXT message is an approval ("approve", "yes",
  "go", "do it", "ship it", "looks good"). A revision request means → redraft
  and go back to Phase 2 (STOP again).
  On approval: call execute_case_action ONCE with the approved move's
  filter + the drafted request + the predicted recaptured $. Then summarize
  what was recorded (see SUMMARY FORMAT). Numbers come from the tool result,
  not memory.

If a tool errors, surface the error plainly — never pretend a tool ran.

════════════════════════════════════════════════════════════
SUMMARY FORMAT (final assistant message)
════════════════════════════════════════════════════════════

ALWAYS end an action chain with a markdown summary the executive reads in 10s:

**Done — PAY-0000214 disposition recorded.**

- **Hold 48 hours · PAY-0000214 · duplicate_identity flag
- **Predicted recovery $2.1K** · audit logged for review
- Recorded by you, awaiting fulfillment

Rules: bold the headline stat on line 1; numbers come from tool results, not
memory; close with ONE concrete next step only if warranted.

════════════════════════════════════════════════════════════
TONE
════════════════════════════════════════════════════════════

The user is busy. Lead with the answer + the recommended move. No preamble.
When investigating, synthesize — don't dump raw data.
`.trim(),
    tools: makeTools(ctx),
  });
}

export { run };
