-- Sentinel Payment Integrity — Silver Layer
-- SDP pipeline: raw parquet (UC Volume) → silver materialized views

-- Helper: aggregate fraud signals per payment
CREATE OR REFRESH MATERIALIZED VIEW payment_signal_summary AS
SELECT
  payment_id,
  COUNT(*) AS n_signals,
  COLLECT_LIST(signal) AS signal_list,
  ARRAY_AGG(
    CASE
      WHEN signal IN ('duplicate_identity', 'deceased_payee', 'cross_agency_fraud_flag') THEN 'strong'
      WHEN signal IN ('income_mismatch', 'benefit_overlap', 'employment_mismatch') THEN 'moderate'
      ELSE 'weak'
    END
  ) AS signal_strengths
FROM read_files('/Volumes/${catalog}/${schema}/raw_data/payment_fraud_flags', format => 'parquet')
GROUP BY payment_id;

-- Silver: per-payment current status, denormalized with beneficiary + claim + signals
CREATE OR REFRESH MATERIALIZED VIEW silver_payments_flagged AS
WITH beneficiaries AS (
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/beneficiaries', format => 'parquet')
),
claims AS (
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/claims', format => 'parquet')
),
payments AS (
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/payments', format => 'parquet')
)
SELECT
  p.payment_id,
  p.beneficiary_id,
  p.claim_id,
  b.program,
  b.state,
  p.payment_amount_usd,
  p.queue_date,
  p.payment_status,
  c.claim_type,
  COALESCE(s.n_signals, 0) AS n_signals,
  s.signal_list,
  s.signal_strengths,
  CASE
    WHEN COALESCE(s.n_signals, 0) >= 2
      AND ARRAY_CONTAINS(COALESCE(s.signal_strengths, ARRAY()), 'strong')
      THEN 'high'
    WHEN COALESCE(s.n_signals, 0) >= 1 THEN 'moderate'
    ELSE 'low'
  END AS risk_level
FROM payments p
JOIN beneficiaries b ON p.beneficiary_id = b.beneficiary_id
LEFT JOIN claims c ON p.claim_id = c.claim_id
LEFT JOIN payment_signal_summary s ON p.payment_id = s.payment_id;

-- Silver: disposition outcomes history (denormalized with beneficiary info)
CREATE OR REFRESH MATERIALIZED VIEW silver_disposition_outcomes AS
WITH outcomes AS (
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/disposition_outcomes', format => 'parquet')
),
beneficiaries AS (
  SELECT * FROM read_files('/Volumes/${catalog}/${schema}/raw_data/beneficiaries', format => 'parquet')
)
SELECT
  o.case_id,
  o.beneficiary_id,
  b.program,
  b.state,
  o.case_date,
  o.amount_usd,
  o.n_signals,
  CASE
    WHEN o.n_signals >= 3 THEN 'stacked_strong'
    WHEN o.n_signals = 2 THEN 'mixed'
    WHEN o.n_signals = 1 THEN 'single'
    ELSE 'none'
  END AS signal_strength_mix,
  o.disposition_chosen,
  o.was_improper,
  o.recovery_amount_usd,
  o.days_to_resolution
FROM outcomes o
LEFT JOIN beneficiaries b ON o.beneficiary_id = b.beneficiary_id;
