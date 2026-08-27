-- Which programs have the highest improper-payment exposure and projected recovery?
-- Runs against the synced UC table in Lakebase (sentinel.synced_gold_open_queue)

SELECT
    program,
    COUNT(*) AS flagged_payments,
    ROUND(SUM(improper_payment_exposure_usd)::numeric, 2) AS total_exposure_usd,
    ROUND(SUM(projected_recovery_if_investigated_usd)::numeric, 2) AS total_projected_recovery_usd,
    ROUND(AVG(improper_payment_exposure_usd)::numeric, 2) AS avg_exposure_per_payment,
    ROUND(AVG(n_signals::numeric), 1) AS avg_signals,
    COUNT(*) FILTER (WHERE risk_level = 'high') AS high_risk_count
FROM sentinel.synced_gold_open_queue
GROUP BY program
ORDER BY total_exposure_usd DESC;
