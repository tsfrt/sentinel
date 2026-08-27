# Sentinel Lakebase Data Model

## Connection Details

| Property | Value |
| --- | --- |
| Project | `sentinel-payments` |
| Branch | `production` |
| Endpoint | `primary` |
| Host | `ep-jolly-scene-d29ar1xd.database.us-east-1.cloud.databricks.com` |
| Database | `databricks_postgres` |
| Schema | `sentinel` |
| Postgres Version | 17 |
| Compute | Autoscaling (1 CU, scale-to-zero enabled) |

---

## Overview

The Lakebase `sentinel` schema implements the operational transaction layer for the Sentinel Payment Integrity workflow. It stores:

1. **Current case state** — the mutable, examiner-facing view of each flagged payment case.
2. **Immutable audit log** — every state transition, decision, and action as append-only events.
3. **AI recommendation mirror** — the heuristic/model output synced from the lakehouse for sub-ms app reads.

Data flows **lakehouse → Lakebase** (one-shot sync on app boot; production would use Synced Tables for continuous replication). Examiner actions flow **Lakebase → lakehouse** via CDC for long-term analytics and compliance archival.

---

## Entity-Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        sentinel.cases                                │
│  (one row per flagged payment — mutable current state)              │
├─────────────────────────────────────────────────────────────────────┤
│  PK  case_id                                                        │
│  UQ  payment_id ──────────────────┐                                 │
│      beneficiary_id               │                                 │
│      program                      │                                 │
│      risk_level                   │                                 │
│      n_signals                    │                                 │
│      signal_list[]                │                                 │
│      payment_amount_usd           │                                 │
│      improper_payment_exposure    │                                 │
│      projected_recovery_usd       │                                 │
│      recommended_disposition      │                                 │
│      confidence_score             │                                 │
│      reasoning                    │                                 │
│      status                       │                                 │
│      disposition                  │                                 │
│      rationale                    │                                 │
│      override_reason              │                                 │
│      assigned_to                  │                                 │
│      version (optimistic lock)    │                                 │
│      created_at / updated_at      │                                 │
│      decided_at / confirmed_at    │                                 │
└───────────────┬───────────────────┴─────────────────────────────────┘
                │ 1
                │
                │ N
┌───────────────┴─────────────────────────────────────────────────────┐
│                     sentinel.case_events                             │
│  (append-only audit log — one row per state transition)             │
├─────────────────────────────────────────────────────────────────────┤
│  PK  event_id (UUID)                                                │
│  FK  case_id → cases.case_id                                        │
│      event_type                                                     │
│      actor_id                                                       │
│      actor_type                                                     │
│      before_state                                                   │
│      after_state                                                    │
│      payload (JSONB)                                                │
│      created_at                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│              sentinel.disposition_recommendations                    │
│  (AI recommendation mirror — one row per flagged payment)           │
├─────────────────────────────────────────────────────────────────────┤
│  PK  payment_id                                                     │
│      recommended_disposition                                        │
│      predicted_improper_probability                                 │
│      predicted_recovery_usd                                         │
│      predicted_net_value_usd                                        │
│      confidence_score                                               │
│      disposition_ranking (JSONB)                                    │
│      reasoning                                                      │
│      model_version                                                  │
│      scored_at                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Table Specifications

### `sentinel.cases`

The primary operational table. One row per flagged payment entering the examiner workflow. Mutable — updated as examiners claim, decide, and confirm dispositions.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `case_id` | TEXT | **PK** | Unique case identifier (`CASE-NNNNNNNN`). |
| `payment_id` | TEXT | NOT NULL, **UNIQUE** | The flagged payment this case tracks. Foreign key to lakehouse `gold_open_queue`. |
| `beneficiary_id` | TEXT | NOT NULL | Beneficiary receiving the payment. Reference only — no PII stored. |
| `program` | TEXT | NOT NULL | Benefit program: TANF, SNAP, Child Care, Disability, Veteran's. |
| `risk_level` | TEXT | NOT NULL, CHECK | `high`, `moderate`, or `low`. Derived from signal count and strength. |
| `n_signals` | INTEGER | NOT NULL, DEFAULT 0 | Count of fraud signals attached to this payment. |
| `signal_list` | TEXT[] | — | Array of signal names (e.g., `{duplicate_identity, cross_agency_fraud_flag}`). |
| `payment_amount_usd` | NUMERIC(12,2) | NOT NULL | Pre-disbursement payment amount. |
| `improper_payment_exposure_usd` | NUMERIC(12,2) | — | Projected $ loss if released and improper. |
| `projected_recovery_usd` | NUMERIC(12,2) | — | Projected $ recovery if investigated. |
| `recommended_disposition` | TEXT | CHECK | AI's top recommendation: `release`, `hold_for_verification`, `refer_to_investigation`. |
| `confidence_score` | NUMERIC(4,3) | — | AI confidence in the recommendation (0.000–1.000). |
| `reasoning` | TEXT | — | AI-generated reasoning memo for the recommendation. |
| `status` | TEXT | NOT NULL, CHECK | Current workflow state (see State Machine below). |
| `disposition` | TEXT | CHECK | Examiner's chosen disposition (NULL until decided). |
| `rationale` | TEXT | — | Examiner's written rationale for the decision. |
| `override_reason` | TEXT | — | Override category if examiner disagreed with AI. |
| `assigned_to` | TEXT | — | Examiner identity currently assigned (NULL if unassigned). |
| `version` | INTEGER | NOT NULL, DEFAULT 1 | Optimistic concurrency version counter. Incremented on every state change. |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | When the case was created. |
| `updated_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Last state change timestamp. |
| `decided_at` | TIMESTAMPTZ | — | When the examiner entered a decision. |
| `confirmed_at` | TIMESTAMPTZ | — | When the examiner confirmed the disposition. |

**Status enum values:**

| Status | Terminal? | Description |
| --- | --- | --- |
| `pending_review` | No | Awaiting examiner assignment/claim. |
| `in_review` | No | Assigned to an examiner; under active review. |
| `decision_entered` | No | Examiner selected a disposition; awaiting confirmation. |
| `disposition_confirmed` | No | Examiner confirmed; awaiting downstream handoff. |
| `released` | Yes | Payment released to disburse. |
| `held_pending_verification` | No | Held; verification request sent to another agency. |
| `referred_to_investigation` | Yes | Forwarded to investigation unit. |
| `escalated` | No | SLA breach or manual escalation to supervisor. |
| `handoff_pending` | No | Disposition confirmed but downstream ack not yet received. |
| `handoff_acknowledged` | Yes | Downstream system acknowledged receipt. |

---

### `sentinel.case_events`

Append-only audit log. Every state transition, assignment, decision, override, and handoff produces exactly one event. Events are never updated or deleted.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `event_id` | TEXT | **PK**, DEFAULT gen_random_uuid() | Globally unique event identifier. |
| `case_id` | TEXT | NOT NULL, **FK → cases** | The case this event belongs to. |
| `event_type` | TEXT | NOT NULL, CHECK | Enumerated event type (see below). |
| `actor_id` | TEXT | NOT NULL | Identity of the actor who triggered this event. |
| `actor_type` | TEXT | NOT NULL, CHECK | `examiner`, `supervisor`, or `system`. |
| `before_state` | TEXT | — | Case status before this event (NULL for creation). |
| `after_state` | TEXT | — | Case status after this event. |
| `payload` | JSONB | DEFAULT '{}' | Event-specific structured data (see Payload Examples). |
| `created_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | Immutable event timestamp (UTC). |

**Event type enum:**

| event_type | Trigger | Typical payload keys |
| --- | --- | --- |
| `case_created` | Flagged payment enters workflow | `payment_id`, `risk_level`, `n_signals` |
| `assigned` | Examiner claims or is assigned a case | `assigned_to`, `assignment_method` (pull/push) |
| `unassigned` | Session timeout or examiner release | `reason`, `idle_seconds` |
| `review_started` | Examiner opens case detail | — |
| `decision_entered` | Examiner selects a disposition | `disposition`, `rationale`, `is_override` |
| `disposition_confirmed` | Examiner confirms the decision | `disposition`, `rationale`, `confidence_score` |
| `override_flagged` | Decision differs from AI recommendation | `ai_recommendation`, `examiner_choice`, `override_reason` |
| `escalated` | SLA breach or manual escalation | `reason`, `escalated_to` |
| `de_escalated` | Supervisor resolves escalation | `resolved_by`, `resolution_note` |
| `handoff_sent` | Disposition sent to downstream system | `target_system`, `handoff_type` |
| `handoff_acknowledged` | Downstream system confirms receipt | `ack_id`, `system_id`, `status` |
| `handoff_rejected` | Downstream system rejects handoff | `rejection_reason`, `system_id` |
| `verification_received` | Verification response arrives | `verification_result`, `source_agency` |
| `re_review_triggered` | New evidence triggers re-review | `trigger_reason`, `new_signals` |
| `sla_breach` | Case exceeds SLA threshold | `sla_type`, `elapsed_seconds`, `threshold_seconds` |
| `status_changed` | Generic status transition (catch-all) | `from_status`, `to_status` |

---

### `sentinel.disposition_recommendations`

Mirror of the lakehouse `gold_disposition_recommendations` table, synced into Lakebase for sub-millisecond reads by the app's agent tools. One row per flagged payment.

| Column | Type | Constraints | Description |
| --- | --- | --- | --- |
| `payment_id` | TEXT | **PK** | The payment this recommendation applies to. |
| `recommended_disposition` | TEXT | NOT NULL | Top-ranked disposition by net recovery value. |
| `predicted_improper_probability` | NUMERIC(5,4) | — | Model's probability this payment is improper (0–1). |
| `predicted_recovery_usd` | NUMERIC(12,2) | — | Predicted $ recovery if investigated. |
| `predicted_net_value_usd` | NUMERIC(12,2) | — | Recovery minus citizen delay cost. |
| `confidence_score` | NUMERIC(4,3) | — | Model confidence in the recommendation. |
| `disposition_ranking` | JSONB | — | All three candidates with predicted outcomes (for what-if display). |
| `reasoning` | TEXT | — | Natural-language memo explaining the recommendation. |
| `model_version` | TEXT | DEFAULT 'heuristic_v1' | Model name + version for provenance. |
| `scored_at` | TIMESTAMPTZ | NOT NULL, DEFAULT NOW() | When this recommendation was generated. |

---

## Indexes

| Index | Table | Columns | Purpose |
| --- | --- | --- | --- |
| `idx_cases_status` | cases | `status` | Queue filtering by workflow state. |
| `idx_cases_assigned_to` | cases | `assigned_to` (partial: WHERE NOT NULL) | Examiner workload queries. |
| `idx_cases_exposure_desc` | cases | `improper_payment_exposure_usd DESC` | Priority queue ordering (highest-risk first). |
| `idx_case_events_case_id` | case_events | `case_id` | Audit trail lookups per case. |
| `idx_case_events_created_at` | case_events | `created_at DESC` | Reverse-chronological event feeds. |

---

## Concurrency Model

Optimistic locking via the `version` column on `sentinel.cases`:

```sql
-- Example: examiner claims a case
UPDATE sentinel.cases
SET status = 'in_review',
    assigned_to = :examiner_id,
    version = version + 1,
    updated_at = NOW()
WHERE case_id = :case_id
  AND version = :expected_version
  AND status = 'pending_review'
  AND assigned_to IS NULL;
-- If 0 rows affected → conflict (another examiner claimed first)
```

Every successful state transition:
1. Updates `sentinel.cases` (version bump + field changes).
2. Inserts a row into `sentinel.case_events` (immutable audit).
3. Both within a single transaction for atomicity.

---

## Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                          LAKEHOUSE (Delta)                            │
│                                                                      │
│  gold_open_queue ──────────┐                                         │
│  gold_disposition_recs ────┤  (one-shot sync on app boot /           │
│                            │   Synced Tables in production)          │
│                            ▼                                         │
│              ┌─────────────────────────────┐                         │
│              │    LAKEBASE (Postgres)       │                         │
│              │    sentinel.cases            │◄─── Examiner actions    │
│              │    sentinel.case_events      │     (app writes)        │
│              │    sentinel.disposition_recs │                         │
│              └─────────────────────────────┘                         │
│                            │                                         │
│                            │  (CDC / periodic export for archival)   │
│                            ▼                                         │
│              Delta archive tables (7-year retention)                  │
└──────────────────────────────────────────────────────────────────────┘
```

### Sync Strategy

| Direction | Mechanism | Cadence | Purpose |
| --- | --- | --- | --- |
| Lakehouse → Lakebase | One-shot INSERT on app boot (demo) / Synced Tables (production) | On-demand / continuous | Seed cases + recommendations for sub-ms app reads |
| Lakebase → Lakehouse | Lakehouse Sync (CDC) or periodic `pg_dump` export | Continuous / daily | Long-term archival, compliance, analytics on examiner behavior |

---

## Payload Examples

### `case_created`
```json
{
  "payment_id": "PAY-0000214",
  "risk_level": "high",
  "n_signals": 2,
  "signals": ["duplicate_identity", "cross_agency_fraud_flag"],
  "source_table_version": "gold_open_queue@v42"
}
```

### `disposition_confirmed`
```json
{
  "disposition": "hold_for_verification",
  "rationale": "Two strong fraud signals (duplicate identity + cross-agency flag) on $1,850 TANF payment. Hold pending verification from partner agency.",
  "is_override": false,
  "ai_recommendation": "hold_for_verification",
  "confidence_score": 0.95,
  "predicted_recovery_usd": 962.00
}
```

### `override_flagged`
```json
{
  "ai_recommendation": "refer_to_investigation",
  "examiner_choice": "hold_for_verification",
  "override_reason": "beneficiary_hardship",
  "rationale": "Beneficiary has documented medical emergency. Hold for 3 days to verify rather than full investigation, which would delay benefits 14+ days.",
  "confidence_score": 0.92
}
```

### `handoff_acknowledged`
```json
{
  "ack_id": "ACK-2024-08-27-001",
  "system_id": "disbursement-gateway",
  "received_at": "2024-08-27T14:23:01.442Z",
  "status": "accepted"
}
```

---

## App Integration Points

The Databricks App reads and writes this schema via SQL over the Lakebase endpoint:

| App Function | Query Pattern | Table(s) |
| --- | --- | --- |
| Payment Queue (priority list) | `SELECT ... FROM cases WHERE status = 'pending_review' ORDER BY improper_payment_exposure_usd DESC` | cases |
| Case Detail | `SELECT ... FROM cases WHERE case_id = :id` | cases |
| Recommendation Lookup | `SELECT ... FROM disposition_recommendations WHERE payment_id = :id` | disposition_recommendations |
| Claim Case | `UPDATE cases SET status='in_review', assigned_to=:user WHERE case_id=:id AND version=:v` + INSERT event | cases, case_events |
| Submit Disposition | `UPDATE cases SET disposition=:d, rationale=:r, status='disposition_confirmed' WHERE ...` + INSERT event | cases, case_events |
| Audit Trail | `SELECT ... FROM case_events WHERE case_id = :id ORDER BY created_at` | case_events |
| KPI Metrics | `SELECT status, COUNT(*), SUM(improper_payment_exposure_usd) FROM cases GROUP BY status` | cases |

---

## Seeded Data Summary

| Metric | Value |
| --- | --- |
| Total cases | 182 |
| High-risk | ~40 |
| Moderate-risk | ~76 |
| Low-risk (single weak signal) | ~66 |
| Hero case (PAY-0000214) | CASE-00000041, high-risk, 2 signals, hold_for_verification @ 0.95 |
| Disposition split | 42% hold / 36% release / 22% investigate |
| Audit events seeded | 182 (one `case_created` per case) |
| All cases initial status | `pending_review` |
