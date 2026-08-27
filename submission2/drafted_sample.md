# Pre-Disbursement Verification Hold

**Payment:** PAY-0000214 | **Program:** Child Care | **Amount:** $1,850.00
**Beneficiary:** BEN-0000173 | **Hold Duration:** 48 hours
**Case:** CASE-00000041 | **Action ID:** act-hero-001

---

## Signals Identified

| # | Signal | Source | Confidence |
|---|--------|--------|-----------|
| 1 | Cross-agency fraud flag | HHS-OIG match feed (2026-08-10) | 97% |
| 2 | Duplicate identity | Multi-program enrollment conflict | 95% |

## Risk Assessment

- **Risk Level:** High
- **Improper Payment Exposure:** $1,480.00
- **Predicted Recovery (48h hold):** $962.00
- **Net Value of Hold vs. Release:** +$917.00
- **Model Version:** heuristic_v1 | **Scored:** 2026-08-27T18:08:19Z

## Disposition Decision

**Action:** Hold disbursement for 48 hours pending identity verification.

**Verification Requirements:**
1. Beneficiary to provide government-issued photo identification
2. Proof of current program eligibility (award letter or benefit statement)
3. Cross-reference against HHS-OIG identity match (SSN validation)

**Escalation Path:** If documents are not provided within 48 hours, or if
validation fails, escalate to OIG Investigation Unit (refer_to_investigation).

## Decision Chain

| Step | Actor | Timestamp | Record |
|------|-------|-----------|--------|
| Trigger | system (fraud_match_feed) | 2026-08-27T18:08:19Z | CASE-00000041 |
| View opened | della.okonkwo | 2026-08-27T19:15:00Z | workflow_state |
| Explanation | assistant (find_flag) | 2026-08-27T19:16:30Z | assist_log |
| What-if | assistant (rank_dispositions) | 2026-08-27T19:18:00Z | assist_log |
| Proposed | system | 2026-08-27T19:19:00Z | examiner_actions |
| **Approved** | della.okonkwo@sentinel.gov | 2026-08-27T19:20:00Z | examiner_actions |
| Committed | system | 2026-08-27T19:20:05Z | examiner_actions |

## Approval

**Approved by:** Della Okonkwo, Deputy Commissioner for Program Integrity
**Rationale:** Dual signals justify 48h verification window. Protects program
integrity while minimizing beneficiary impact.
**Approved at:** 2026-08-27T19:20:00Z | **Committed at:** 2026-08-27T19:20:05Z
