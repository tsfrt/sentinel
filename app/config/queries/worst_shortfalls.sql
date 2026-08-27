-- Highest-risk flagged payments by improper-payment exposure. PAY-0000214 should
-- sit near the top. Reads the Gold queue table directly —
-- confirmed columns, resolves on any workspace.
-- @param catalog STRING = ai_demo_gen
-- @param schema STRING = sentinel_benefits
SELECT
  p.payment_id,
  p.program,
  p.risk_level,
  CAST(p.n_signals AS BIGINT) AS n_signals,
  p.signal_list,
  CAST(ROUND(COALESCE(p.improper_payment_exposure_usd, 0.0), 2) AS DOUBLE) AS improper_payment_exposure_usd,
  CAST(ROUND(COALESCE(p.projected_recovery_if_investigated_usd, 0.0), 2) AS DOUBLE) AS projected_recovery_usd
FROM IDENTIFIER(:catalog || '.' || :schema || '.gold_queue_scored') p
WHERE p.risk_level = 'high'
ORDER BY p.improper_payment_exposure_usd DESC NULLS LAST
LIMIT 20
