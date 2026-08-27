-- Sentinel Payment Integrity — Gold Layer
-- SDP pipeline: silver → gold tables (open queue, case outcomes, disposition recommendations)

-- Gold: the open flagged payment queue (the heart of the demo)
CREATE OR REFRESH MATERIALIZED VIEW gold_open_queue AS
SELECT
  payment_id,
  beneficiary_id,
  program,
  state,
  payment_amount_usd,
  queue_date,
  n_signals,
  signal_list,
  signal_strengths,
  risk_level,
  -- Improper-payment exposure: projected $ loss if released and payment is improper
  CASE
    WHEN risk_level = 'high' THEN payment_amount_usd * 0.80
    WHEN risk_level = 'moderate' THEN payment_amount_usd * 0.15
    ELSE payment_amount_usd * 0.02
  END AS improper_payment_exposure_usd,
  -- Projected recovery if investigated (65% recovery rate from historical outcomes)
  CASE
    WHEN risk_level = 'high' THEN payment_amount_usd * 0.80 * 0.65
    WHEN risk_level = 'moderate' THEN payment_amount_usd * 0.15 * 0.65
    ELSE payment_amount_usd * 0.02 * 0.65
  END AS projected_recovery_if_investigated_usd
FROM silver_payments_flagged
WHERE n_signals >= 1;

-- Gold: historical case outcomes for model training / heuristic validation
CREATE OR REFRESH MATERIALIZED VIEW gold_case_outcomes AS
SELECT
  case_id,
  n_signals,
  signal_strength_mix,
  amount_usd,
  disposition_chosen,
  was_improper,
  recovery_amount_usd,
  days_to_resolution,
  CASE
    WHEN was_improper AND recovery_amount_usd > 0 THEN recovery_amount_usd
    ELSE 0
  END AS recovery_outcome
FROM silver_disposition_outcomes;

-- Gold: disposition recommendations (heuristic-based ranking)
-- Each flagged payment gets a recommended disposition based on signal count + strength:
--   refer_to_investigation: n_signals >= 3 (stacked signals, at least one strong)
--   hold_for_verification: n_signals = 2, OR single strong signal
--   release: single weak/moderate signal only
CREATE OR REFRESH MATERIALIZED VIEW gold_disposition_recommendations AS
SELECT
  payment_id,
  program,
  risk_level,
  n_signals,
  signal_list,
  -- Recommended disposition by heuristic
  CASE
    WHEN n_signals >= 3 THEN 'refer_to_investigation'
    WHEN n_signals = 2 THEN 'hold_for_verification'
    WHEN n_signals = 1 AND ARRAY_CONTAINS(COALESCE(signal_list, ARRAY()), 'duplicate_identity') THEN 'hold_for_verification'
    WHEN n_signals = 1 AND ARRAY_CONTAINS(COALESCE(signal_list, ARRAY()), 'deceased_payee') THEN 'hold_for_verification'
    WHEN n_signals = 1 AND ARRAY_CONTAINS(COALESCE(signal_list, ARRAY()), 'cross_agency_fraud_flag') THEN 'hold_for_verification'
    ELSE 'release'
  END AS recommended_disposition,
  -- Predicted improper probability
  CASE
    WHEN risk_level = 'high' THEN 0.80
    WHEN risk_level = 'moderate' THEN 0.15
    ELSE 0.02
  END AS predicted_improper_probability,
  -- Predicted recovery if investigated
  CASE
    WHEN risk_level = 'high' THEN payment_amount_usd * 0.80 * 0.65
    WHEN risk_level = 'moderate' THEN payment_amount_usd * 0.15 * 0.65
    ELSE payment_amount_usd * 0.02 * 0.65
  END AS predicted_recovery_usd,
  -- Net value (recovery - citizen delay cost)
  CASE
    WHEN n_signals >= 3 THEN payment_amount_usd * 0.80 * 0.65
    WHEN n_signals = 2 OR (n_signals = 1 AND ARRAY_CONTAINS(COALESCE(signal_list, ARRAY()), 'duplicate_identity'))
      OR (n_signals = 1 AND ARRAY_CONTAINS(COALESCE(signal_list, ARRAY()), 'deceased_payee'))
      OR (n_signals = 1 AND ARRAY_CONTAINS(COALESCE(signal_list, ARRAY()), 'cross_agency_fraud_flag'))
      THEN payment_amount_usd * 0.80 * 0.65 * 0.3 - payment_amount_usd * 0.005 * 3
    ELSE 0
  END AS predicted_net_value_usd,
  -- Confidence score
  CASE
    WHEN n_signals >= 2 AND ARRAY_CONTAINS(COALESCE(signal_strengths, ARRAY()), 'strong') THEN 0.95
    WHEN n_signals = 1 THEN 0.70
    ELSE 0.40
  END AS confidence_score,
  -- Reasoning memo scaffold
  CONCAT(
    CASE WHEN risk_level = 'high' THEN 'High-risk: ' WHEN risk_level = 'moderate' THEN 'Moderate-risk: ' ELSE 'Low-risk: ' END,
    CAST(n_signals AS STRING), ' fraud signal(s) on $',
    CAST(ROUND(payment_amount_usd, 0) AS STRING), ' ', program, ' payment. ',
    CASE
      WHEN n_signals >= 3 THEN 'Multiple stacked signals warrant full investigation. '
      WHEN n_signals = 2 THEN 'Two signals justify verification hold before disbursement. '
      ELSE 'Single signal; release likely appropriate after cursory review. '
    END,
    'Estimated improper exposure: $', CAST(ROUND(
      CASE WHEN risk_level = 'high' THEN payment_amount_usd * 0.80
           WHEN risk_level = 'moderate' THEN payment_amount_usd * 0.15
           ELSE payment_amount_usd * 0.02 END, 0) AS STRING), '.'
  ) AS reasoning
FROM gold_open_queue;
