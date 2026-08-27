import {
  text,
  timestamp,
  uuid,
  integer,
  doublePrecision,
  jsonb,
  pgSchema,
  index,
  uniqueIndex,
  boolean,
} from 'drizzle-orm/pg-core';

/**
 * Lakebase schema, under `app.*` — Sentinel Payment Integrity.
 *
 * Three groups (this is the Build-1 answer key: synced READ-ONLY mirrors +
 * ONE writable operational table):
 *   1. Chat state      (conversations, messages, feedback) — REUSE AS-IS.
 *                      Every use case has chat. The `thinking` + `error`
 *                      jsonb/text columns on `messages` make conversations
 *                      reload-safe with full reasoning trails preserved.
 *   2. Synced mirror   (payment_position, open_queue,
 *                      disposition_recommendations) — READ-ONLY copies of the
 *                      Gold Delta tables that `db/sync.ts` pulls at boot.
 *                      In production these are Lakebase Synced Tables (the
 *                      manual sync is the demo stand-in). The app SELECTs
 *                      from them for sub-ms per-payment reads; never writes.
 *   3. Write-surface   `case_actions` — the ONLY table the app writes.
 *                      UC synced table is read-only in Postgres, so the
 *                      Act layer records approved dispositions here.
 *                      Append-only `audit_trail` JSONB makes each action
 *                      row a standalone timeline the drawer Activity tab
 *                      renders from one read.
 *
 * Why Lakebase: transactional Postgres semantics sitting next to the
 * lakehouse, with Unity Catalog governance. Lets the app do real
 * transactional writes while the analytics layer still queries Delta.
 */
export const appSchema = pgSchema('app');

// ============================================================================
// Chat state
// ============================================================================

export const conversations = appSchema.table(
  'conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userEmail: text('user_email').notNull(),
    title: text('title').notNull(),
    // 'default' for regular chats, 'demo_dock' for the floating dock's
    // persistent conversation (one per user).
    kind: text('kind', { enum: ['default', 'demo_dock'] })
      .notNull()
      .default('default'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('conversations_user_idx').on(t.userEmail, t.updatedAt),
    index('conversations_kind_idx').on(t.userEmail, t.kind),
  ],
);

export const messages = appSchema.table(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['user', 'assistant', 'system'] }).notNull(),
    content: text('content').notNull(),
    position: integer('position').notNull(),
    traceId: text('trace_id'),
    // Captured reasoning steps (tool calls, outputs, intermediate messages)
    // for assistant messages. Shape matches client's ThinkingEvent union.
    thinking: jsonb('thinking').$type<ThinkingEntry[]>().notNull().default([]),
    // If the agent run failed, the error message is persisted here so a
    // page reload still shows what went wrong (instead of an empty bubble).
    error: text('error'),
    // True when the turn was stopped by the user (Stop button or page
    // navigation away from an in-flight stream). The assistant's partial
    // streamed content is still kept in `content` for context; the UI
    // renders a "Canceled by the user" banner below it.
    canceled: boolean('canceled').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Unique on (conversation_id, position) so the `SELECT MAX + 1` race in
    // appendMessage surfaces as a constraint error (caller retries) instead
    // of silently inserting two messages at the same position — which
    // would break the on-reload ordering. Doubles as the lookup index.
    uniqueIndex('messages_convo_pos_uq').on(t.conversationId, t.position),
  ],
);

export const feedback = appSchema.table(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    userEmail: text('user_email').notNull(),
    value: text('value', { enum: ['up', 'down'] }).notNull(),
    rationale: text('rationale'),
    traceId: text('trace_id'),
    mlflowAssessmentId: text('mlflow_assessment_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('feedback_message_idx').on(t.messageId)],
);

// ============================================================================
// Synced read-only mirror (from Delta — Sentinel Gold tables)
//
// These mirror `gold_queue_scored`, `gold_open_queue`, and
// `gold_disposition_recommendations`. In Build-1 terms they're UC synced
// tables — read-only from the app. `db/sync.ts` pulls them at boot; the
// app SELECTs from them and never writes them.
// ============================================================================

// `gold_queue_scored` — one row per payment. The queue reads this (filtered
// to flagged payments / open queue). PK is the composite (payment_id, signal_type);
// we mirror it as a synthetic `id` `${payment}:${signal}` for the drizzle PK +
// the queue's row key.
export const paymentPosition = appSchema.table(
  'payment_position',
  {
    // Synthetic `${paymentId}:${signalType}`.
    id: text('id').primaryKey(),
    paymentId: text('payment_id').notNull(),
    paymentAmount: doublePrecision('payment_amount'),
    signalType: text('signal_type').notNull(),
    signalName: text('signal_name'),
    category: text('category'),
    riskLevel: text('risk_level'),
    improperPaymentExposureUsd: doublePrecision('improper_payment_exposure_usd'),
    flagRiskScore: doublePrecision('flag_risk_score'),
    flagFrequency: integer('flag_frequency'),
    recommendedDisposition: text('recommended_disposition'),
    holdDurationHours: integer('hold_duration_hours'),
    flagStatus: text('flag_status', {
      enum: ['flagged', 'verified', 'cleared', 'escalated'],
    })
      .notNull()
      .default('flagged'),
  },
  (t) => [
    index('position_payment_idx').on(t.paymentId),
    index('position_status_idx').on(t.flagStatus),
    index('position_signal_idx').on(t.signalType),
  ],
);

// `gold_open_queue` — the flagged payment + its risk metrics. PK is
// the composite (payment_id, signal_type); mirrored as synthetic `id`.
export const openQueue = appSchema.table(
  'open_queue',
  {
    id: text('id').primaryKey(), // `${paymentId}:${signalType}`
    paymentId: text('payment_id').notNull(),
    signalType: text('signal_type').notNull(),
    improperPaymentExposureUsd: doublePrecision('improper_payment_exposure_usd'),
    riskLevel: text('risk_level'),
    signalList: text('signal_list'),
    flagFrequency: integer('flag_frequency'),
    holdDurationHours: integer('hold_duration_hours'),
  },
  (t) => [index('queue_payment_idx').on(t.paymentId)],
);

// Read-only mirror of the ML model's batch predictions table
// (`{catalog}.{schema}.gold_disposition_recommendations`, written by the ML
// notebook). The app never calls the model directly — the agent's
// `rank_dispositions` tool reads from this table. `actionRanking` (JSONB)
// holds all three disposition options with predicted recovery $ + cost,
// powering the ranked-options list + the arithmetic what-if.
//
// NOTE: the trainee BUILDS this table (it's the ML step of the workshop),
// so sync.ts tolerates it not existing yet — the mirror is simply empty
// until they produce it.
export const dispositionRecommendations = appSchema.table(
  'disposition_recommendations',
  {
    id: text('id').primaryKey(), // `${paymentId}:${signalType}`
    paymentId: text('payment_id').notNull(),
    signalType: text('signal_type').notNull(),
    recommendedDisposition: text('recommended_disposition', {
      enum: ['release', 'hold_for_verification', 'refer_to_investigation'],
    }),
    recommendedHoldHours: integer('recommended_hold_hours'),
    predictedRecoveryUsd: doublePrecision('predicted_recovery_usd'),
    predictedCostUsd: doublePrecision('predicted_cost_usd'),
    // All disposition options with predicted recovery $ + cost.
    actionRanking: jsonb('action_ranking').$type<ActionOption[]>().notNull().default([]),
    scoredAt: timestamp('scored_at', { withTimezone: true }),
  },
  (t) => [index('disposition_payment_idx').on(t.paymentId)],
);

// ============================================================================
// Writable operational table (the app writes here — Build-1 writable table)
//
// `case_actions` is the ONLY table the app writes. An approved disposition
// inserts a row here (action_type + hold_duration + drafted memo + who
// approved). The queue derives a payment's live state by LEFT JOIN-ing
// `payment_position` → its latest `case_actions` row (so "case in progress"
// + the disposition badge come from the writable table, and the read-only
// synced position is never mutated). The append-only `audit_trail` makes
// each row a standalone timeline for the drawer.
// ============================================================================

export const caseActions = appSchema.table(
  'case_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    paymentId: text('payment_id').notNull(),
    signalType: text('signal_type').notNull(),
    actionType: text('action_type', {
      enum: ['release', 'hold_for_verification', 'refer_to_investigation'],
    }).notNull(),
    holdDurationHours: integer('hold_duration_hours'),
    // The disposition memo the agent drafted.
    draftedRequest: text('drafted_request'),
    predictedRecoveryUsd: doublePrecision('predicted_recovery_usd'),
    status: text('status', {
      enum: ['proposed', 'approved', 'executed', 'overridden'],
    })
      .notNull()
      .default('approved'),
    // OBO-stamped viewing user's email.
    approvedBy: text('approved_by'),
    reviewedByRole: text('reviewed_by_role'),
    // Append-only audit trail. Each entry: { at, by, action, notes?, tool? }
    auditTrail: jsonb('audit_trail').$type<AuditEntry[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => [
    index('case_actions_payment_idx').on(t.paymentId, t.signalType),
    index('case_actions_created_idx').on(t.createdAt),
  ],
);

// ============================================================================
// JSONB entry shapes
// ============================================================================

/** One option in the ML model's ranked disposition list (on
 *  `disposition_recommendations.action_ranking`). */
export type ActionOption = {
  disposition: 'release' | 'hold_for_verification' | 'refer_to_investigation';
  holdHours: number;
  costUsd: number;
  predictedRecoveryUsd: number;
  predictedNetValueUsd: number;
};

export type AuditEntry = {
  at: string;
  by: string;
  action:
    | 'proposed'
    | 'approved'
    | 'executed'
    | 'overridden'
    | 'note';
  notes?: string;
  tool?: string;
};

export type ThinkingEntry =
  | { kind: 'tool_call'; callId: string; name: string; args: string }
  | { kind: 'tool_output'; callId: string; output: string }
  | { kind: 'intermediate_message'; text: string };
