# App Specification — Overview, Home & Assistant

> **Build-time note.** Read `DEMO_SKILL_DIR/app/app.md` FIRST and follow it end-to-end (rsync template → customize → Lakebase → env → smoke test → deploy). This is **not** a from-scratch build: the template at `DEMO_SKILL_DIR/app/app_template/` is a Node.js + React + Express (`@databricks/appkit`) app with Lakebase, agent streaming, MLflow tracing, OBO auth, chat dock, and scripted demo chain already wired. Rsync it into `PROJECT/app/`, read `TEMPLATE_MAP.md` for what's preserved vs customized, then rewrite domain pieces (home narrative, agent tools, Lakebase schema, analytics SQL, theming) to match this story. On conflict: `app.md` governs *how*, this spec governs *what*.

> **This app maps 1:1 to the enablement build arc.** It is the concrete shape of the three-milestone challenge: **Build 1 (Lakebase)** = the data model in `03_DATA_MODEL.md` (a synced read-only payment queue table + a writable case-actions table); **Build 2 (Databricks Apps)** = this app's three layers **Visualize → Assist → Act**; **Build 3 (Unity AI Gateway)** = the assistant's model calls run through the Gateway (spend cap, guardrails, per-case attributable inference logging) — talk-track in the app, the "hero question" the whole thing answers is *"Payment PAY-0000214 is flagged with fraud signals — should I hold it, release it, or investigate?"*.

## Pitch

AI assistant that **investigates a flagged payment, ranks the best disposition, and executes it** in one conversation — not just answers questions. Della watches every step happen live: the assistant asks Genie to investigate why Payment PAY-0000214 is flagged (what signals triggered it?), reads the live Lakebase payment + fraud-signal context, then **looks up the ranked disposition recommendation** (`app.disposition_recommendations`, mirrored from the `gold_disposition_recommendations` table the SDP pipeline builds via a heuristic — optionally replaced by an ML model, `03-ml-disposition.md`) to rank the three plays — release to disburse / hold for verification / refer to investigation — each with citizen delay cost, projected recovery, and improper-payment risk. It explains *why* hold-for-verification wins (multiple strong fraud signals + high amount = 78% improper probability, $962 projected recovery justifies 3-day hold), offers a what-if, drafts the verification request + case memo, and **stops for approval**. Della approves → the case action + memo write to Lakebase → the Payment Queue + KPI tiles tick live. Every action is traced in MLflow and every model call is governed by Unity AI Gateway.

## Databricks capabilities mapped

| Capability | Where it shows |
|-----------|---------------|
| **Lakebase** | The read surface (synced read-only `payment_queue` for low-latency per-payment reads) AND the write surface (writable `case_actions` — the app records approved holds/releases/investigations here). Same UC governance as Delta. |
| **AI/BI Genie** | `ask_data` tool routes the "why is this payment flagged?" investigation to the Genie space; reasoning streams into the Thinking panel. |
| **ML model (UC-registered)** | The `disposition_recommender` model's batch output feeds the agent's ranking — `app.disposition_recommendations(payment_id, recommended_disposition, predicted_improper_probability, predicted_recovery_usd, disposition_ranking, …)` is one of the mirrored tables. The app never calls the model directly; it reads the predictions. |
| **AI Functions (`ai_classify`)** | Signal classification (fraud/eligibility/administrative) + case-priority scoring in SDP, mirrored on the payment row. The queue is sortable by risk_level. |
| **Unity AI Gateway** | The assistant's model endpoint is registered through the Gateway — spend cap (~$2M/yr bounded), content-filter guardrails, every call logged to a UC inference table and attributable **per case**. Talk-track surfaced via a small "AI spend" panel/link. |
| **MLflow tracing** | Per-turn traces with tool spans. Thumbs up/down → human assessments on traces. |
| **Databricks Apps** | SSO, OBO auth (actions stamped with Della's email), secrets, auto-scaling. |
| **AI/BI Dashboards** | Embedded as an iframe with SSO — the payment-risk dashboard from `04-ai-bi.md`. |

## Pages

| Page | Purpose | Key capability |
|------|---------|---------------|
| **Home** | Narrative landing — story, persona, journey diagram, starter chips, featured action card, activity feed | Config-driven (`config/app.json`) |
| **Payment Queue** | The flagged-payment surface — a prioritized queue list + KPI cards (Improper-payment exposure / Flagged count / Projected recovery / Disposition breakdown), detail drawer with the ranked disposition options + Approve/Override + case memo + activity timeline | **Lakebase** OLTP |
| **Analytics** | Warehouse-backed charts: case history trends (disposition vs. improper outcome), signal-type breakdown, recovery by disposition | **SQL Warehouse** on Delta |
| **Dashboard** | Embedded AI/BI dashboard iframe (from `04-ai-bi.md`) | **AI/BI Dashboards** |

## Assistant

Lives on every page. Two surfaces, one brain:
- **Floating dock** (bottom-right) — persistent conversation per user (`kind='demo_dock'`), survives navigation. Hidden on the full-page chat route.
- **Full-page chat** — for longer conversations or reviewing history.

### The three layers (Visualize / Assist / Act)

This is the enablement arc rendered in the app:
- **Visualize** (Payment Queue page) — the live payment queue makes the important thing obvious at a glance: red high-risk cases (stacked signals + high recovery potential) next to yellow moderate and green low-risk. Reads synced Lakebase payment data.
- **Assist** (the agent) — a chat assistant that explains why a payment is flagged, ranks the best disposition, and offers a what-if. Reads the disposition model's recommendation + the live payment + fraud-signal context.
- **Act** (the write) — after human approval, the app writes the chosen disposition (hold/release/investigate) + case memo + verification request to the writable Lakebase `case_actions` table; the Payment Queue cascades.

### Thinking panel
Top-right floating panel, streams live during agent turns: reasoning steps, the Genie investigation ("querying payment flags", "analyzed improper probability"), tool calls with inputs/results. Persisted on the message as `thinking[]` JSONB → survives reload (collapsed "Reasoning · N tools" toggle).

### Human-in-the-loop
**Read-only queries** — assistant calls Genie / reads Lakebase, synthesizes an answer. No side effects.

**Action chains** — strict 3-phase:
1. **Discover** — read the flagged payment (payment_id, program, amount, n_signals, signal_list), read the fraud-signal context, **look up the ranked disposition recommendation** for this payment (read-only).
2. **Draft + confirm** — present the ranked options (release / hold-for-verification / refer-to-investigation) each with citizen delay cost, improper probability, projected recovery; recommend the top one and explain why; offer a what-if ("what if we hold 5 days instead of 3?"); draft the case memo + verification request → **STOP, wait for approval**.
3. **Execute** (after "yes") — write the approved disposition to `case_actions` (records disposition, case memo, risk_level, predicted recovery, examiner email), append an audit entry — one atomic write.

### Agent tools (Sentinel)

The agent has five tools, chained so the demo loop is visible: (1) **ask Genie** to investigate, (2) **read Lakebase** for the live payment + fraud-signal context, (3) **search a benefits playbook** to find verification guidance matching the case + signal type, (4) **read the ML recommendation** in Lakebase to rank the disposition, (5) **write Lakebase** atomically after approval.

| Tool | What it does | Phase |
|------|-------------|-------|
| `ask_data` | Delegates to the Genie space — investigates the flagged payment over the governed lakehouse (fraud signals, improper probability from history), streams reasoning to the Thinking panel | Investigation |
| `get_payment` | Queries Lakebase: the open flagged payment for a `{payment_id}` (or the worst flagged case) — amount_usd, program, n_signals, signal_list, risk_level, improper_payment_exposure_usd, projected_recovery_if_investigated_usd | Discovery |
| `search_playbook` | Queries Lakebase Search over a benefits-reference table (e.g., `reference_playbooks` or `verification_guides` — name TBD) indexed on case notes + signal types — returns ranked verification guidance, cross-agency contact info, required evidence, typical resolution time. **Powers the "evidence docket" + verification-request drafting** — when ranking dispositions, if "hold-for-verification" is recommended, the agent calls this to auto-fill the verification request with the right agency + evidence checklist. Uses hybrid text/vector retrieval over the reference table indexed in Lakebase Postgres. | Discovery (hold context) |
| `rank_disposition` | Queries Lakebase `app.disposition_recommendations` for the `{payment_id}` — returns the model's `recommended_disposition`, `predicted_improper_probability`, `predicted_recovery_usd`, and the full `disposition_ranking` (all three options with their improper-%, recovery $, delay cost). **This is the demo's "ML in the loop" moment** — the agent quotes the ranked options + the recommended disposition in the draft, and recomputes the what-if arithmetically from `disposition_ranking`. | Discovery |
| `execute_case_action` | Bulk/atomic write to Lakebase `app.case_actions`: records the approved disposition (disposition_chosen, payment_id, case_memo, verification_request, predicted_recovery_usd, examiner_email), appends an audit entry. Inputs are a FILTER (`{payment_id, disposition_chosen, memo_text, verification_request?}`) — never a list of IDs. | Execution (requires approval) |

> **Write tools must trigger a visible UI refresh.** `execute_case_action` MUST publish a `dataMutated` event on commit. The Payment Queue page subscribes and refetches: the Improper-payment-exposure KPI ticks down (by the recovered $), the Flagged-count KPI ticks, the affected payment row flips to "hold in progress" or "investigating" and gains a status badge, the queue re-sorts by residual improper exposure, and any open drawer re-fetches its activity timeline. The user must **see** the queue change without reloading — that live cascade is the moment the demo lands.

## Home page

Narrative landing — tells the story in 10s, plays it in 90s.

**Story section:** Persona badge ("Della Okonkwo · Deputy Commissioner for Program Integrity · Sentinel"), headline ("Fraud alert spike: $280M queue at risk"), situation (a cross-agency fraud-match feed + eligibility refresh ~3 weeks ago surfaced a wave of flagged payments — the daily flagged rate jumped from ~5% to ~30%+, improper-payment exposure concentrated in high-risk stacked-signal cases, examiner capacity ~50/day → backlog without smart triage; *Della's director just escalated to the CFO*), goal (identify the worst high-risk cases → get a smart disposition ranking → approve holds/investigations), preview bullets.

**Journey diagram:** 4-beat horizontal strip — See the flagged queue → Payment Queue | Ask why PAY-0000214 is flagged → starts chat | Rank the disposition → the model | Approve the hold → action flow.

**Starter chips:** "What's our improper-payment exposure and how should we prioritize?" / "Why is Payment PAY-0000214 flagged with so many signals?" / "What's the best way to handle Payment PAY-0000214?" — each starts a fresh conversation.

**Featured action card:** "Get a disposition recommendation for Payment PAY-0000214 — rank hold vs release vs investigate" — one click triggers the full investigate → rank → draft → approve flow.

**Activity feed:** Live tail of agent actions ("Approved hold: Payment PAY-0000214 ($1,850 TANF), verification request drafted to SSA, estimated 3-day hold, ~$962 recovery potential", "Referred to investigation: 3 stacked-signal payments, ~$4,200 exposure", "Released: 12 low-risk moderate-signal cases, $18K queue unblocked"). Auto-refreshes.

## Scripted demo flow (~3 min)

Assistant supports a scripted chain via `config.assistantScript`. After each response, a "Suggested next" chip appears if trigger keywords are detected in the previous answer.

**Step 1 — "Why is Payment PAY-0000214 flagged, and what are my disposition options?"**
Always available. `ask_data` → Genie investigates: duplicate identity + cross-agency fraud flag (2 strong signals from the new fraud feed ~3w ago) against a $1,850 TANF payment. `get_payment` reads the live payment + signals + improper exposure ($1,480 if improper). Thinking panel shows the routing live. Suggests ranking the disposition options.

**Step 2 — "Rank the disposition options. Use the model."**
Unlocks when "flagged"/"signals"/"disposition"/"PAY-0000214" in the previous answer. Agent calls `rank_disposition` → quotes the ranked options. For **hold-for-verification**, calls `search_playbook` with a query like *"SSA duplicate identity verification process"* to find the right agency + evidence checklist → "**Hold for verification (3 days)** — $1,480 improper exposure × 78% probability = $1,155 expected recovery if improper, minus $100 delay cost to beneficiary = $1,055 net. Release: $0 recovery, $1,480 loss if improper. Investigate: $1,155 recovery, but 14-day timeline + investigation cost. Hold-for-verification wins: quick verification clears ~$1,050 net, holds $1,155 at risk." Drafts the verification request + case memo. Shows the ranked list + the what-if slider. Stops and waits.

**Step 3 — "Yes — approve the hold."**
Unlocks when "hold"/"verify"/"approve" mentioned. `execute_case_action` runs one atomic write on Lakebase: records the hold disposition + verification request + case memo + predicted recovery. Then emits `dataMutated`. On screen: the Improper-payment-exposure KPI drops by $1,155, Payment PAY-0000214's row flips to "on-hold" with a **Verification** badge, the queue re-sorts (residual exposure shifts), and any open drawer re-fetches its timeline — all without Della touching anything. **That live cascade is the story beat — confirm it works before demoing.**

**Performance:** Agent prompt steers toward narrow Genie questions (20–40s). The payment + recommendation lookups are Lakebase reads — sub-second.

All narrative config lives in `config/app.json` — persona, story, starter questions, assistantScript (with triggerAfter keywords), featuredAction, resource IDs. Read it directly.
