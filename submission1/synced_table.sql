-- Query against the synced Unity Catalog table (lanl.sentinel.gold_open_queue)
-- synced into Lakebase as sentinel.synced_gold_open_queue
-- Sync mode: SNAPSHOT, pipeline_id: 71821514-145f-49ed-9954-a31ba7aba7dd

SELECT
    payment_id,
    program,
    risk_level,
    n_signals,
    payment_amount_usd,
    improper_payment_exposure_usd,
    projected_recovery_if_investigated_usd
FROM sentinel.synced_gold_open_queue
ORDER BY improper_payment_exposure_usd DESC
LIMIT 10;
