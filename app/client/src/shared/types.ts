/**
 * Types that cross the client/server boundary. Keep in sync with
 * server/db/queries/cases.ts + server/db/queries/chat.ts.
 *
 * Sentinel Payment Integrity domain: the primary entity is a flagged PAYMENT
 * (a pre-disbursement payment carrying one or more fraud/eligibility signals).
 * The Operations page shows the pre-disbursement QUEUE of flagged payments +
 * a risk breakdown; the drawer shows the ranked disposition options (from the
 * ML model / heuristic) + an activity timeline built from the writable
 * `case_actions` rows.
 *
 * The app is small enough that hand-copying these is simpler than a shared
 * package. When you swap the data model:
 *   1. Replace the entity types below.
 *   2. Update the matching queries in `server/db/queries/cases.ts`.
 *   3. Update the fetch helpers in `client/src/lib/cases.ts`.
 *   4. Status enums drive badges in `shared/badges.tsx` — keep aligned.
 */

/** A flagged payment's current review status (from `case_actions`, else 'flagged'). */
export type FlagStatus = 'flagged' | 'held' | 'released' | 'referred';

/** Risk tier of a flagged payment (from `gold_open_queue.risk_level`). */
export type RiskLevel = 'high' | 'moderate';

/** The disposition the model/heuristic recommends (or that was executed). */
export type Disposition =
  | 'release'
  | 'hold_for_verification'
  | 'refer_to_investigation';

/** Lifecycle of a writable `case_actions` row. */
export type ActionStatus = 'proposed' | 'approved' | 'executed' | 'overridden';

/**
 * One flagged payment, as rendered in the Operations queue.
 * Read-only mirror of `gold_queue_scored`, LEFT JOIN-ed to its latest
 * `case_actions` row (so `liveDisposition`/`actionStatus` reflect the writable
 * table without mutating the synced position).
 */
export type PaymentRow = {
  /** The payment id — the queue's row key (e.g. `PAY-0000214`). */
  paymentId: string;
  program: string | null;
  state: string | null;
  paymentAmountUsd: number | null;
  /** ISO date the payment entered the pre-disbursement queue. */
  queueDate: string | null;
  /** How many fraud/eligibility signals flag this payment. */
  nSignals: number | null;
  /** Comma-joined signal names (duplicate_identity, cross_agency_fraud_flag, …). */
  signals: string | null;
  riskLevel: RiskLevel;
  improperPaymentExposureUsd: number | null;
  projectedRecoveryIfInvestigatedUsd: number | null;
  /** The recommended disposition (null until scored / recommendations exist). */
  recommendedDisposition: Disposition | null;
  confidenceScore: number | null;
  /** Live state from the payment's latest `case_actions` row.
   *  Non-null once the Act layer has recorded a disposition for this payment. */
  liveDisposition: Disposition | null;
  actionStatus: ActionStatus | null;
};

/** One option in the model's ranked disposition list
 *  (JSONB on `disposition_recommendations.action_ranking`). Each option carries
 *  projected recovery $ + cost + net value, so the drawer + agent can render the
 *  ranked list and do the arithmetic what-if (recover vs. citizen-delay cost). */
export type DispositionOption = {
  disposition: Disposition;
  holdHours: number;
  costUsd: number;
  predictedRecoveryUsd: number;
  predictedNetValueUsd: number;
};

export type DispositionRecommendation = {
  paymentId: string;
  recommendedDisposition: Disposition | null;
  recommendedHoldHours: number | null;
  predictedRecoveryUsd: number | null;
  predictedCostUsd: number | null;
  actionRanking: DispositionOption[];
};

/** The open-flag context for a payment (from `gold_open_queue`). */
export type OpenFlag = {
  paymentId: string;
  nSignals: number | null;
  signalList: string | null;
  riskLevel: RiskLevel | null;
  improperPaymentExposureUsd: number | null;
};

export type AuditEntry = {
  at: string;
  by: string;
  action: 'proposed' | 'approved' | 'executed' | 'overridden' | 'note';
  notes?: string;
  tool?: string;
};

/** A recorded disposition from the writable `case_actions` table. */
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

/** Full detail for the drawer: the payment + its open-flag context + the
 *  model's ranked disposition options + the recorded case-action rows (timeline). */
export type PaymentDetail = {
  payment: PaymentRow;
  flag: OpenFlag | null;
  recommendation: DispositionRecommendation | null;
  actions: CaseAction[];
};

/** KPI rollup for the Operations page header. */
export type QueueSummary = {
  improperPaymentExposureUsd: number;
  projectedRecoveryUsd: number;
  flaggedCount: number;
  referRecommendedCount: number;
};

/** Per-program aggregation for the risk breakdown chart. One row per program
 *  with its flagged count + exposure. */
export type ProgramBucket = {
  program: string;
  flaggedCount: number;
  improperPaymentExposureUsd: number;
  /** Worst risk level across this program's flagged payments — colors the bar. */
  riskLevel: RiskLevel;
};

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
