# Sentinel Transaction-Layer Requirements

## 1. Purpose and Business Outcomes

### Purpose

Define the operational transaction layer that governs how flagged pre-disbursement payments move from detection through examiner review to final disposition. This layer bridges the analytics lakehouse (governed source data, fraud signals, AI recommendations) and the operational workflow (Lakebase) where examiner decisions are recorded, enforced, and audited.

### Business Outcomes

* **Prevent improper payments before disbursement** — stop flagged payments from releasing without examiner review when fraud signals warrant a hold or investigation.
* **Accelerate examiner throughput** — prioritized queue + AI-ranked dispositions reduce time-per-case from ~45 min to ~12 min (target).
* **Maintain citizen trust** — legitimate payments are released promptly; holds are bounded by SLA; every decision carries rationale visible to oversight.
* **Full auditability** — every state transition, recommendation, override, and decision is immutably logged with actor, timestamp, and provenance.

### Actors

| Actor | Role |
| --- | --- |
| **Examiner** | Reviews flagged cases, accepts or overrides AI recommendations, records disposition decision with rationale. |
| **Senior Examiner / Supervisor** | Handles escalations, resolves conflicting signals, overrides prior dispositions on re-review. |
| **Deputy Commissioner (Della Okonkwo)** | Monitors aggregate KPIs, triggers policy changes, does not act on individual cases. |
| **System (AI Recommendation Engine)** | Produces ranked disposition recommendations with confidence scores; advisory only — never changes payment status autonomously. |
| **Downstream Disbursement System** | Receives final release/hold/investigate instructions and acknowledges receipt. |

### Terminology

| Term | Definition |
| --- | --- |
| **Payment** | A pre-disbursement benefit amount queued for release to a beneficiary. |
| **Case** | A flagged payment plus its associated fraud signals, AI recommendation, and examiner workflow state. Created when a payment enters the flagged queue. |
| **Disposition** | The examiner's final decision: `release`, `hold_for_verification`, or `refer_to_investigation`. |
| **Recommendation** | The AI-generated ranked disposition with predicted recovery, confidence score, and reasoning memo. Advisory only. |
| **Signal** | A fraud-match or eligibility-anomaly indicator attached to a payment (e.g., `duplicate_identity`, `cross_agency_fraud_flag`). |
| **Override** | An examiner choosing a disposition different from the AI's top recommendation. Requires enhanced rationale. |

### In-Scope

* Case lifecycle from creation through terminal disposition.
* Examiner workflow: assignment, review, decision, confirmation, handoff.
* State machine with allowed transitions, guards, and exception paths.
* Business rules for rationale, evidence, SLA timing, override governance.
* Audit and governance requirements.
* Operational quality attributes (idempotency, consistency, availability).

### Out-of-Scope

* UI/UX design and visual layout.
* Physical SQL schema or DDL.
* API contracts (REST/gRPC endpoint definitions).
* Infrastructure sizing, scaling, or deployment topology.
* Implementation code.

---

## 2. End-to-End Examiner Workflow

### 2.1 Case Creation

* A case is created automatically when a payment enters `gold_open_queue` with `n_signals >= 1`.
* The case inherits: `payment_id`, `beneficiary_id`, `program`, `risk_level`, `signal_list`, `improper_payment_exposure_usd`, and the AI recommendation from `gold_disposition_recommendations`.
* Initial case status: `pending_review`.
* Cases are enqueued in priority order: `improper_payment_exposure_usd DESC`, then `n_signals DESC`.

### 2.2 Assignment

* Cases may be claimed (pull model) or assigned (push model by supervisor).
* A case may only be assigned to one examiner at a time.
* Assignment creates an `assigned` event with actor and timestamp.
* Unassigned cases older than the SLA threshold trigger escalation.

### 2.3 Review

* The examiner sees: payment details, beneficiary context, fraud signals with strength classification, and the AI recommendation (ranked dispositions with predicted recovery, delay cost, and net value).
* The examiner may request additional evidence (e.g., cross-agency verification response) before deciding.
* Review time is tracked; cases exceeding review-SLA trigger supervisor notification.

### 2.4 Recommendation Display

* The AI recommendation is always displayed as advisory context, never as a pre-selected default action.
* All three disposition options are shown with their predicted outcomes (recovery $, delay cost, net value).
* Confidence score and reasoning memo are visible.
* The recommendation's model version, scored_at timestamp, and input features are accessible for provenance.

### 2.5 Decision

* The examiner selects one of three dispositions: `release`, `hold_for_verification`, or `refer_to_investigation`.
* A rationale field is required (minimum 20 characters for overrides; minimum 10 characters otherwise).
* If the examiner's choice differs from the AI's top recommendation, the system flags it as an **override** and requires enhanced rationale.
* The decision is recorded but not yet committed (two-step confirmation).

### 2.6 Confirmation

* After decision entry, the examiner sees a confirmation summary: payment ID, chosen disposition, rationale, and downstream effect (e.g., "Payment will be held for 3 business days pending verification").
* The examiner must explicitly confirm to commit.
* On confirmation: case status transitions to terminal state; an immutable `disposition_confirmed` event is written.

### 2.7 Downstream Handoff

* On `release`: the disbursement system is notified to proceed; case status → `released`.
* On `hold_for_verification`: a verification request is generated (to the relevant agency/system); case status → `held_pending_verification`; a follow-up SLA timer starts.
* On `refer_to_investigation`: the case is forwarded to the investigation unit; case status → `referred_to_investigation`.
* Each handoff requires an acknowledgement from the downstream system within a bounded timeout.
* Unacknowledged handoffs trigger retry + supervisor alert.

### 2.8 Exception Handling

* **Examiner session timeout**: case returns to `pending_review` (unassigned) after configurable idle period.
* **Downstream system unavailable**: disposition is committed locally; handoff retries with exponential backoff; case status includes `handoff_pending` sub-state.
* **Duplicate payment event**: idempotent — if a case already exists for a payment_id, the duplicate is logged and discarded.
* **Examiner conflict**: if two examiners attempt to claim the same case, the first claim wins; the second receives a conflict notification.

---

## 3. Payment and Case Lifecycle

### 3.1 State Machine

```
[queued] → [pending_review] → [in_review] → [decision_entered] → [disposition_confirmed]
                                    ↓                                       ↓
                              [escalated]                          [released | held_pending_verification | referred_to_investigation]
                                    ↓                                       ↓
                              [in_review]                          [handoff_acknowledged] (terminal)
```

### 3.2 Allowed Transitions

| From | To | Trigger | Guard |
| --- | --- | --- | --- |
| `queued` | `pending_review` | Case created from flagged payment | n_signals >= 1 |
| `pending_review` | `in_review` | Examiner claims or is assigned | Case not already assigned |
| `in_review` | `decision_entered` | Examiner selects disposition | Rationale provided |
| `decision_entered` | `disposition_confirmed` | Examiner confirms | Confirmation within session |
| `disposition_confirmed` | `released` | Downstream ack (release) | Handoff successful |
| `disposition_confirmed` | `held_pending_verification` | Downstream ack (hold) | Verification request sent |
| `disposition_confirmed` | `referred_to_investigation` | Downstream ack (refer) | Investigation unit notified |
| `in_review` | `pending_review` | Session timeout or examiner release | Idle > configured threshold |
| `in_review` | `escalated` | SLA breach or examiner request | Review time exceeded or manual escalation |
| `escalated` | `in_review` | Supervisor assigns/claims | Supervisor action |
| `held_pending_verification` | `pending_review` | Verification response requires re-review | New evidence received |

### 3.3 Terminal States

* `released` — payment disbursed; no further action.
* `referred_to_investigation` — case handed to investigation unit; outcome tracked separately.
* `handoff_acknowledged` — downstream system confirmed receipt of any disposition type.

### 3.4 Non-Terminal Holds

* `held_pending_verification` is non-terminal: verification may confirm the payment is legitimate (→ re-review → release) or confirm fraud (→ re-review → refer to investigation).
* Hold duration is SLA-bounded (default: 3 business days). Expiry without resolution triggers supervisor escalation.

### 3.5 Re-Review

* A case may re-enter `pending_review` from `held_pending_verification` when new evidence arrives.
* Re-review creates a new review cycle; prior disposition is preserved in history but superseded.
* The AI recommendation may be re-scored with updated signals before re-review.

### 3.6 Duplicate Events

* If the upstream feed produces a duplicate `payment_id` already in the workflow, the system:
  1. Logs the duplicate event with source metadata.
  2. Does not create a second case.
  3. If the duplicate carries new/updated signals, those are appended to the existing case's signal list and the AI recommendation is re-scored.

### 3.7 Concurrent Examiner Actions

* Optimistic concurrency: each case carries a version counter.
* State transitions require the expected version; a version mismatch returns a conflict error.
* The UI must handle conflict gracefully (refresh + notify examiner of the conflicting action).

---

## 4. Product Rules

### 4.1 Required Rationale

* Every disposition decision requires a written rationale.
* Minimum length: 10 characters (agreement with recommendation) or 20 characters (override).
* Rationale is immutable once confirmed — corrections require a supervisor-initiated re-review.

### 4.2 Evidence Requirements

* High-risk cases (`risk_level = 'high'`) require the examiner to acknowledge viewing the signal detail before disposition entry is enabled.
* Cases with `cross_agency_fraud_flag` require acknowledgement that cross-agency verification was reviewed or requested.

### 4.3 Recommendation Override

* An override occurs when the examiner selects a disposition ranked lower than the AI's top recommendation.
* Overrides require:
  * Enhanced rationale (minimum 20 characters).
  * Selection of an override reason category: `new_information`, `policy_exception`, `signal_context_disagreement`, `beneficiary_hardship`, `other`.
* Override events are flagged for supervisor review within 24 hours.
* Override rate is tracked as a quality metric (target: < 25% of high-confidence recommendations).

### 4.4 Assignment and Queues

* Default queue ordering: `improper_payment_exposure_usd DESC` (highest-risk-dollar cases first).
* Examiners may filter by program, risk level, or signal type.
* Maximum concurrent assignments per examiner: configurable (default: 5).
* Load balancing: if an examiner's queue exceeds capacity, new assignments route to the next available examiner.

### 4.5 Service-Level Timing

| SLA | Target | Escalation |
| --- | --- | --- |
| Time to first review (from case creation) | 4 hours (high-risk), 24 hours (moderate) | Supervisor notification |
| Review duration (from assignment to decision) | 30 minutes (high-risk), 2 hours (moderate) | Supervisor notification |
| Hold duration (verification) | 3 business days | Auto-escalation to supervisor |
| Downstream handoff acknowledgement | 60 seconds | Retry + alert after 3 failures |

### 4.6 Downstream Acknowledgements

* Every disposition handoff requires explicit acknowledgement from the receiving system.
* Acknowledgement carries: `ack_id`, `received_at`, `system_id`, and `status` (accepted/rejected).
* Rejected handoffs trigger immediate supervisor escalation with the rejection reason.

---

## 5. Auditability and Governance

### 5.1 Immutable Event History

* Every state transition, assignment, decision, override, escalation, and handoff is recorded as an append-only event.
* Events are never updated or deleted — corrections are modeled as new compensating events.
* Event retention: minimum 7 years (federal records requirement).

### 5.2 Event Schema (Logical)

Each event captures:

* `event_id` — globally unique identifier.
* `case_id` — the case this event belongs to.
* `event_type` — enumerated (e.g., `case_created`, `assigned`, `decision_entered`, `disposition_confirmed`, `override_flagged`, `escalated`, `handoff_sent`, `handoff_acknowledged`).
* `actor_id` — the examiner, supervisor, or system identity that triggered the event.
* `actor_type` — `examiner`, `supervisor`, `system`.
* `timestamp` — UTC, microsecond precision.
* `before_state` — case state before the event.
* `after_state` — case state after the event.
* `payload` — structured JSON with event-type-specific data (rationale, disposition, override reason, etc.).

### 5.3 AI Recommendation Provenance

* Each recommendation event records:
  * Model name and version (e.g., `lanl.sentinel.disposition_recommender@prod` or `heuristic_v1`).
  * `scored_at` timestamp.
  * Input feature snapshot: `n_signals`, `signal_list`, `payment_amount_usd`, `program`, `risk_level`.
  * Output: `recommended_disposition`, `confidence_score`, `predicted_recovery_usd`, `disposition_ranking` (all three candidates).
  * Reasoning memo text.
* If the recommendation is re-scored (new signals), both the original and updated recommendations are preserved.

### 5.4 Source-Data Lineage

* Each case records the source table versions (Delta version or commit timestamp) of `gold_open_queue` and `gold_disposition_recommendations` at the time the case was created.
* Fraud signals reference their origin: `raw_payment_fraud_flags` row IDs and the upstream feed batch ID.

### 5.5 Access Controls

* Examiners can view and act on cases assigned to them or unassigned in their queue.
* Supervisors can view all cases, reassign, override, and escalate.
* The Deputy Commissioner has read-only access to aggregate metrics and individual case audit trails.
* System actors (AI engine, downstream handoff) operate under service principals with least-privilege grants.
* All access is governed by Unity Catalog permissions; Lakebase row-level access uses the examiner's identity.

---

## 6. Operational and Quality Requirements

### 6.1 Idempotency

* All write operations (case creation, disposition confirmation, handoff) are idempotent.
* Idempotency is enforced via unique event IDs and case version guards.
* Retry-safe: a network failure during confirmation can be retried without creating duplicate decisions.

### 6.2 Consistency

* Case state transitions are atomic — a case is never in an intermediate or inconsistent state.
* The event log and current case state are always consistent (event-sourced pattern).
* Cross-system consistency (lakehouse ↔ Lakebase) is eventually consistent with a propagation SLA of < 5 seconds under normal load.

### 6.3 Availability

* The examiner workflow must be available 99.9% of business hours (Mon–Fri 06:00–22:00 ET).
* Degraded mode: if the AI recommendation service is unavailable, examiners can still review and decide based on signal data alone (recommendation displays "unavailable — decide based on signals").
* If Lakebase is unavailable, the system queues decisions locally and replays on recovery.

### 6.4 Accessibility

* The workflow supports keyboard-only navigation for all critical paths (assignment through confirmation).
* Rationale fields support screen readers.
* Color coding (red/yellow/green risk) is supplemented with text labels and icons for color-blind accessibility.

### 6.5 Observability

* Metrics emitted: cases created/hour, decisions/hour, mean review duration, override rate, SLA breach count, handoff failure rate.
* Logs: structured JSON logs for every state transition with correlation IDs.
* Alerts: SLA breach, handoff failure (3 consecutive), override rate exceeding threshold, queue depth exceeding examiner capacity.

### 6.6 Retention and Archival

* Active cases: retained in Lakebase hot storage until terminal + 90 days.
* Archived cases: moved to Delta lakehouse cold storage after 90 days post-terminal.
* Event log: retained 7 years minimum (immutable, append-only).
* AI recommendation history: retained alongside event log (same 7-year minimum).

### 6.7 Privacy

* Beneficiary PII (name, SSN, address) is not stored in Lakebase workflow tables — referenced by `beneficiary_id` with PII access mediated through Unity Catalog column-level governance.
* Rationale text must not contain raw PII; the UI warns if PII patterns are detected.
* Audit log access requires supervisor-level or compliance-role permissions.

### 6.8 Recovery

* Point-in-time recovery: Lakebase supports restore to any point within the retention window.
* Event replay: the full case state can be reconstructed from the event log at any historical point.
* Disaster recovery RPO: < 1 minute. RTO: < 15 minutes.

---

## 7. Acceptance Criteria

| # | Criterion | Measurement |
| --- | --- | --- |
| AC-1 | A flagged payment creates exactly one case with correct initial state | Automated test: insert payment with n_signals >= 1 → case exists in `pending_review` |
| AC-2 | Examiner can claim, review, decide, and confirm a case end-to-end | Manual + integration test: full workflow completes with all events recorded |
| AC-3 | AI recommendation is displayed but does not pre-select a disposition | UI/workflow test: decision field is empty until examiner acts |
| AC-4 | Override requires enhanced rationale and reason category | Validation test: override without 20-char rationale or category is rejected |
| AC-5 | Concurrent claim conflict is handled gracefully | Concurrency test: two simultaneous claims → one succeeds, one gets conflict response |
| AC-6 | Duplicate payment_id does not create a second case | Idempotency test: re-send same payment_id → event logged, no new case |
| AC-7 | All state transitions produce immutable audit events | Audit test: walk a case through all states → event count and content match expectations |
| AC-8 | SLA breach triggers escalation within 5 minutes of threshold | Timing test: simulate aging case → escalation event + supervisor notification fires |
| AC-9 | Downstream handoff retry succeeds after transient failure | Resilience test: simulate downstream timeout → retry succeeds → `handoff_acknowledged` |
| AC-10 | Case state is reconstructable from event log alone | Recovery test: delete current state → replay events → state matches pre-deletion |

---

## 8. Assumptions and Policy Questions

### Assumptions

* The agency has an existing disbursement system that can accept hold/release/investigate instructions via a defined interface.
* Examiner identity is federated through the agency's SSO and maps to Databricks workspace identity.
* Business-day calculations follow the federal holiday calendar.
* The AI recommendation engine (heuristic or ML) runs on a batch schedule (at least daily); real-time re-scoring is talk-track only.

### Questions Requiring Agency Confirmation

| # | Question | Impact if Unresolved |
| --- | --- | --- |
| Q-1 | What is the maximum hold duration before a payment must be released or formally referred? | SLA timer configuration; beneficiary rights |
| Q-2 | Can a supervisor unilaterally override a confirmed disposition, or is a formal appeal required? | State machine: whether `released` is truly terminal |
| Q-3 | Are there program-specific rules (e.g., SNAP has different hold limits than Disability)? | Per-program SLA configuration |
| Q-4 | What downstream systems acknowledge handoffs, and what is their interface contract? | Handoff retry logic and timeout values |
| Q-5 | Is there a minimum confidence threshold below which the AI recommendation should be suppressed rather than shown? | Recommendation display logic |
| Q-6 | What is the records-retention policy for override rationale containing potential investigative detail? | Retention and privacy configuration |
