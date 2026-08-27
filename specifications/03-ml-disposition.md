# Disposition Recommendation — OPTIONAL ML model (the default is a pipeline heuristic)

> ## ⏭️ You can skip this whole file.
>
> `gold_disposition_recommendations` is **already produced by the SDP pipeline** using a hardcoded
> heuristic (defined in `01-lakeflow.md` → Silver→Gold → `gold_disposition_recommendations`): for each
> open flagged payment it ranks release / hold-for-verification / refer-to-investigation by **net recovery value = projected_recovery − citizen_delay_cost**,
> computed in SQL, and **hold-for-verification wins for the hero payment** (high-risk stacked signals). The app, dashboard,
> and Genie all read that table — they never call a model. **So the full solution works end-to-end
> with no ML at all.**
>
> This file is a **stretch**: if a team wants to showcase ML, train a model that *learns* the
> improper-payment probability + recovery amount from history and **overwrite the same `gold_disposition_recommendations` table** with its
> scored output. Nothing downstream changes — same schema, same app. If you skip it, drop
> `ml-training-serving` from `resources.json`'s buildable list.

Reads `gold_case_outcomes` (training) + `gold_open_queue` (the flagged payments to score) from `01-lakeflow.md`. Overwrites `gold_disposition_recommendations`.

## The story (same as the heuristic — just learned instead of coded)

When a pre-disbursement payment is flagged with fraud signals, an examiner must choose: **release it to disburse**, **hold it for verification**, or **refer it to investigation** — and the right choice is **situational** (signal count + signal types + payment amount + program + history). The model **learns** how much recovery (in improper-payment catches + taxpayer impact avoidance) each disposition yields from Sentinel's own case history, instead of the heuristic's hand-set rules. For the hero payment (`PAY-0000214` × stacked strong signals × high amount) it should still rank **refer-to-investigation** first (or hold-for-verification as a close second) — the history is generated so that holds.

## What to train

A **classifier predicting improper-payment probability** + a **regressor predicting recovery amount** for a flagged payment, trained on `gold_case_outcomes` (one row per historical case + its disposition outcome + whether it was improper + recovery realized). Approach: XGBoost classifier + regressor (or a single XGBoost regressor on recovery amount, using that to infer improper probability), Optuna ~10 trials, MLflow autolog. Register to UC as `{catalog}.{schema}.disposition_recommender`, promote `@prod`.

**Skill**: `databricks-ml-training` / `databricks-model-serving` (owns the *how* — UC registry URI, experiment parent-folder trap, `@prod` alias, Optuna+autolog, `spark_udf` env_manager rules, serverless-job `--no-wait` + TASK-run_id pattern, gotchas table). This spec is *what*.

> Classification + regression, not just a label: the app needs a **predicted improper-$ and improper-probability per disposition** to rank the three plays AND show the examiner the risk/reward, not just a single "best disposition" label. Ranking falls out of scoring each candidate disposition (release → what's the risk of improper leaking through? hold → what's the delay cost? investigate → what's the expected recovery?) and ordering by predicted net recovery — the same ordering step the heuristic does.

## Features

All derivable from `gold_case_outcomes` (training) and reconstructable for each candidate disposition at scoring time:

- `n_signals` — count of fraud signals on the payment (0–8).
- `signal_strength_mix` — categorical encoding of signal types: (count of strong, count of moderate, count of weak) or a categorical (e.g., 'stacked_strong' / 'mixed' / 'weak_only').
- `payment_amount_usd` — the disputed payment amount (range $200–$3,500 typically; higher amounts = higher recovery stake).
- `program` — the benefit program (categorical: TANF / SNAP / Child Care / Disability / Veteran's).
- `state` — the state (categorical or grouped).
- `disposition_candidate` — the disposition being scored (categorical: 'release' / 'hold_for_verification' / 'refer_to_investigation').
- `days_to_resolution_estimate` — expected time for the chosen disposition (release ~0, hold ~3–7, investigate ~14–30) — impacts citizen delay cost.

**Labels:**
- `was_improper` (binary) — ground truth from historical outcome.
- `recovery_amount_usd` (regression) — actual recovery realized (0 if was_improper=false).

## Inference shape

Same notebook trains AND scores. After training, for every open flagged payment in `gold_open_queue`, construct the **three candidate dispositions** (release, hold-for-verification, refer-to-investigation), score each with `spark_udf(models:/...@prod)` for improper probability + predicted recovery $, and write the ranked result to `gold_disposition_recommendations` (overwrite):

| Column | |
|---|---|
| `payment_id` | flagged payment (PK) |
| `program` | benefit program |
| `risk_level` | high / moderate / low |
| `n_signals` | count of fraud signals |
| `signal_list` | array of signal names |
| `recommended_disposition` | the top-ranked disposition by predicted net recovery value |
| `predicted_improper_probability` | model's probability this payment is improper (0–1) |
| `predicted_recovery_usd` | model's predicted $ recovery if investigated |
| `predicted_net_value_usd` | recovery − citizen_delay_cost for the recommended disposition |
| `confidence_score` | model confidence in the recommendation (0–1) |
| `disposition_ranking` | JSON array of all three candidate dispositions with their predicted improper-%, recovery $, delay cost, and net value — the app renders this as ranked options + what-if base |
| `reasoning` | natural-language memo scaffold filled in from model features + prediction (e.g., *"3 signals (2 strong) + $1,850 → 78% improper probability. Recommend refer-to-investigation: $1,430 predicted recovery if improper (cost ~$400 investigation) = $1,030 net value vs. hold ($400 net) or release ($0 net + ~$1,480 improper loss). Investigation justified."*) |
| `scored_at` | now() |

**Batch only — no serving endpoint.** Every downstream consumer reads from a table; serving would add cost + quota for zero narrative gain. (Real-time re-scoring on a what-if slider is talk-track: the app recomputes the tradeoff arithmetically from `disposition_ranking` for the demo.)

## Execution

One Databricks notebook (e.g. `./transformation/disposition_train_score.py`, alongside the pipeline SQL) doing train → register → set `@prod` → build candidate dispositions → batch-score → overwrite `gold_disposition_recommendations` → `dbutils.notebook.exit(json.dumps({model_version, accuracy, auc, cases_scored, investigate_recommended, hold_recommended, release_recommended}))`. Run as a **serverless job** (~10-15 min). Never run locally. Nightly re-score is talk-track only.

**Notebook-source format is required** (`# Databricks notebook source` header + `# MAGIC %md` cells + `# COMMAND ----------` separators) — without it the file uploads as a plain `.py`, cells don't render.

## Who consumes the predictions

1. **Payment Integrity app** — Delta `gold_disposition_recommendations` is mirrored into Lakebase as `app.disposition_recommendations` on app boot + on "Reset demo" (see `specifications/app/03_DATA_MODEL.md`). The agent's `rank_dispositions` tool reads it from Lakebase so hot-path lookups are sub-ms; the app renders `disposition_ranking` as the ranked options + what-if base + the examiner can drill into the reasoning memo. Talking-track: production uses Lakebase Synced Tables for continuous replication; the demo does a one-shot manual sync to keep moving parts visible.
2. **Genie** — reads from Delta directly. Answers *"what's the recommended disposition for payment PAY-0000214?"*, *"how much improper-payment exposure are we at risk of if we release all low-confidence flagged cases?"*, *"what % of our high-risk payments are recommended for investigation?"*.
3. **AI/BI dashboard** (`04-ai-bi.md`) — reads from Delta, a widget showing disposition-recommendation mix + total projected recovery across open flagged payments.

## Functional validation

- **Hero recommendation is hold or investigate** — `gold_disposition_recommendations WHERE payment_id='PAY-0000214'` → `recommended_disposition IN ('hold_for_verification', 'refer_to_investigation')` with high confidence (≥0.80), `predicted_improper_probability ≥ 0.75`, and `disposition_ranking` has investigate (or hold) ranked above release. If release is recommended for the hero, re-check `gold_case_outcomes` learnability (`01-lakeflow.md` validation) and the candidate-disposition construction.
- **Disposition mix is plausible** — across all open flagged payments, `recommended_disposition` is a mix (not 100% one type): high-risk → investigate/hold; moderate → hold; low → release (if any low-risk slipped into the queue). If it collapses to a single disposition everywhere, the features or the training outcomes aren't separating.
- **Predicted recovery rolls up** — `SUM(predicted_recovery_usd)` across open flagged payments is a plausible fraction of the $12M improper-payment exposure (recovery doesn't catch 100%).
- **Model quality** — training accuracy / AUC is reasonable (autologged); the notebook exit JSON reports it. For a classifier on improper probability, AUC ≥ 0.80 is good; for a regressor on recovery $, RMSE should be <20% of the mean recovery amount.

## resources.json

- `ml_model_name`: `{catalog}.{schema}.disposition_recommender`
- `mlflow_experiment_path`: `/Workspace/Users/<your-user>/sentinel-benefits/experiments/disposition_recommender`
