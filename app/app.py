"""Sentinel Payment Integrity - Action-Taking Agent App
Three layers: Visualize, Assist, Act
"""
import os, json, uuid
from datetime import datetime, timezone
import gradio as gr
import psycopg2
import psycopg2.extras
from databricks.sdk import WorkspaceClient

# ── Custom CSS ──────────────────────────────────────────────────────────────
CUSTOM_CSS = """
.header-bar {
    background: linear-gradient(135deg, #1B3A5C 0%, #2C5F8A 100%);
    padding: 24px 32px;
    border-radius: 12px;
    margin-bottom: 16px;
}
.header-bar h1 { color: #FFFFFF; margin: 0 0 4px 0; font-size: 1.8em; }
.header-bar p { color: #B8D4E8; margin: 0; font-size: 0.95em; }
.stat-card {
    background: #FFFFFF;
    border: 1px solid #E2E8F0;
    border-radius: 10px;
    padding: 16px 20px;
    text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,0.06);
}
.stat-card .stat-value { font-size: 1.6em; font-weight: 700; color: #1B3A5C; }
.stat-card .stat-label { font-size: 0.82em; color: #64748B; text-transform: uppercase; letter-spacing: 0.5px; }
.stat-card p, .stat-card span, .stat-card .prose { color: #1B3A5C !important; font-size: 1.5em; font-weight: 700; text-align: center; }
.stat-card .md { background: transparent !important; }
.risk-high { color: #DC2626; font-weight: 600; }
.risk-medium { color: #D97706; font-weight: 600; }
.risk-low { color: #059669; font-weight: 600; }
.section-title {
    font-size: 1.1em;
    font-weight: 600;
    color: #1E293B;
    border-bottom: 2px solid #E2E8F0;
    padding-bottom: 8px;
    margin-bottom: 12px;
}
.action-warning {
    background: #FEF3C7;
    border: 1px solid #F59E0B;
    border-radius: 8px;
    padding: 12px 16px;
    margin-bottom: 12px;
}
.action-warning p { color: #92400E; margin: 0; font-size: 0.9em; }
.commit-success {
    background: #D1FAE5;
    border: 1px solid #10B981;
    border-radius: 8px;
    padding: 16px;
}
.tool-btn { min-width: 140px; }
footer { display: none !important; }
"""

# ── DB Helpers ──────────────────────────────────────────────────────────────
def get_connection():
    w = WorkspaceClient()
    host = os.environ.get("PGHOST", "")
    database = os.environ.get("PGDATABASE", "databricks_postgres")
    port = int(os.environ.get("PGPORT", "5432"))
    user = os.environ.get("PGUSER", "")
    endpoint = os.environ.get("POSTGRES_ENDPOINT", "")
    resp = w.api_client.do("POST", "/api/2.0/postgres/credentials",
        body={"request_id": str(uuid.uuid4()), "endpoint": endpoint})
    return psycopg2.connect(host=host, database=database, user=user,
        port=port, password=resp["token"], sslmode="require")

def query_db(sql, params=None):
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            if cur.description:
                return [dict(r) for r in cur.fetchall()]
            conn.commit()
            return []
    finally:
        conn.close()

def execute_write(sql, params=None):
    conn = get_connection()
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params)
            conn.commit()
            if cur.description:
                return [dict(r) for r in cur.fetchall()]
            return []
    finally:
        conn.close()

# ── Queue & Stats ───────────────────────────────────────────────────────────
def get_queue_stats():
    try:
        rows = query_db("""
            SELECT
                COUNT(*) AS total_cases,
                COALESCE(SUM(improper_payment_exposure_usd), 0) AS total_exposure,
                COALESCE(SUM(projected_recovery_usd), 0) AS total_recovery,
                COUNT(*) FILTER (WHERE risk_level = 'high') AS high_risk
            FROM sentinel.cases
            WHERE status = 'pending_review'
        """)
        if rows:
            r = rows[0]
            return (
                f"{int(r['total_cases'])}",
                f"${float(r['total_exposure']):,.0f}",
                f"${float(r['total_recovery']):,.0f}",
                f"{int(r['high_risk'])}"
            )
    except Exception:
        pass
    return ("--", "--", "--", "--")

def get_live_queue():
    try:
        rows = query_db("""
            SELECT c.case_id, c.payment_id, c.program, c.risk_level,
                   c.n_signals, c.payment_amount_usd,
                   c.improper_payment_exposure_usd, c.projected_recovery_usd,
                   c.recommended_disposition,
                   ea.approval_status AS action_status,
                   ea.proposed_action
            FROM sentinel.cases c
            LEFT JOIN sentinel.examiner_actions ea
                ON ea.case_id = c.case_id
                AND ea.approval_status IN ('approved', 'pending')
            WHERE c.status = 'pending_review'
            ORDER BY c.improper_payment_exposure_usd DESC
            LIMIT 20
        """)
    except Exception as e:
        return [["Error", str(e)[:60], "", "", "", "", "", "", ""]]
    display = []
    for r in rows:
        st = r.get("action_status") or "awaiting review"
        risk = r["risk_level"].upper() if r["risk_level"] else ""
        display.append([
            r["payment_id"], r["program"], risk,
            int(r["n_signals"]),
            f"${float(r['payment_amount_usd']):,.0f}",
            f"${float(r['improper_payment_exposure_usd']):,.0f}",
            f"${float(r['projected_recovery_usd']):,.0f}",
            r["recommended_disposition"].replace("_", " ").title(),
            st.replace("_", " ").title()
        ])
    return display

def refresh_all():
    stats = get_queue_stats()
    queue = get_live_queue()
    return stats[0], stats[1], stats[2], stats[3], queue

# ── Assistant Tools ─────────────────────────────────────────────────────────
def explain_flag(payment_id):
    if not payment_id:
        return "<div style='color:#64748B;padding:20px;text-align:center'>Enter a Payment ID above and click <b>Explain Flag</b></div>"
    rows = query_db("""
        SELECT case_id, payment_id, program, risk_level, n_signals,
               signal_list, payment_amount_usd,
               improper_payment_exposure_usd, projected_recovery_usd,
               reasoning, recommended_disposition, confidence_score
        FROM sentinel.cases WHERE payment_id = %s
    """, (payment_id,))
    if not rows:
        return f"No case found for **{payment_id}**"
    c = rows[0]
    signals = c['signal_list'] if isinstance(c['signal_list'], list) else []
    conf = float(c['confidence_score']) * 100
    risk_class = f"risk-{c['risk_level']}" if c['risk_level'] in ('high','medium','low') else ""
    return (
        f"## Case Analysis: {c['payment_id']}\n\n"
        f"| Field | Value |\n|-------|-------|\n"
        f"| Program | {c['program']} |\n"
        f"| Risk Level | **{c['risk_level'].upper()}** |\n"
        f"| Signals | {c['n_signals']} - {', '.join(signals)} |\n"
        f"| Payment | ${float(c['payment_amount_usd']):,.2f} |\n"
        f"| Exposure | ${float(c['improper_payment_exposure_usd']):,.2f} |\n"
        f"| Projected Recovery | ${float(c['projected_recovery_usd']):,.2f} |\n\n"
        f"### Recommendation\n\n"
        f"**{c['recommended_disposition'].replace('_',' ').title()}** "
        f"(confidence: {conf:.0f}%)\n\n"
        f"### Reasoning\n\n{c['reasoning']}\n\n"
        f"---\n<small>Case ID: {c['case_id']}</small>"
    )

def what_if_analysis(payment_id):
    if not payment_id:
        return "<div style='color:#64748B;padding:20px;text-align:center'>Enter a Payment ID above and click <b>What-If</b></div>"
    rows = query_db("""
        SELECT payment_id, recommended_disposition, predicted_recovery_usd, confidence_score
        FROM sentinel.disposition_recommendations WHERE payment_id = %s
    """, (payment_id,))
    if not rows:
        return f"No disposition recommendation found for **{payment_id}**"
    rec = rows[0]
    exposure = query_db(
        "SELECT improper_payment_exposure_usd FROM sentinel.cases WHERE payment_id = %s",
        (payment_id,))
    exp = float(exposure[0]['improper_payment_exposure_usd']) if exposure else 0
    recv = float(rec['predicted_recovery_usd']) if rec['predicted_recovery_usd'] else 0
    conf = float(rec['confidence_score']) * 100
    return (
        f"## Scenario Analysis: {payment_id}\n\n"
        f"| Disposition | Est. Recovery | Net Impact | Hold Period |\n"
        f"|:------------|:-------------|:-----------|:------------|\n"
        f"| Release immediately | $0 | **-${exp:,.0f}** (full loss) | None |\n"
        f"| Hold for verification (48h) | ${recv:,.0f} | **+${recv-45:,.0f}** | 48 hours |\n"
        f"| Refer to investigation | ${exp:,.0f} | **+${exp-350:,.0f}** | ~30 days |\n\n"
        f"### Model Recommendation\n\n"
        f"**{rec['recommended_disposition'].replace('_',' ').title()}** "
        f"with {conf:.0f}% confidence. "
        f"Expected recovery of **${recv:,.0f}** against ${exp:,.0f} exposure."
    )

def draft_memo(payment_id):
    if not payment_id:
        return "<div style='color:#64748B;padding:20px;text-align:center'>Enter a Payment ID above and click <b>Draft Memo</b></div>"
    rows = query_db("""
        SELECT c.case_id, c.payment_id, c.program, c.risk_level,
               c.n_signals, c.signal_list, c.payment_amount_usd,
               c.improper_payment_exposure_usd, c.projected_recovery_usd,
               c.recommended_disposition, c.beneficiary_id
        FROM sentinel.cases c WHERE c.payment_id = %s
    """, (payment_id,))
    if not rows:
        return f"No case for **{payment_id}**"
    c = rows[0]
    signals = c['signal_list'] if isinstance(c['signal_list'], list) else []
    today = datetime.now(timezone.utc).strftime("%B %d, %Y")
    return (
        f"# Pre-Disbursement Verification Hold\n\n"
        f"**Date:** {today}\n\n"
        f"---\n\n"
        f"| | |\n|---|---|\n"
        f"| **Payment** | {c['payment_id']} |\n"
        f"| **Program** | {c['program']} |\n"
        f"| **Amount** | ${float(c['payment_amount_usd']):,.2f} |\n"
        f"| **Beneficiary** | {c['beneficiary_id']} |\n"
        f"| **Hold Duration** | 48 hours |\n\n"
        f"## Triggering Signals\n\n"
        + "\n".join(f"- {s.replace('_', ' ').title()}" for s in signals) + "\n\n"
        f"## Risk Assessment\n\n"
        f"- **Improper Payment Exposure:** ${float(c['improper_payment_exposure_usd']):,.2f}\n"
        f"- **Projected Recovery:** ${float(c['projected_recovery_usd']):,.2f}\n\n"
        f"## Recommended Action\n\n"
        f"Hold disbursement pending identity and eligibility verification. "
        f"Release upon clearance or escalate to investigation if unresolved within hold window.\n\n"
        f"---\n\n"
        f"*Proceed to the **Take Action** tab to approve this disposition.*"
    )

# ── Action Tab ──────────────────────────────────────────────────────────────
def approve_action(payment_id, action_type, rationale):
    if not payment_id or not action_type:
        return "Please provide a Payment ID and select a disposition."
    cases = query_db(
        "SELECT case_id, improper_payment_exposure_usd, projected_recovery_usd "
        "FROM sentinel.cases WHERE payment_id = %s", (payment_id,))
    if not cases:
        return f"No case found for **{payment_id}**"
    c = cases[0]
    action_id = f"act-{uuid.uuid4().hex[:8]}"
    now = datetime.now(timezone.utc).isoformat()
    execute_write("""
        INSERT INTO sentinel.examiner_actions
            (action_id, case_id, payment_id, proposed_action, proposed_by,
             proposed_at, approval_status, approved_by, approved_at,
             committed_at, rationale, confidence_score, exposure_usd, recovery_usd)
        VALUES (%s, %s, %s, %s, 'system', %s, 'approved',
                'examiner@sentinel.gov', %s, %s, %s, 0.95, %s, %s)
    """, (action_id, c['case_id'], payment_id, action_type, now, now, now,
          rationale or f"Approved: {action_type.replace('_',' ')}",
          float(c['improper_payment_exposure_usd']),
          float(c['projected_recovery_usd'])))
    execute_write("""
        INSERT INTO sentinel.workflow_state
            (event_type, case_id, action_id, actor, payload)
        VALUES ('action_committed', %s, %s, 'examiner@sentinel.gov', %s)
    """, (c['case_id'], action_id,
          json.dumps({"payment_id": payment_id, "action": action_type,
                      "action_id": action_id, "committed": True})))
    disp_label = action_type.replace('_', ' ').title()
    return (
        f"## Action Committed\n\n"
        f"| | |\n|---|---|\n"
        f"| **Action ID** | `{action_id}` |\n"
        f"| **Payment** | {payment_id} |\n"
        f"| **Disposition** | {disp_label} |\n"
        f"| **Committed** | {now[:19]}Z |\n"
        f"| **Exposure** | ${float(c['improper_payment_exposure_usd']):,.2f} |\n"
        f"| **Recovery** | ${float(c['projected_recovery_usd']):,.2f} |\n\n"
        f"The queue will reflect this on the next refresh."
    )

# ── UI Layout ───────────────────────────────────────────────────────────────
with gr.Blocks(
    title="Sentinel Payment Integrity",
    theme=gr.themes.Soft(
        primary_hue=gr.themes.colors.blue,
        neutral_hue=gr.themes.colors.slate,
        font=[gr.themes.GoogleFont("Inter"), "system-ui", "sans-serif"],
    ),
    css=CUSTOM_CSS,
) as app:

    # Header
    gr.HTML("""
    <div class="header-bar">
        <h1>Sentinel Payment Integrity</h1>
        <p>Pre-disbursement fraud prevention &middot; Visualize &middot; Assist &middot; Act</p>
    </div>
    """)

    # ── Tab 1: Live Queue ───────────────────────────────────────────────
    with gr.Tab("Live Queue", id="queue"):
        with gr.Row(equal_height=True):
            with gr.Column(scale=1, min_width=160):
                gr.HTML('<div class="stat-card"><div class="stat-label">Pending Cases</div></div>')
                stat_cases = gr.Markdown("--", elem_classes=["stat-card"])
            with gr.Column(scale=1, min_width=160):
                gr.HTML('<div class="stat-card"><div class="stat-label">Total Exposure</div></div>')
                stat_exposure = gr.Markdown("--", elem_classes=["stat-card"])
            with gr.Column(scale=1, min_width=160):
                gr.HTML('<div class="stat-card"><div class="stat-label">Projected Recovery</div></div>')
                stat_recovery = gr.Markdown("--", elem_classes=["stat-card"])
            with gr.Column(scale=1, min_width=160):
                gr.HTML('<div class="stat-card"><div class="stat-label">High Risk</div></div>')
                stat_high = gr.Markdown("--", elem_classes=["stat-card"])

        gr.Markdown("<p class='section-title'>Ranked Pre-Disbursement Queue</p>")
        queue_table = gr.Dataframe(
            headers=["Payment", "Program", "Risk", "Signals",
                     "Amount", "Exposure", "Recovery",
                     "Recommendation", "Status"],
            datatype=["str","str","str","number","str","str","str","str","str"],
            interactive=False,
            wrap=True,
        )
        refresh_btn = gr.Button("Refresh Queue", variant="primary", size="sm")
        refresh_btn.click(
            fn=refresh_all,
            outputs=[stat_cases, stat_exposure, stat_recovery, stat_high, queue_table]
        )

    # ── Tab 2: Assistant ────────────────────────────────────────────────
    with gr.Tab("Assist", id="assist"):
        gr.Markdown("<p class='section-title'>Case Investigation Tools</p>")
        with gr.Row():
            assist_input = gr.Textbox(
                label="Payment ID",
                placeholder="e.g. PAY-0000214",
                scale=3,
                info="Enter a payment ID from the queue to investigate"
            )
        with gr.Row():
            explain_btn = gr.Button("Explain Flag", variant="secondary", elem_classes=["tool-btn"])
            whatif_btn = gr.Button("What-If Analysis", variant="secondary", elem_classes=["tool-btn"])
            memo_btn = gr.Button("Draft Memo", variant="secondary", elem_classes=["tool-btn"])
        gr.Markdown("---")
        assist_output = gr.Markdown(
            value="<div style='color:#64748B;padding:20px;text-align:center'>Select a tool above to analyze a payment case</div>"
        )
        explain_btn.click(fn=explain_flag, inputs=assist_input, outputs=assist_output)
        whatif_btn.click(fn=what_if_analysis, inputs=assist_input, outputs=assist_output)
        memo_btn.click(fn=draft_memo, inputs=assist_input, outputs=assist_output)

    # ── Tab 3: Take Action ──────────────────────────────────────────────
    with gr.Tab("Take Action", id="action"):
        gr.Markdown("<p class='section-title'>Human-in-the-Loop Disposition</p>")
        gr.HTML("""
        <div class="action-warning">
            <p><strong>Caution:</strong> Approving an action commits a disposition to the
            case record and triggers downstream workflow events. This cannot be undone.</p>
        </div>
        """)
        with gr.Row():
            act_payment = gr.Textbox(
                label="Payment ID",
                placeholder="PAY-0000214",
                scale=2,
            )
            act_type = gr.Dropdown(
                choices=[
                    ("Hold for Verification (48h)", "hold_for_verification"),
                    ("Refer to Investigation", "refer_to_investigation"),
                    ("Release Payment", "release_payment"),
                    ("Request Documentation", "request_documentation"),
                ],
                label="Disposition",
                value="hold_for_verification",
                scale=2,
            )
        act_rationale = gr.Textbox(
            label="Rationale",
            placeholder="Dual cross-agency signals justify 48h verification hold",
            lines=2,
        )
        approve_btn = gr.Button(
            "Approve and Commit",
            variant="primary",
            size="lg",
        )
        gr.Markdown("---")
        act_output = gr.Markdown()
        approve_btn.click(
            fn=approve_action,
            inputs=[act_payment, act_type, act_rationale],
            outputs=act_output
        )

    # Load queue on start
    app.load(
        fn=refresh_all,
        outputs=[stat_cases, stat_exposure, stat_recovery, stat_high, queue_table]
    )

if __name__ == "__main__":
    app.launch(
        server_name="0.0.0.0",
        server_port=int(os.environ.get("DATABRICKS_APP_PORT", "8000")),
    )
