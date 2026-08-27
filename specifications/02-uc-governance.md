# UC Governance — Metric View

Tables defined in `01-lakeflow.md`. Skill: `databricks-metric-views`.

## Metric View — `mv_payment_risk`

Source: `gold_open_queue` JOINed to `gold_disposition_recommendations` on `payment_id` (the queue carries risk + exposure; the recommendations table carries `recommended_disposition` + `confidence_score`). Build the MV over that join (or a thin `gold_queue_scored` view of it) so the disposition-count + confidence measures resolve. Single view, aggregated materialization. This is the **one governed definition** of Sentinel's payment-risk metrics — the dashboard KPI tiles, Della's Genie answers, and the app all read these same measures, so the numbers match wherever she looks.

**Dimensions**: `program`, `risk_level`, `recommended_disposition`.

**Measures** (full list — referenced verbatim by dashboard datasets + Genie example SQLs + the app's KPI tiles, so any rename here is a breaking change downstream):

| Name | Expression |
|------|------------|
| `payment_count` | `COUNT(1)` |
| `total_queue_value_usd` | `SUM(payment_amount_usd)` |
| `flagged_payment_count` | `COUNT(1)` (all rows in this MV are flagged; ungrouped = total flagged) |
| `improper_payment_exposure_usd` | `SUM(improper_payment_exposure_usd)` |
| `projected_recovery_if_investigated_usd` | `SUM(projected_recovery_if_investigated_usd)` |
| `avg_payment_amount_usd` | `AVG(payment_amount_usd)` |
| `avg_n_signals` | `AVG(n_signals)` |
| `high_confidence_count` | `SUM(CASE WHEN confidence_score >= 0.85 THEN 1 ELSE 0 END)` |
| `release_recommended_count` | `SUM(CASE WHEN recommended_disposition = 'release' THEN 1 ELSE 0 END)` |
| `hold_recommended_count` | `SUM(CASE WHEN recommended_disposition = 'hold_for_verification' THEN 1 ELSE 0 END)` |
| `investigate_recommended_count` | `SUM(CASE WHEN recommended_disposition = 'refer_to_investigation' THEN 1 ELSE 0 END)` |

Count/flag measures use `SUM(CASE WHEN … )` (not `MEASURE(x)/MEASURE(y)`) so the engine computes them at the filtered-slice level — correct under any global dashboard filter and safe on empty slices. `avg_payment_amount_usd` and `avg_n_signals` are averages; they're health signals but not KPI tiles (the three exposure/recovery measures + the disposition-action counts are the tiles).

**Materialization**: aggregated on `(program, risk_level, recommended_disposition) × all measures`, refresh every 4h. (The open-queue table is a daily snapshot, but the app re-fetches hourly, so 4h is a good refresh cadence.)

### Consumers

- **Dashboard KPI tiles** — Flagged payments (#), Improper-payment exposure ($), Projected recovery ($), Payment count by disposition recommendation (#) — all via `MEASURE(...)`.
- **Genie headline answers** — "how much improper-payment exposure do we have in the queue?", "how many flagged cases are recommended for investigation?", "what's the per-program improper-payment risk?" resolve to these measures. Per-widget bindings live in `04-ai-bi.md`.
- **The app's KPI cards** — the Payment Queue page reads the same measures (via warehouse SQL over the MV) so the app header matches the dashboard exactly.

> The disposition model (`03-ml-disposition.md`) does **not** consume `mv_payment_risk`. It trains on `gold_case_outcomes` (per-case history) and scores `gold_open_queue` (per-payment) — different grain. `mv_payment_risk` is the aggregated risk layer; do not unify.

### Validation

- `MEASURE(improper_payment_exposure_usd)` total over the flagged open queue ≈ $0.36M (high-risk stacked-signal cases dominate); scales with the queue depth + pinned seed.
- `MEASURE(flagged_payment_count)` by `recommended_disposition` is a realistic 3-way split (validated ≈ release 46% / hold 32% / refer 21%), never a single degenerate action. Total = the flagged open-queue depth (≈ 400 with the pinned seed).
- Genie's answer to "what's our improper-payment exposure for TANF?" matches `MEASURE(improper_payment_exposure_usd)` for `program='TANF'` exactly.
- `DESCRIBE EXTENDED` shows the aggregated materialization on the declared dimension set.

Add `metric_view_name` to `resources.json`.
