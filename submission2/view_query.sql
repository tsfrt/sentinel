-- Live Ranked Pre-Disbursement Queue
-- Backs the "Live Queue" tab in the Sentinel Payment Integrity app.
-- Joins cases (pending_review) with the latest examiner action to show
-- disposition status alongside risk-ranked payment exposure.

SELECT c.case_id,
       c.payment_id,
       c.program,
       c.risk_level,
       c.n_signals,
       c.payment_amount_usd,
       c.improper_payment_exposure_usd,
       c.projected_recovery_usd,
       c.recommended_disposition,
       ea.approval_status  AS action_status,
       ea.proposed_action
FROM   sentinel.cases c
LEFT JOIN sentinel.examiner_actions ea
       ON ea.case_id = c.case_id
      AND ea.approval_status IN ('approved', 'pending')
WHERE  c.status = 'pending_review'
ORDER  BY c.improper_payment_exposure_usd DESC
LIMIT  15;
