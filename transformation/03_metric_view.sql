-- Sentinel Payment Integrity — Metric View
-- Governed KPI layer: the ONE definition of payment-risk metrics.
-- Consumed by: dashboard KPI tiles, Genie headline answers, app KPI cards.

CREATE OR REPLACE VIEW lanl.sentinel.mv_payment_risk
WITH METRICS
LANGUAGE YAML
AS $$
  version: 1.1
  source: >
    SELECT
      q.payment_id,
      q.program,
      q.risk_level,
      q.payment_amount_usd,
      q.n_signals,
      q.improper_payment_exposure_usd,
      q.projected_recovery_if_investigated_usd,
      r.recommended_disposition,
      r.confidence_score
    FROM lanl.sentinel.gold_open_queue q
    JOIN lanl.sentinel.gold_disposition_recommendations r
      ON q.payment_id = r.payment_id
  comment: >-
    Canonical payment-risk metrics for Sentinel Payment Integrity.
    All flagged pre-disbursement payments with risk signals, exposure,
    recovery projections, and disposition recommendations.
  dimensions:
    - name: program
      expr: program
      comment: Benefit program (TANF, SNAP, Child Care, Disability, Veteran's)
    - name: risk_level
      expr: risk_level
      comment: Risk classification (high, moderate, low)
    - name: recommended_disposition
      expr: recommended_disposition
      comment: Recommended action (release, hold_for_verification, refer_to_investigation)
  measures:
    - name: payment_count
      expr: COUNT(1)
      comment: Total number of payments in the filtered selection
    - name: total_queue_value_usd
      expr: SUM(payment_amount_usd)
      comment: Total dollar value of payments in the queue
      format:
        type: currency
        currency_code: USD
        decimal_places:
          type: exact
          places: 0
    - name: flagged_payment_count
      expr: COUNT(1)
      comment: Count of flagged payments (all rows in this view are flagged)
    - name: improper_payment_exposure_usd
      expr: SUM(improper_payment_exposure_usd)
      comment: Projected dollar loss if flagged payments are released and improper
      format:
        type: currency
        currency_code: USD
        decimal_places:
          type: exact
          places: 0
    - name: projected_recovery_if_investigated_usd
      expr: SUM(projected_recovery_if_investigated_usd)
      comment: Projected dollar recovery if flagged payments are investigated
      format:
        type: currency
        currency_code: USD
        decimal_places:
          type: exact
          places: 0
    - name: avg_payment_amount_usd
      expr: AVG(payment_amount_usd)
      comment: Average payment amount across selection
      format:
        type: currency
        currency_code: USD
        decimal_places:
          type: exact
          places: 0
    - name: avg_n_signals
      expr: AVG(n_signals)
      comment: Average number of fraud signals per payment
    - name: high_confidence_count
      expr: SUM(CASE WHEN confidence_score >= 0.85 THEN 1 ELSE 0 END)
      comment: Number of recommendations with high confidence (>=0.85)
    - name: release_recommended_count
      expr: SUM(CASE WHEN recommended_disposition = 'release' THEN 1 ELSE 0 END)
      comment: Payments recommended for release
    - name: hold_recommended_count
      expr: SUM(CASE WHEN recommended_disposition = 'hold_for_verification' THEN 1 ELSE 0 END)
      comment: Payments recommended for hold-for-verification
    - name: investigate_recommended_count
      expr: SUM(CASE WHEN recommended_disposition = 'refer_to_investigation' THEN 1 ELSE 0 END)
      comment: Payments recommended for referral to investigation
$$;
