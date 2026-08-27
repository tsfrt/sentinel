# Lakeflow — Data Ingestion + Processing

## Shared Context (referenced by all other spec files)

**The story in one sentence:** A cross-agency fraud-match feed + eligibility-data refresh ~3 weeks ago surfaced a spike of high-risk pre-disbursement payments flagged by multiple fraud signals. The hero payment `PAY-0000214` (TANF, $1,850) carries stacked signals (duplicate identity, cross-agency fraud flag) → recommended disposition = **hold-for-verification**. The pattern shows a learnable 3-way split: high-risk stacked signals → investigate; moderate single signals → often release; low-risk → release.

**Key payment:**
- **Payment ID:** `PAY-0000214`
- **Program:** TANF
- **Amount:** $1,850 USD
- **Fraud signals:** duplicate_identity, cross_agency_fraud_flag (2 stacked strong signals)
- **Recommended disposition:** hold-for-verification (high projected recovery if improper; cost of delay justified by signal strength)

**Time references:**
- `NOW = datetime.now()` by default (rolling — the dashboard's right edge is always yesterday-real; set `SENTINEL_PIN_TIME=1` to freeze for recorded videos / baked-in IDs).
- `HISTORY_START = NOW − 18 months` (case outcomes + disposition history for the model).
- `FRAUD_WAVE_ONSET = NOW − 21 days` (~3 weeks ago — the cross-agency fraud feed + eligibility refresh landed).
- `RISK_SPIKE_RAMP = NOW − 18 days` (high-risk queue on affected signals climbs).
- `SNAPSHOT_DATE = NOW − 1 day` (the "current" pre-disbursement queue snapshot the app + dashboard read).
- `QUEUE_WINDOW_START = NOW − 56 days` (~8 weeks of daily payment/queue history, so the fraud-wave onset ~3 weeks ago is a VISIBLE ramp on the daily flagged-rate trend).

**Payment volume + queue depth** (sampled demo figures; the $-scale figures are talk-track for a real ~$40B/yr agency):
- Sampled payments in the window: **~1,100** (a real daily queue is ~$280M / thousands of cases — talk-track).
- Flagged (carry ≥1 fraud signal): **~180** — the current work queue.
- High-risk (2+ stacked signals incl. a strong one): **~50**.
- Improper-payment exposure on the flagged queue: **~$0.36M sampled** (~$12M+ at real scale — talk-track).
- Examiner capacity: ~50 cases/day → prioritization matters.
- Disposition mix (validated, realistic 3-way — never a single degenerate action): **≈ 35% release / 43% hold-for-verification / 22% refer-to-investigation** (single weak signal → release; 2 signals or a single strong signal → hold; 3+ → refer).

**Fraud signals** (8 types, each payment carries 0–N):
1. `duplicate_identity` — cross-match with another active beneficiary (same SSN variant / name+DOB)
2. `deceased_payee` — beneficiary matched to death records
3. `income_mismatch` — declared income vs. third-party income reports (IRS, employers)
4. `benefit_overlap` — beneficiary active in another state program simultaneously (should be single-state)
5. `cross_agency_fraud_flag` — another federal agency flagged for fraud (SSA, USCIS, etc.) — the **main signal from the new feed**
6. `employment_mismatch` — claimed unemployment but employment records show active employment
7. `residence_mismatch` — address mismatch with utility / tax records
8. `manual_review_flag` — examiner/supervisor flagged for manual review (reason TBD)

**Signal strength:** `duplicate_identity`, `deceased_payee`, `cross_agency_fraud_flag` are STRONG (high improper-payment probability). `income_mismatch`, `benefit_overlap`, `employment_mismatch` are MODERATE. `residence_mismatch`, `manual_review_flag` are WEAK (often legitimate explanations).

> Numbers in this file are demo targets, not invariants — match the narrative shape, don't sweat ±10%. Parallelization rules live in `SKILL.md` → **Parallelization with Subagents**.

---

## A. Synthetic Data Generation

**Skill**: `databricks-synthetic-data-gen` (read `SKILLS/databricks-synthetic-data-gen/SKILL.md`). Use the pre-provisioned databricks-connect venv (Python 3.12 + faker + numpy + pandas + pyarrow) — system prompt has the path; do NOT create a new venv. Generation is **pure Spark** — `spark.range` + `F.when` + broadcast joins + Window functions + `F.element_at` against literal arrays. No driver loops, no `.collect()` on big tables.

Write the raw datasets as **parquet files into the UC Volume** `/Volumes/{catalog}/{schema}/raw_data/<dataset>/` (one subdir per dataset, named without the `raw_` prefix). This Volume is the raw landing zone; SDP silver reads it via `read_files()` — no bronze pass-through, no raw Delta tables:

| Table | Rows | Notes |
|-------|------|-------|
| `raw_beneficiaries` | ~1,100 | Active beneficiary records. Program, state, income, signal tags. The hero beneficiary (index 213 → BEN-0000214) carries MULTIPLE strong signals (duplicate identity + cross-agency flag). Everyday beneficiaries carry 0–1 signals. |
| `raw_claims` | ~1,200 | Benefit claims (recertifications, new applications, adjustments) that feed the payment queue. One claim per beneficiary × period; some denied, some combined. Amount by program (TANF ~$400–1,200, SNAP ~$150–600, Child Care ~$800–2,000, etc.). |
| `raw_payments` | ~1,100 | Pre-disbursement queue: queued benefit disbursements. Beneficiary → claim → amount → in queue now. Hero payment `PAY-0000214` high-amount + stacked fraud signals. |
| `raw_payment_fraud_flags` | ~300 | (Payment × signal) pairs — the fraud-match signals flagging each payment. The cross-agency FEED only surfaces flags from the wave onset, so the daily flagged RATE ramps: pre-wave weeks ~5%, post-wave (last ~3w) ~30%+ (the spike). High-risk payments carry 2–4 signals; moderate carry 1; low carry 0. |
| `raw_disposition_outcomes` | ~8,000 | 18-month case history: each historical case with (disposition_chosen, was_improper, recovery_amount) outcomes — the training data for the disposition model. Relationship: stacked signals → investigated → high recovery; weak signals → released → low improper-payment rate. |

### Data Variation

**Pre-disbursement queue composition:**
- **High-risk** (~18%, ~200 of 1,100): 2–4 stacked strong signals (duplicate_identity, deceased, cross_agency_flag, income_mismatch). High amounts (weighted $1,200–$3,500). Disposition: hold or investigate. Improper rate: ~80%.
- **Moderate-risk** (~14%, ~150): single moderate signal (benefit_overlap, employment_mismatch) or weak signal + contextual risk. Amounts $400–$2,000. Disposition: split between release + hold. Improper rate: ~15%.
- **Low-risk** (~68%, ~750): 0 signals or very weak signals only. Amounts $200–$2,500. Disposition: almost all release. Improper rate: ~2%.

**The anomaly (the wave): ~3 weeks ago (fraud_wave_onset):**
- New cross-agency fraud-match data landed + beneficiary eligibility refresh.
- Flagged RATE jumps: the cross-agency feed surfaces flags only from the onset, so daily flagged rate steps from ~5% (pre-wave weeks) to ~30%+ (post-wave, last ~3 weeks) — the visible spike on the trend chart.
- **Concentrated in the last 3 weeks:** the queue TODAY is weighted 70% post-wave cases (the current backlog), creating the urgency.
- High-risk cases cluster at high amounts: the projected recovery from investigating the top 1,400 flagged is ~$12M (25% of cases × $8.5K avg if improper).

**Signal attachment logic (Spark generation):**
- Each beneficiary is born with 0–N signal tags (deterministic per ID).
- Each payment inherits the beneficiary's signals + gets random per-payment signal additions (low frequency).
- Hero beneficiary (BEN-0000214) starts with 2 strong signals; hero payment (PAY-0000214) inherits + maybe 1 more.
- Everyday beneficiaries: 85% carry 0 signals, 12% carry 1, 3% carry 2+.
- High-risk cohort (first ~200 beneficiaries by ID): 40% carry 2+ signals.

### Case disposition history (raw_disposition_outcomes)

18 months of historical cases with **outcomes** — what disposition was chosen, was the payment actually improper, recovery amount. The pipeline learns from this:
- When a case had 3+ signals, it was investigated 90% of the time.
- When investigated + improper was true, recovery averaged 65% of the payment amount.
- When released (disposition), improper-payment rate was 2%; when investigated, 78%.
- Held cases (verification hold) were investigated at 30% rate, improper at 12% (partial resolution by verification).

Quantify so the downstream model learns real bounds: **projected improper-payment exposure if all high-risk flagged cases are released** ≈ $12M (1,400 cases × 80% improper rate × $10.7K average). **Projected recovery if investigated** ≈ $9.6M (1,400 × 80% × 65% recovery rate — costs of investigation already deducted). This is what the app + dashboard show as KPIs.

### Raw table schemas (gen output)

ID formats: `BEN-NNNNNNN` / `CLM-NNNNNNNN` / `PAY-NNNNNNN` / `FLG-NNNNNNNN` / `CASE-NNNNNNNN`. PKs in **bold**, FKs marked.

- **`raw_beneficiaries`** — **beneficiary_id**, program (`TANF/SNAP/Child Care/Disability/Veteran's`), state (2-letter code), monthly_income_usd (DOUBLE, varies by program; some $0 if unemployed), signal_tags (STRING, pipe-delimited signal names or NULL), enrollment_date (DATE).
- **`raw_claims`** — **claim_id**, beneficiary_id (FK), claim_type (`recertification/new_application/supplemental/adjustment/correction`), claim_amount_usd (DOUBLE, program-dependent ranges), claim_date (DATE).
- **`raw_payments`** — **payment_id**, beneficiary_id (FK), claim_id (FK), payment_amount_usd (DOUBLE), queue_date (DATE), payment_status (STRING = `pre_disbursement`).
- **`raw_payment_fraud_flags`** — **flag_id**, payment_id (FK), signal (STRING, one of the 8 signal names). One row per (payment, signal) pair.
- **`raw_disposition_outcomes`** — **case_id**, beneficiary_id (FK), case_date (DATE), amount_usd (DOUBLE), n_signals (INT, count of signals on that case), disposition_chosen (`release/hold_for_verification/refer_to_investigation`), was_improper (BOOLEAN), recovery_amount_usd (DOUBLE), days_to_resolution (INT).

---

## B. SDP Pipeline

**Skill to use**: `databricks-pipelines` — read `SKILLS/databricks-pipelines/SKILL.md` before implementing.

Create pipeline `sentinel_payments` transforming raw parquet → analytics tables. Configure with a `configuration: {catalog, schema}` block and read the Volume via `read_files('/Volumes/${catalog}/${schema}/raw_data/...')` so it works on any target catalog/schema.

### Consumer Requirements

| Consumer | Needs | From Table |
|----------|-------|------------|
| Dashboard KPIs (flagged count, improper exposure, held, investigated) + trend | daily payment-queue metrics by program + risk level | `mv_payment_risk` metric view (over `gold_open_queue`, defined in `02-uc-governance.md`) |
| Dashboard queue + risk widgets | per-payment current status with signals + disposition recommendation | `gold_open_queue` |
| Genie "why is this payment flagged and what's the recommendation" | same per-payment fact with denormalized beneficiary + claim + signals + recommendation prose | `gold_open_queue` |
| Disposition model training (`03-ml-disposition.md`) | one row per historical case with signal features + outcome label | `gold_case_outcomes` |
| Disposition model scoring input | one row per OPEN flagged payment + signal count + case context | `gold_open_queue` |
| App's Payment Queue (open + ranked dispositions) | current flagged payments with beneficiary/claim/signals + ranked disposition + memo scaffold | `gold_open_queue` JOIN `gold_disposition_recommendations` (built by the pipeline heuristic; ML optional) |
| App's analytics drill-downs (via warehouse SQL) | case history trends, disposition outcomes by signal type | `silver_disposition_outcomes` |

### Raw layer (no bronze pass-through)

The data-gen step in Section A writes 5 raw parquet datasets into the `raw_data` Volume: `beneficiaries`, `claims`, `payments`, `payment_fraud_flags`, `disposition_outcomes`. SDP silver reads these files via `read_files()` — there is no bronze layer.

### Raw → Silver (joins + aggregations)

Three silver materialized views — two facts (`silver_payments_flagged`, `silver_disposition_outcomes`) plus one helper (`payment_signal_summary`).

**`payment_signal_summary`** — *dedup for efficient signal analysis*. The synth attaches signals at the (payment, signal) pair level; aggregate to get signal counts + types per payment without cross-join explosion:

```sql
SELECT payment_id,
  COUNT(*) AS n_signals,
  COLLECT_LIST(signal) AS signal_list,
  ARRAY_AGG(CASE
    WHEN signal IN ('duplicate_identity', 'deceased_payee', 'cross_agency_fraud_flag') THEN 'strong'
    WHEN signal IN ('income_mismatch', 'benefit_overlap', 'employment_mismatch') THEN 'moderate'
    ELSE 'weak'
  END) AS signal_strengths
FROM raw_payment_fraud_flags
GROUP BY payment_id
```

**`silver_payments_flagged`** — per-payment current status, denormalized. `raw_payments` JOIN `raw_beneficiaries` (→ program, state, income) JOIN `raw_claims` (→ claim_type, claim_amount) LEFT JOIN `payment_signal_summary` (→ n_signals, signal_list, signal_strengths). Columns: `payment_id`, `beneficiary_id`, `claim_id`, `program`, `state`, `payment_amount_usd`, `queue_date`, `payment_status` (pre_disbursement), `claim_type`, `n_signals`, `signal_list`, `signal_strengths`, **`risk_level`** (derived: 'high' if n_signals ≥ 2 AND any 'strong' signal, 'moderate' if 1 signal, else 'low'). Cluster by `queue_date`.

**`silver_disposition_outcomes`** — case outcome history, denormalized. `raw_disposition_outcomes` JOIN `beneficiaries` (→ program, state). Columns: `case_id`, `beneficiary_id`, `program`, `state`, `case_date`, `amount_usd`, `n_signals`, `signal_strength_mix` (derived), `disposition_chosen`, `was_improper`, `recovery_amount_usd`, `days_to_resolution`. Powers the disposition-model training + dashboard analytics.

### Silver → Gold (aggregations + recommendations)

**Dashboard-filter contract.** Every aggregate consumed by the dashboard MUST carry `program` and `risk_level` as filter dimensions for coherent widget selection.

**`gold_open_queue`** — *the heart of the demo* — one row per OPEN flagged payment (queue_date ≤ SNAPSHOT_DATE, currently pre-disbursement) with signals + current status + disposition recommendation. Built from `silver_payments_flagged WHERE queue_date <= SNAPSHOT_DATE`. Dims: `payment_id`, `beneficiary_id`, `program`, `state`, `payment_amount_usd`, `queue_date`. Metrics/fields: `n_signals`, `signal_list`, `risk_level`, and derived fields:
- **`improper_payment_exposure_usd`** — `WHEN risk_level='high' THEN payment_amount_usd * 0.80 WHEN 'moderate' THEN payment_amount_usd * 0.15 ELSE payment_amount_usd * 0.02` — the projected dollar loss if released and the payment is improper.
- **`projected_recovery_if_investigated_usd`** — `improper_payment_exposure_usd * 0.65` — recovery rate from investigation (historical outcome).
- **`citizen_delay_cost_usd`** — simplified: `payment_amount_usd * 0.005 * days_on_hold` (opportunity cost to beneficiary; ~0.5% of amount per day held) — for the app's what-if analysis.
- **`disposition_recommendation`** (the single column the app acts on): built by the pipeline heuristic (see below). Columns: `payment_id`, `program`, `risk_level`, `n_signals`, `signal_list`, `improper_payment_exposure_usd`, `projected_recovery_if_investigated_usd`, `recommended_disposition`, `confidence_score`, `reasoning`, `memo_scaffold` (pre-draft for the app's case memo).

**`gold_case_outcomes`** — historical dispositions + outcomes for model training/validation. `silver_disposition_outcomes` join back to `gold_open_queue` schema to derive the OUTCOME: pass-through from `silver_disposition_outcomes` + features derived at case time. Columns: `case_id`, `n_signals`, `signal_strength_mix`, `amount_usd`, `disposition_chosen`, `was_improper`, `recovery_amount_usd`, `days_to_resolution`. Label: `recovery_outcome = was_improper AND recovery_amount_usd > 0 * recovery_amount_usd ELSE 0`. Two uses: (a) the heuristic below derives its thresholds from `GROUP BY disposition_chosen, n_signals`; (b) training data for the OPTIONAL ML path (`03-ml-disposition.md`).

**`gold_disposition_recommendations`** — *the ranked disposition per open flagged payment* — **built by the pipeline with a hardcoded HEURISTIC** (no ML needed; ML is an optional swap, see `03-ml-disposition.md`). Each disposition has a **net recovery value = projected_recovery − citizen_delay_cost**, and `recommended_disposition = argmax`. On this data that argmax resolves to a signal-count rule (validated to give a realistic ~46% release / ~32% hold / ~21% refer split — never a single degenerate action):
- **refer-to-investigation** — `n_signals ≥ 3` (stacked signals, at least one strong). `recovery_value = projected_recovery_if_investigated_usd` (full recovery path; investigation is warranted, delay cost irrelevant). ~21%.
- **hold-for-verification** — `n_signals = 2`, OR a single **strong** signal (`duplicate_identity`/`deceased_payee`/`cross_agency_fraud_flag`). `recovery_value = projected_recovery_if_investigated_usd * 0.3 − citizen_delay_cost` (a chunk of held cases proceed to investigation; the ~$100/3-day delay cost accrues but is outweighed). ~32%. **The hero `PAY-0000214` lands here** (2 stacked strong signals → hold pending verification).
- **release** — a single **weak** signal only (`income_mismatch`/`benefit_overlap`/`employment_mismatch`/`residence_mismatch`/`manual_review_flag`). `recovery_value ≈ 0` (little projected recovery; the citizen-delay cost of holding a likely-legitimate payment dominates). ~46%.
- `confidence_score = 0.95 if n_signals ≥ 2 AND has a strong signal, else 0.70 if n_signals == 1, else 0.40`.
- *(Note: the queue is flagged-only — every row has n_signals ≥ 1 — so `release` is the disposition for the single-weak-signal cohort, not for unflagged payments. There are no 0-signal rows in `gold_open_queue`.)*
- Rationale memo (the `reasoning` field): *"High-risk: multiple strong fraud signals + $1,850 → estimated $1,480 improper exposure, $962 projected recovery if investigated. Recommend hold-for-verification: verification (~$100 delay cost to beneficiary over 3 days) + investigation to confirm. If improper, ~$962 in taxpayer recovery justified."* — a template the app + dashboard can fill in.

### Consumer routing

- `mv_payment_risk` (over `gold_open_queue`) → dashboard KPIs + Genie headline answers.
- `gold_open_queue` → dashboard queue + risk-level widgets + app payment list.
- `gold_case_outcomes` → heuristic coefficient source AND training table for OPTIONAL ML path (`03-ml-disposition.md`).
- `gold_disposition_recommendations` → app Payment Queue (ranked recommendations) + dashboard "recommended action" column.
- `silver_disposition_outcomes` → app analytics drill-downs (case history trends) via warehouse SQL.

---

## C. Validation

Run before `03-ml-disposition.md`. Each row = a one-line query the LLM writes against the table; if it fails, fix the synth before publishing downstream resources.

**Load-bearing (must pass — these gate the story):**
- **The hero payment exists and is flagged** — `gold_open_queue WHERE payment_id='PAY-0000214'` → `n_signals ≥ 2`, `signal_list` contains both 'duplicate_identity' and 'cross_agency_fraud_flag', `risk_level='high'`, `improper_payment_exposure_usd > 1000`.
- **Disposition recommendation for hero is sensible** — `gold_disposition_recommendations WHERE payment_id='PAY-0000214'` → `recommended_disposition IN ('hold_for_verification', 'refer_to_investigation')` with high confidence (≥0.85).
- **3-way disposition mix** — `gold_disposition_recommendations` GROUP BY `recommended_disposition`: a realistic split ≈ 35% release / 43% hold / 22% refer (proportions shift with the seed; the invariant is a genuine 3-way split, never ~100% one action). If all one disposition, the model can't learn ranking.
- **Flagged-rate surge** — daily flagged rate WHERE `queue_date >= FRAUD_WAVE_ONSET` vs `< FRAUD_WAVE_ONSET`: post-wave ~30%+ of payments carry ≥1 signal; pre-wave ~5%. The spike must be evident on the trend chart.
- **High-risk cohort stacked signals** — `gold_open_queue WHERE risk_level='high'` → median `n_signals ≥ 2`; ≥70% carry a 'strong' signal type.
- **Moderate cohort is learnable** — `gold_case_outcomes WHERE n_signals=1` show disposition split between release + hold (not all one action); improper rate ~15–20%.
- **Exposure KPIs land** — `SUM(improper_payment_exposure_usd)` on high-risk open queue ≈ $12M; `SUM(projected_recovery_if_investigated_usd)` ≈ $7.8M. Totals must be >$1M to be meaningful.
- **Recovery model outcomes separate** — `gold_case_outcomes` GROUP BY `disposition_chosen`: release cases show ~2% improper rate, hold show ~12%, investigate show ~78% improper rate. Clear separation = learnable.

**Smoke checks** (the LLM derives these — verify upstream invariants didn't break): `risk_level` enum is {high, moderate, low}; `signal_list` is non-null + non-empty for flagged payments; `recommendation_disposition` enum is {release, hold_for_verification, refer_to_investigation}; `gold_open_queue` has 50–200 rows (not zero, not all 1,100 payments); `improper_payment_exposure_usd` never negative; `projected_recovery_if_investigated_usd ≤ improper_payment_exposure_usd`.

Add `pipeline_id` to `resources.json`.
