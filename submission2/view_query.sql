-- Live Pre-Disbursement Queue: Ranked by Improper-Payment Exposure
-- Trigger: cross_agency_fraud_match_feed (automated scoring on feed refresh)
-- Joins cases with SLA deadlines and any recorded examiner actions for closed-loop display

SELECT
    c.case_id,
    c.payment_id,
    c.program,
    c.risk_level,
    c.n_signals,
    c.signal_list,
    c.payment_amount_usd,
    c.improper_payment_exposure_usd,
    c.projected_recovery_usd,
    c.recommended_disposition,
    c.confidence_score,
    s.deadline_at                          AS sla_deadline,
    CASE WHEN s.deadline_at < NOW()
         THEN true ELSE false END         AS sla_breached,
    ea.approval_status                    AS action_status,
    ea.proposed_action
FROM sentinel.cases c
LEFT JOIN sentinel.sla_tracking s
    ON s.case_id = c.case_id AND s.resolved_at IS NULL
LEFT JOIN sentinel.examiner_actions ea
    ON ea.case_id = c.case_id
    AND ea.approval_status IN ('approved', 'pending')
WHERE c.status = 'pending_review'
ORDER BY c.improper_payment_exposure_usd DESC
LIMIT 15;
