# App Specification — Analytics Page

Warehouse-backed SQL queries over Delta tables (`silver_disposition_outcomes`, `gold_open_queue`, raw case history) — analytics that do NOT require Lakebase, so they're fast and queryable by non-technical users via the dashboard.

## Page layout

Three charts, one below the other:

### Chart 1 — Case history: disposition vs. improper outcome
**Type:** Stacked bar chart (or small multiples if space allows).
**Query (pseudo-SQL):**
```sql
SELECT disposition_chosen, was_improper, COUNT(*) AS count
FROM silver_disposition_outcomes
GROUP BY disposition_chosen, was_improper
```
**X-axis:** disposition_chosen (Release / Hold / Investigate)
**Y-axis:** COUNT(cases)
**Stack:** was_improper (true/false) — true = red, false = blue
**Story:** Investigate cases have ~78% improper rate (red dominates); Release cases ~2% (blue dominates); Hold ~12% (mixed). This teaches the user the model's training signal: high signal count → investigate → high improper rate.

### Chart 2 — Signal type frequency in high-risk flagged cases
**Type:** Horizontal bar chart.
**Query (pseudo-SQL):**
```sql
SELECT signal, COUNT(DISTINCT payment_id) AS payment_count
FROM raw_payment_fraud_flags
WHERE payment_id IN (SELECT payment_id FROM gold_open_queue WHERE risk_level='high')
GROUP BY signal
ORDER BY payment_count DESC
```
**X-axis:** COUNT(distinct payment IDs per signal)
**Y-axis:** signal name (duplicate_identity, cross_agency_fraud_flag, income_mismatch, etc.)
**Color:** Single color (navy)
**Story:** Shows which signals are most common in high-risk cases. Expected: duplicate_identity + cross_agency_fraud_flag dominate (the new fraud feed signals).

### Chart 3 — Projected recovery by recommended disposition
**Type:** Bar chart with data labels.
**Query (pseudo-SQL):**
```sql
SELECT recommended_disposition, COUNT(*) AS case_count, SUM(predicted_recovery_usd) AS recovery_usd
FROM gold_disposition_recommendations
GROUP BY recommended_disposition
```
**X-axis:** recommended_disposition
**Y-axis:** SUM(predicted_recovery_usd)
**Data labels:** case count + total recovery $ above each bar
**Color by disposition:** red (investigate) / amber (hold) / blue (release)
**Story:** Investigate cases have the highest recovery potential (bulk of the $). This justifies the model's high-case ranking and the resource-allocation tradeoff.

## Validation

- **Chart 1:** Release cases show ~0% improper (all blue); Investigate cases show ~78% (mostly red); Hold ~12% (mixed). If all one color, the model isn't learning.
- **Chart 2:** Fraud feed signals (duplicate_identity, cross_agency_fraud_flag) are in the top 3 by frequency.
- **Chart 3:** Investigate cases have the highest SUM recovery_usd. Recovery $ roughly matches the `improper_payment_exposure` KPI from the dashboard.
