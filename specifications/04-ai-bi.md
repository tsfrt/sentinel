# AI/BI — Dashboard + Genie

Tables and columns referenced here are defined in `01-lakeflow.md` (Section B) and `03-ml-disposition.md` (the recommendations table).
Your goal is to create a Genie space and an AI/BI Dashboard for this story, respecting these specifications.

> **Talking-track-only products mentioned in the README** — do **not** build resources for these:
> - **Databricks One** is a workspace surface, not a buildable artifact — the dashboard + Genie space appear there once built.
> - **Genie Code** is the authoring assist inside the editor — narrative only.
> - **Unity Catalog** / **Unity AI Gateway** are governance layers — the app's model calls run through AI Gateway (talk-track for this data/analytics spec; the app spec covers the assistant).

> Parallelization + subagent spawning rules live in `SKILL.md` → **Parallelization with Subagents**.

## A. Genie Space

**Skill to use**: `databricks-genie` — read `SKILLS/databricks-genie/SKILL.md` before implementing.

Create `Sentinel Payment Integrity` Genie Space.

### Tables

`mv_payment_risk` (canonical risk metric view over `gold_open_queue` — improper exposure / flagged count / recommendations — defined in `02-uc-governance.md`), `gold_open_queue` (per-payment current flags: n_signals, signal_list, risk_level, improper_exposure, recommendation — used for queue listing + drill-downs), `gold_disposition_recommendations` (the ranked disposition per flagged payment + predicted recovery $ — built by the pipeline heuristic in `01-lakeflow.md`, optionally by the ML model in `03-ml-disposition.md`), `raw_beneficiaries` (beneficiary master + signal tags), `raw_payment_fraud_flags` (per-flag detail).

### Self-sufficient room

Anyone opening the Genie room must understand the story without prior context. Wire all three:

- **Space `description`** (set via `PATCH /api/2.0/genie/spaces/<id>`): 1-3 sentences naming the event (cross-agency fraud feed + eligibility refresh → spike of high-risk flagged payments ~3w ago) + the headline exposure numbers + the disposition-ranking angle, pointing to the suggested questions in order. Lift it from the README.
- **Story-context `text_instruction`** at the TOP of `instructions.text_instructions[]`: WHAT HAPPENED · WHAT TO HELP PRIYA DO · TONE. ~5-8 lines. Honored every turn.
- **`sample_questions`** (chips) AND matching `example_question_sqls` walk the 7-step arc below, in the same order.

### Instructions

```
You analyze Sentinel payment-integrity data for Della Okonkwo (Deputy Commissioner for Program Integrity, non-technical).

CONTEXT: A cross-agency fraud-match feed + beneficiary eligibility-data refresh landed ~3 weeks ago and
surfaced a SPIKE of pre-disbursement payments flagged with fraud signals: duplicate identity, deceased
payee, income mismatch, benefit overlap, cross-agency fraud flag, employment mismatch, residence mismatch,
manual-review flags. This is a sudden WAVE — a new source of fraud visibility.

BASELINES: A healthy payment has 0 fraud signals. risk_level is the single signal: 'high' (2+ strong signals
or stacked signals), 'moderate' (1 moderate signal or weak + contextual risk), 'low' (0 signals or weak-only).

HEADLINE NUMBERS — always answer from mv_payment_risk (same definitions the dashboard tiles use):
- "How much improper-payment exposure are we at risk of in the queue?" → MEASURE(improper_payment_exposure_usd)
- "How many payments are flagged and recommended for investigation?" → MEASURE(investigate_recommended_count)
- "What's our queue depth?" → MEASURE(total_queue_value_usd)

INVESTIGATION FLOW for "what are we at risk of and how should we handle it?":
1. mv_payment_risk → MEASURE(improper_payment_exposure_usd) + MEASURE(flagged_payment_count) by risk_level → high-risk dominates exposure
2. gold_open_queue → the distribution of signals (which signal types trigger the flags?) + disposition recommendations
3. gold_open_queue WHERE payment_id='PAY-0000214' → the hero flagged payment; note n_signals, signal_list, recommended disposition
4. gold_disposition_recommendations → the model recommends a disposition (release/hold/investigate) + predicted recovery $
Conclude + suggest: "Want me to rank the disposition options for this payment or show the investigation backlog?"

DISPOSITION FOLLOW-UP:
- "What's the recommended action for Payment PAY-0000214?" → gold_disposition_recommendations for that payment → recommended_disposition + predicted_recovery_usd + the disposition_ranking options.
- "How much could we recover if we investigate all high-risk flagged cases?" → SUM(projected_recovery_if_investigated_usd) from gold_open_queue WHERE risk_level='high'.
- "How many flagged payments are recommended for each disposition?" → MEASURE(release_recommended_count) / MEASURE(hold_recommended_count) / MEASURE(investigate_recommended_count).
```

### Sample Questions — 7-step story arc

Ship 7 questions, in this order, each as both a chip (`config.sample_questions`) AND a curated SQL (`instructions.example_question_sqls`):

1. **Headline** — "How much improper-payment exposure are we at risk of in the current queue, and how many flagged cases do we have?" → `MEASURE(improper_payment_exposure_usd)` + `MEASURE(flagged_payment_count)` from `mv_payment_risk`.
2. **The split** — "Break down the improper-payment exposure and flagged case count by risk level." → `MEASURE(improper_payment_exposure_usd)` + `MEASURE(flagged_payment_count)` from `mv_payment_risk` GROUP BY `risk_level`.
3. **Drill to programs** — "Which benefit programs carry the highest improper-payment risk?" → `gold_open_queue` GROUP BY `program`, sum `improper_payment_exposure_usd`, count cases.
4. **The hero payment** — "Payment PAY-0000214 is flagged — how many fraud signals does it carry, and what's the recommended disposition?" → `gold_open_queue WHERE payment_id='PAY-0000214'` → `n_signals`, `signal_list`, risk_level, `improper_payment_exposure_usd`.
5. **The recommendation** — "What's the best disposition for Payment PAY-0000214, and how much could we recover if we investigate?" → `gold_disposition_recommendations` for that payment → `recommended_disposition`, `predicted_recovery_usd`, the ranked options.
6. **Portfolio recovery** — "Across all flagged cases, how much could we recover by disposition, and what % of cases is each disposition recommended for?" → `MEASURE(release_recommended_count)` / `MEASURE(hold_recommended_count)` / `MEASURE(investigate_recommended_count)` + SUM recovery by disposition from `gold_disposition_recommendations`.
7. **Signal deep-dive** — "Which fraud signals are most common in high-risk cases, and which carry the highest recovery if investigated?" → `raw_payment_fraud_flags` JOIN `gold_open_queue` WHERE risk_level='high', GROUP BY `signal`, count + sum `predicted_recovery_usd`.

### Validation

"How much improper-payment exposure do we have?" → answered from `mv_payment_risk` (`MEASURE(improper_payment_exposure_usd)`), matches the dashboard tile. "Which risk level drives the exposure?" → high-risk cases dominate. "Best disposition for Payment PAY-0000214?" → hold-for-verification or investigate (not release), with recovery $, from `gold_disposition_recommendations`. Add `genie_space_id` to `resources.json`.


## B. Dashboard

**Skill to use**: `databricks-aibi-dashboards` — read `SKILLS/databricks-aibi-dashboards/SKILL.md` before implementing. The skill owns the JSON shape, encoding rules, grid math; this spec is story-level.

Create `Sentinel Payment Integrity` dashboard. Save it at the **project root** as `./dashboard.lvdash.json`. Ship datasets **schema-less** (bare table names) so `lakeview create --dataset-catalog/--dataset-schema` inject the target — ONE file works in any catalog/schema. Link the Genie space from section A. (Save the Genie space definition at the project root too — `./genie_space.json`.)

### Why this dashboard works (design principles)

- **Two pages, one story**: page 1 is the glance — *"we've spiked in high-risk flagged payments (improper-payment exposure), most recommended for hold/investigate, recovery potential is high if we triage well."* Page 2 is the deep-dive — *"which programs/signals, which cases, and what the model recommends."*
- **One metric view + two datasets**: `mv_payment_risk` is the canonical risk layer (KPI tiles + risk-level splits — same numbers Genie uses). `gold_open_queue` powers every per-payment widget (queue list, risk rollups). `gold_disposition_recommendations` is the third dataset for the disposition-mix + projected-recovery widget.
- **A queue list is the visual hook**: full-width payment queue on page 1 (sorted by improper exposure DESC) — red high-risk cases, yellow moderate, green low. Instantly readable; shows the priority triage order. Examiner sees the worst case first (`PAY-0000214`, hero). Clicking a row opens the case memo + recommendation detail.
- **One AI showcase per page**: page 1's queue list colors by `risk_level` (the `ai_classify` markdown-risk signal from `01-lakeflow.md` is the parallel) + the disposition recommendation (model-driven or heuristic); page 2 surfaces the **disposition-recommendation mix + projected recovery by disposition** — AI-native analytics inside a dashboard.
- **Clean theme — no borders, white canvas**: widgets float on the canvas; left-aligned headers; a cohesive palette where red = high-risk/high-recovery-stake, yellow = moderate, green = low-risk, so risk is color-coded consistently.
- **Self-sufficient pages**: Row 1 of every page is a markdown `text` widget naming the event (what / when / cause / the threat) and telling the reader which widget answers which question. Lift the situation from the README.

### Theme

```
canvasBackgroundColor: #F5F7FB (light) / #0F1419 (dark)
widgetBackgroundColor: #FFFFFF (light) / #161B22 (dark)
widgetBorderColor:     same as widgetBackgroundColor (= no visible border)
fontColor:             #1F2530 (light) / #E8ECF0 (dark)
selectionColor:        #4F7CE3 (light) / #8ACAFF (dark)
visualizationColors:   ["#094074","#3C6997","#5ADBFF","#FFB020","#E5484D"]
widgetHeaderAlignment: LEFT
```

Palette runs cool → warning → alarm: deep navy → steel blue → sky cyan → amber → red. The two warm stops are semantic and pinned everywhere:

**Semantic colors (literal-hex pinned everywhere they appear, NEVER `themeColorType: position N`):**
- **High-risk / improper-payment exposure** → `#E5484D` red (the alarm — flagged high-risk cases).
- **Moderate-risk** → `#FFB020` amber (the warning — medium-signal cases).
- **Low-risk / healthy** → `#3C6997` steel blue.

**`risk_level` color pins (literal-hex on EVERY widget that colors by risk)** — Lakeview cycles the palette by result order, which differs across widgets; pinning guarantees `high` is the same red on the queue AND on the risk bars:

| risk_level | Hex |
|---|---|
| high | `#E5484D` red |
| moderate | `#FFB020` amber |
| low | `#3C6997` steel blue |

### Datasets (3 total)

| Name | Source (schema-less) | Powers |
|---|---|---|
| `ds_risk` | `SELECT program, risk_level, MEASURE(\`improper_payment_exposure_usd\`) AS improper_exposure_usd, MEASURE(\`flagged_payment_count\`) AS flagged_count, MEASURE(\`projected_recovery_if_investigated_usd\`) AS recovery_usd, MEASURE(\`payment_count\`) AS queue_depth FROM mv_payment_risk GROUP BY ALL` | 4 KPI counters + risk-level split bars |
| `ds_queue` | `SELECT payment_id, program, risk_level, n_signals, signal_list, payment_amount_usd, improper_payment_exposure_usd, projected_recovery_if_investigated_usd, recommended_disposition FROM gold_open_queue` | Payment queue list, per-signal rollups, worst-payment tables |
| `ds_dispositions` | `SELECT recommended_disposition, COUNT(*) AS case_count, SUM(projected_recovery_if_investigated_usd) AS recovery_usd FROM gold_disposition_recommendations GROUP BY recommended_disposition` | Disposition-recommendation mix + recovery by action |

**No hardcoded date/program clamps** — the global filters are the single source of scoping.

### Global filters (left panel — `PAGE_TYPE_GLOBAL_FILTERS`)

| Filter | Column | Datasets | Default |
|---|---|---|---|
| Program | `program` | ds_risk, ds_queue | All |
| Risk level | `risk_level` | ds_risk, ds_queue | All |
| Recommended disposition | `recommended_disposition` | ds_queue | All |

Each filter widget has an explicit `filterTargets[]` binding only the datasets above — **do NOT bind `ds_dispositions`** (it's a summary table; auto-binding on disposition would drop aggregate rows).

### Page 1 — Payment Queue (the glance)

**Row 1** — title markdown. *"Sentinel Payment Integrity. Della Okonkwo, Deputy Commissioner for Program Integrity. A cross-agency fraud-match feed + eligibility-data refresh ~3 weeks ago surfaced a SPIKE of high-risk pre-disbursement payments (red — highest improper-payment exposure). This dashboard tracks the queue, flags, and recommendations."*

**Row 2 — 4 × `counter`**. Source: `ds_risk`. No `period` encoding — each shows the dataset-level sum over the global filter selection.

- **Improper-payment exposure** · `SUM(\`improper_exposure_usd\`)` · `number-currency` USD compact · color `#E5484D` red · *the $ at risk if we miss fraud.*
- **Flagged payment count** · `COUNT(\`flagged_count\`)` · `number` · color `#FFB020` amber · *the cases in the triage queue.*
- **Projected recovery** · `SUM(\`recovery_usd\`)` · `number-currency` USD compact · color `#094074` navy · *the $ we could recover by investigating.*
- **Queue depth** · `SUM(\`queue_depth\`)` · `number-currency` USD compact · color `#3C6997` steel · *total $ in pre-disbursement queue.*

**Row 3 — 2 × `stacked-bar`**. Source: `ds_risk`, GROUP BY `program` and `risk_level`. 
- Left: **Risk distribution by program** · `program` (X-axis) · `improper_exposure_usd` (Y-axis, stacked) · stack by `risk_level` (color by risk) · showing which program carries the exposure.
- Right: **Flagged case count by risk level** · `risk_level` (X-axis) · `flagged_count` (Y-axis, bars) · color by risk · the triage pyramid.

**Row 4 — 1 × `table`** (the hero widget). Source: `ds_queue`, sorted by `improper_payment_exposure_usd` DESC, top 20.
- **Payment Queue (priority-ranked by improper exposure)** · columns: `payment_id` (with link to deep-dive), `program`, `risk_level` (color-coded), `n_signals` (badge), `recommended_disposition` (text), `improper_payment_exposure_usd` (currency), `projected_recovery_if_investigated_usd` (currency).
- **Hero payment `PAY-0000214` is always in the first few rows** (high improper exposure + high recommended recovery).

### Page 2 — Analytics (the deep-dive)

**Row 1** — title markdown. *"Deep Dive. Which signals drive the risk? What does the model recommend? What's the recovery potential?"*

**Row 2 — 2 × `bar` + 1 × `table`**.
- Left `bar`: **Signal frequency in flagged cases** · `raw_payment_fraud_flags` GROUP BY `signal`, count cases · `signal` (X) · count (Y) · color `#5ADBFF` cyan · showing which signal types are most common.
- Middle `bar`: **Disposition recommendation mix** · `ds_dispositions` · `recommended_disposition` (X) · `case_count` (Y, stacked or separate) · color by disposition (red=investigate, amber=hold, blue=release) · the model's ranking.
- Right `table`: **Top 10 flagged payments by recovery potential** · from `ds_queue`, sorted by `projected_recovery_if_investigated_usd` DESC · columns: `payment_id`, `program`, `risk_level`, `n_signals`, `improper_payment_exposure_usd`, `projected_recovery_if_investigated_usd`, `recommended_disposition`.

**Row 3 — 1 × `scatter`** (optional AI-native viz). 
- **Risk vs. recovery scatter** · `ds_queue` · X = `n_signals` · Y = `projected_recovery_if_investigated_usd` · point size = `payment_amount_usd` · color = `risk_level` · showing the relationship between signal count and recovery potential (should trend upward — more signals = higher recovery if improper).

### Validation

- **KPI tiles match Genie answers** — "How much improper-payment exposure?" from both the dashboard tile and Genie's answer to the same question must be identical (both read `MEASURE(improper_payment_exposure_usd)`).
- **Hero payment visible** — `PAY-0000214` is in the top 5 of the queue table (sorted by improper exposure), colored red (high-risk), with a recommended disposition (hold or investigate), and a recovery $ figure.
- **Risk distribution sensible** — high-risk cases dominate improper-payment exposure ($); disposition mix shows a 3-way split (not 100% one action).
- **Page 1 is glanceable** — a busy executive can see the 4 KPI tiles + the hero-case queue table in 5 seconds and grasp the situation.
- **Page 2 reveals** — signal frequency + disposition mix + top-recovery cases each answer a drill-down question without requiring the reader to flip back to Page 1.

Add `dashboard_name` and `genie_space_id` to `resources.json`.
