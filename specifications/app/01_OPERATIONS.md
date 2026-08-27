# App Specification — Payment Queue Page

The **operations hub** — the flagged-payment queue surface Della sees on every login. Live Lakebase read-only data powers the queue list; writable case-actions table powers the approval + action flow.

## Page layout

**Header:** 4 KPI cards (matching the dashboard tiles from `04-ai-bi.md`):
- **Improper-payment exposure** — `SUM(improper_payment_exposure_usd)` from the current queue filtered by risk_level (default all). Currency, red accent.
- **Flagged payments** — `COUNT(*)` of flagged cases in queue. Count, amber accent.
- **Projected recovery** — `SUM(projected_recovery_if_investigated_usd)` from cases recommended investigate/hold. Currency, navy accent.
- **Disposition breakdown** — three mini-cards showing counts of cases recommended (release / hold-for-verification / refer-to-investigation). Counts, blue/amber/red accents.

**Global filters** (left sidebar, sticky):
- Risk level (high / moderate / low) — multi-select, default all
- Program (TANF / SNAP / Child Care / Disability / Veteran's) — multi-select, default all
- Recommended disposition (release / hold / investigate) — multi-select, default all

**Main content:**

### Queue table (primary)
Sorted by improper_payment_exposure_usd DESC (worst first). Columns:
- **Payment ID** (clickable → detail drawer)
- **Program** (text, small badge)
- **Risk level** (color-coded: red/amber/blue)
- **# Signals** (badge count)
- **Amount** ($)
- **Improper exposure** ($, red text if > $500)
- **Recommended disposition** (text: release / hold-for-verification / refer-to-investigation)
- **Status** (pre-disbursement / held / released / investigating / resolved — synced from case_actions)

**Hero payment `PAY-0000214` is always in the top 3 rows** (high improper exposure + high recommended recovery).

### Detail drawer (right-side slide-over, opens on row click)
Full payment context + ranked disposition options + approval/override UI:

**Top section:**
- Payment ID, Program, Amount, Queue date
- Signal list (comma-separated with tooltips on hover: what each signal means)
- Risk level badge
- Improper-payment exposure ($)
- Beneficiary info (ID, name, enrollment date — read-only from Lakebase)

**Middle section — Ranked disposition options** (from `disposition_ranking` JSON):
Three cards, one per option, ranked by net recovery value:
- **Disposition name** (Release / Hold-for-verification / Refer-to-investigation)
- Improper probability (%)
- Projected recovery if improper ($)
- Citizen delay cost if held ($)
- Net value = recovery − delay cost ($) — the tie-breaker
- **Why this option** — AI-generated reasoning (from `reasoning` column or agent draft)

**Bottom section — Case memo + approval**:
- **Case memo** (text box, pre-filled by agent draft or `reasoning` memo scaffold)
- **Verification request** (if holding, text box: verification agency + evidence checklist + contact)
- **Approve** button (color-coded to the recommended disposition: blue=hold, red=investigate, green=release)
- **Override** link (choose a different disposition + provide override reason)
- **Activity timeline** (below memo): audit trail of previous examiner actions on this case (if any)

**On approve:**
1. Disable the button + show "Submitting..."
2. Call `execute_case_action` with memo + disposition + verification request (if applicable)
3. On success: emit `dataMutated` → queue table re-fetches
4. Close drawer and refresh the queue list — show a toast "Case action recorded"

## Queue interactions

**Sorting & filtering:** all applied client-side via Lakebase query params; KPI cards re-compute on filter change.

**Live cascade** (on `dataMutated` from agent action):
1. Re-fetch the queue list (sorted by residual improper exposure)
2. Affected payment row flips status (held → "on-hold", released → "released", etc.)
3. KPI cards re-compute (improper-payment exposure drops, disposition counts update)
4. If the affected row was open in the drawer, re-fetch its detail (status updated, timeline adds the action)

## Lakebase tables (read-only)

**`payment_position`** (synced from `gold_open_queue` in UC):
- payment_id, program, state, payment_amount_usd, queue_date, payment_status (pre_disbursement)
- n_signals, signal_list (array of signal names)
- risk_level (high / moderate / low)
- improper_payment_exposure_usd, projected_recovery_if_investigated_usd
- recommended_disposition (from `gold_disposition_recommendations`)
- confidence_score

**`disposition_recommendations`** (synced from `gold_disposition_recommendations` in UC):
- payment_id (PK)
- recommended_disposition, confidence_score, predicted_improper_probability, predicted_recovery_usd
- disposition_ranking (JSON array: [{disposition, improper_prob, recovery_usd, delay_cost, net_value}, ...])
- reasoning (memo scaffold)

## Lakebase tables (writable)

**`case_actions`** (app-created + app-writes):
- **case_action_id** (UUID, PK)
- **payment_id** (FK)
- **disposition_chosen** (release / hold_for_verification / refer_to_investigation)
- **examiner_email** (OBO auth, populated by the app)
- **case_memo** (text, examiner's notes)
- **verification_request** (text, if hold — agency + evidence checklist)
- **predicted_recovery_usd** (from the recommendation at decision time)
- **created_at** (timestamp)
- **updated_at** (timestamp)

Indexes: payment_id (for the drawer's activity timeline), created_at DESC (for the activity feed).

## Validation

- **Hero payment visible** — `PAY-0000214` in top 3 rows (high improper exposure).
- **KPI cards match dashboard** — Improper-payment exposure $ + flagged count should match the dashboard tile when filtered the same way.
- **Ranked dispositions make sense** — For a high-risk case, hold/investigate should be ranked above release in the drawer. For a low-risk case, release should be ranked above investigate.
- **Live cascade works** — Approve an action → the drawer closes, the queue table updates (row status changes, KPI cards tick), no reload needed.
