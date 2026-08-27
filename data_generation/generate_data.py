# Databricks notebook source
# /// script
# [tool.databricks.environment]
# environment_version = "5"
# ///
# MAGIC %md
# MAGIC # Sentinel — Improper-Payment & Pre-Disbursement Fraud Prevention · Synthetic Data Generator
# MAGIC
# MAGIC Produces the raw datasets for the Sentinel demo under `<catalog>.<schema>`
# MAGIC using Spark (Databricks Connect serverless when run locally, the runtime's
# MAGIC `spark` when run as a job). Follows the `databricks-synthetic-data-gen` skill:
# MAGIC `spark.range` + `F.when` + broadcast joins + Window + `F.element_at` against
# MAGIC literal arrays — no driver loops, no `.collect()` on big tables, no `.cache()`.
# MAGIC
# MAGIC **The load-bearing anomaly** (one fraud-signal surge, two visible symptoms): a
# MAGIC cross-agency fraud-match feed + eligibility-data refresh ~3 weeks ago surfaced a
# MAGIC spike of high-risk pre-disbursement payments. The hero payment is `PAY-0000214`
# MAGIC flagged by MULTIPLE strong signals (duplicate identity + cross-agency fraud flag)
# MAGIC → recommended disposition = **hold-for-verification**. The pattern shows a realistic
# MAGIC 3-way disposition mix: high-risk stacked-signal cases → hold/investigate; moderate
# MAGIC single-signal cases → release. See `specifications/01-lakeflow.md`.
# MAGIC
# MAGIC **This is a worked example of the technique, not a fill-in-the-blanks template** —
# MAGIC a different demo rewrites the domain, schema, and anomaly. What carries over is the
# MAGIC *shape*: Spark-native idioms + one concentrated, explainable anomaly against a
# MAGIC realistic baseline. This script writes the RAW parquet datasets only; silver + gold
# MAGIC are the SDP pipeline's job (`src/pipeline/*.sql`).

# COMMAND ----------

from __future__ import annotations

import os
from datetime import datetime, timedelta

import numpy as np
from pyspark.sql import DataFrame
from pyspark.sql import functions as F
from pyspark.sql.window import Window

# ── Config ─────────────────────────────────────────────────────────────────
# Catalog/schema are parametrized (widgets in-job, env locally) so a DAB can
# deploy this to any workspace.
IN_NOTEBOOK = "dbutils" in dir()
if IN_NOTEBOOK:
    dbutils.widgets.text("catalog", "", "Catalog")
    dbutils.widgets.text("schema", "", "Schema")
    CATALOG = dbutils.widgets.get("catalog")
    SCHEMA = dbutils.widgets.get("schema")
else:
    import argparse

    _p = argparse.ArgumentParser()
    _p.add_argument("--catalog", default=os.environ.get("DEMO_CATALOG"))
    _p.add_argument("--schema", default=os.environ.get("DEMO_SCHEMA"))
    _a, _ = _p.parse_known_args()
    CATALOG, SCHEMA = _a.catalog, _a.schema
assert CATALOG and SCHEMA, "catalog + schema required (widgets in-job, --catalog/--schema or DEMO_CATALOG/DEMO_SCHEMA locally)"

# Volume holding the raw parquet datasets — the single source of raw truth.
# The SDP silver layer reads these via read_files() (no bronze, no raw Delta).
RAW_VOL = "raw_data"

# ── Story timeline ───────────────────────────────────────────────────────────
# NOW is the single source of truth. Default is ROLLING (datetime.now()) so the
# dashboard's right edge is always yesterday-real. Set SENTINEL_PIN_TIME=1 to
# freeze for recorded demos / baked-in IDs.
STORY_PINNED_NOW = datetime(2026, 8, 1)
NOW = STORY_PINNED_NOW if os.environ.get("SENTINEL_PIN_TIME") == "1" else datetime.now()

HIST_START = NOW - timedelta(days=18 * 30)        # 18-month case history + outcomes
HIST_END = NOW - timedelta(days=1)
HIST_SPAN_DAYS = (HIST_END - HIST_START).days
FRAUD_WAVE_ONSET = NOW - timedelta(days=21)       # fraud-match feed + eligibility refresh ~3 weeks ago
RISK_SPIKE_RAMP = NOW - timedelta(days=18)        # risk signals ramp high-risk queue
SNAPSHOT_DATE = NOW - timedelta(days=1)           # the "current" payment queue snapshot
# Payments span ~8 weeks so the fraud-wave onset (~3 weeks ago) is a VISIBLE ramp
# on the daily flagged-rate trend — pre-wave weeks read as a low baseline, the last
# ~3 weeks jump. (The queue is still "current pre-disbursement"; the extra history is
# what the trend widget charts.)
QUEUE_WINDOW_START = NOW - timedelta(days=56)     # ~8 weeks of daily payment/queue history

# ── Deterministic story anchors (must match specs) ───────────────────────────
N_PAYMENTS_TOTAL = 1_100                           # typical daily queue depth ~$280M, this is payment IDs
N_HIGH_RISK = 200                                  # high-risk stacked-signal cases → hold/investigate
N_MODERATE_RISK = 150                              # moderate single-signal cases → often release
N_PROGRAMS = 5                                     # TANF, SNAP, Child Care, Disability, Veteran's

HERO_PAYMENT = "PAY-0000214"                       # The demo's spotlight: high-risk, stacked signals
HERO_PROGRAM = "TANF"                              # Hero payment is a TANF benefit

# Fraud + eligibility signal types. Each payment carries 0–N signals; stacked signals
# → high risk. The hero carries multiple strong ones.
SIGNALS = [
    "duplicate_identity", "deceased_payee", "income_mismatch",
    "benefit_overlap", "cross_agency_fraud_flag", "employment_mismatch",
    "residence_mismatch", "manual_review_flag",
]

print(f"NOW: {NOW.date()} ({'pinned' if os.environ.get('SENTINEL_PIN_TIME') == '1' else 'rolling'})")
print(f"FRAUD_WAVE_ONSET: {FRAUD_WAVE_ONSET.date()}  SNAPSHOT_DATE: {SNAPSHOT_DATE.date()}")
print(f"Hero: {HERO_PAYMENT} ({HERO_PROGRAM}); expect multiple strong signals")

# Reuse the runtime's spark when run as a job/notebook; else build a
# databricks-connect serverless session for local runs.
try:
    spark  # noqa: F821
except NameError:
    from databricks.connect import DatabricksSession

    spark = (
        DatabricksSession.builder.profile(os.environ.get("DATABRICKS_CONFIG_PROFILE", "DEFAULT"))
        .serverless(True)
        .getOrCreate()
    )

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {CATALOG}.{SCHEMA}")
spark.sql(f"CREATE VOLUME IF NOT EXISTS {CATALOG}.{SCHEMA}.{RAW_VOL}")
RAW_VOL_ROOT = f"/Volumes/{CATALOG}/{SCHEMA}/{RAW_VOL}"


def _raw_path(table: str) -> str:
    """Volume subdir for a raw dataset: strip the `raw_` prefix."""
    return f"{RAW_VOL_ROOT}/{table.removeprefix('raw_')}"


def _save(df: DataFrame, table: str) -> None:
    """Write a raw dataset as parquet FILES into the UC Volume."""
    path = _raw_path(table)
    df.write.mode("overwrite").parquet(path)
    n = spark.read.parquet(path).count()
    print(f"  ✓ {table:26s} rows={n:>10,}  → {path}")


# COMMAND ----------

# MAGIC %md
# MAGIC ## 1. Beneficiaries — identity + eligibility attrs
# MAGIC The hero beneficiary is flagged with MULTIPLE strong signals. Everyday beneficiaries
# MAGIC carry 0–1 signals. Signals are attached at the beneficiary + then at the payment
# MAGIC level so a single beneficiary flagged for duplicate identity creates multiple
# MAGIC flagged payments (one per payment they initiate).

# COMMAND ----------

print("\n[1/5] Generating beneficiaries...")

_PROGRAMS = ["TANF", "SNAP", "Child Care", "Disability", "Veteran's"]
_STATES = ["CA", "TX", "FL", "NY", "PA", "IL", "OH", "GA", "NC", "MI",
           "NJ", "VA", "WA", "AZ", "MA", "TN", "IN", "MD", "MO", "WI",
           "CO", "LA", "MN", "AL", "OK", "OR", "SC", "KS", "UT", "IA"]

def _build_beneficiaries() -> list[tuple]:
    rng = np.random.default_rng(seed=7)
    out: list[tuple] = []
    # The hero beneficiary (index 213 → BEN-0000214) carries multiple strong signals.
    # Everyday beneficiaries carry 0–1 signals; high-risk beneficiaries carry 2–3.
    for i in range(N_PAYMENTS_TOTAL):
        bid = f"BEN-{i:07d}"
        program = str(rng.choice(_PROGRAMS))
        state = str(rng.choice(_STATES))
        # Income (USD/month). High-risk: mismatch to what we have on file (the
        # income_mismatch signal), or legitimately low (disability). Everyday: in-band.
        if i == 213:
            # Hero: TANF, multiple red flags (see signal assignment below).
            income = 0.0  # unemployed (legitimate TANF)
            signals = ["duplicate_identity", "cross_agency_fraud_flag"]  # stacked strong signals
        elif i < N_HIGH_RISK:
            # High-risk: stacked signals or strong single signal.
            income = rng.uniform(100, 5000)
            signal_pool = ["duplicate_identity", "deceased_payee", "income_mismatch", "cross_agency_fraud_flag"]
            n_sig = int(rng.integers(2, 4))  # 2–3 signals per high-risk
            signals = list(rng.choice(signal_pool, n_sig, replace=False))
        else:
            # Moderate/low-risk: 0–1 signal.
            income = rng.uniform(500, 8000)
            if rng.random() < 0.15:  # 15% carry a single moderate signal
                signals = [str(rng.choice(["employment_mismatch", "residence_mismatch", "manual_review_flag"]))]
            else:
                signals = []
        open_date = (NOW - timedelta(days=int(rng.integers(100, 2000)))).date().isoformat()
        out.append((bid, program, state, income, " | ".join(signals) if signals else None, open_date))
    return out

bens_rows = _build_beneficiaries()
bens_df = spark.createDataFrame(
    bens_rows,
    "beneficiary_id string, program string, state string, monthly_income_usd double, "
    "signal_tags string, enrollment_date string",
).withColumn("enrollment_date", F.to_date("enrollment_date"))
_save(bens_df, "raw_beneficiaries")

# Beneficiary signal lookup (driver-side; small).
BEN_SIGNALS = {r[0]: set(r[4].split(" | ")) if r[4] else set() for r in bens_rows}
BEN_HERO = bens_rows[213] if len(bens_rows) > 213 else bens_rows[0]

# COMMAND ----------

# MAGIC %md
# MAGIC ## 2. Payment claims — the source of each pre-disbursement case
# MAGIC A claim triggers a payment. Each claim carries amount + program + beneficiary +
# MAGIC initial claim date. We generate a realistic distribution; the hero claim is for
# MAGIC the hero beneficiary.

# COMMAND ----------

print("\n[2/5] Generating payment claims...")

_CLAIM_TYPES = ["recertification", "new_application", "supplemental", "adjustment", "correction"]

N_CLAIMS = int(N_PAYMENTS_TOTAL * 1.1)  # more claims than payments (some denied, some combined)

def _build_claims() -> list[tuple]:
    rng = np.random.default_rng(seed=42)
    out: list[tuple] = []
    for i in range(N_CLAIMS):
        cid = f"CLM-{i:08d}"
        # Map most claims to existing beneficiaries; leave some unmatched for error signal.
        if i % 20 == 0:  # 5% unmatched (error signal)
            bid = f"BEN-{rng.integers(N_PAYMENTS_TOTAL, N_PAYMENTS_TOTAL + 100):07d}"
        else:
            bid = f"BEN-{rng.integers(0, N_PAYMENTS_TOTAL):07d}"
        claim_type = str(rng.choice(_CLAIM_TYPES))
        # Amount: program-dependent (TANF ~$400–1200, SNAP ~$150–600, Child Care ~$800–2000, etc.).
        program_amount_ranges = {
            "TANF": (400, 1200), "SNAP": (150, 600), "Child Care": (800, 2000),
            "Disability": (600, 1500), "Veteran's": (1000, 3500),
        }
        program = [p for bid_num in [int(bid.split("-")[1])] for p in _PROGRAMS if _PROGRAMS.index(p) == bid_num % len(_PROGRAMS)]
        if not program:
            program = ["TANF"]
        lo, hi = program_amount_ranges.get(program[0], (300, 1500))
        amount_usd = float(rng.uniform(lo, hi))
        claim_date = (NOW - timedelta(days=int(rng.integers(0, 60)))).date().isoformat()
        out.append((cid, bid, claim_type, amount_usd, claim_date))
    return out

claims_rows = _build_claims()
claims_df = spark.createDataFrame(
    claims_rows,
    "claim_id string, beneficiary_id string, claim_type string, claim_amount_usd double, claim_date string",
).withColumn("claim_date", F.to_date("claim_date"))
_save(claims_df, "raw_claims")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 3. Payments — pre-disbursement queue with matched claims
# MAGIC Each payment is a queued disbursement: beneficiary → claim → amount → in queue
# MAGIC now (pre-disbursement). The hero payment is high-amount and carries multiple
# MAGIC fraud signals from the hero beneficiary.

# COMMAND ----------

print("\n[3/5] Generating pre-disbursement payments...")

def _build_payments() -> list[tuple]:
    rng = np.random.default_rng(seed=51)
    out: list[tuple] = []
    claim_idx = 0
    for i in range(N_PAYMENTS_TOTAL):
        pid = f"PAY-{i:07d}"
        if i == 214:  # Hero payment (1-indexed in display; 0-indexed here)
            bid = BEN_HERO[0]
            cid = f"CLM-{rng.integers(0, min(100, len(claims_rows))):08d}"
            amount_usd = 1850.0  # high amount + stacked fraud signals = hold-for-verification
        else:
            bid = f"BEN-{rng.integers(0, N_PAYMENTS_TOTAL):07d}"
            cid = f"CLM-{claim_idx % len(claims_rows):08d}"
            claim_idx += 1
            amount_usd = float(rng.uniform(200, 3500))
        # Hero sits in the recent post-wave window (last ~5 days) so it keeps both
        # strong signals + shows in the current queue; others spread across ~8 weeks.
        day_offset = int(rng.integers(0, 5)) if i == 214 else int(rng.integers(0, 56))
        queue_date = (NOW - timedelta(days=day_offset)).date().isoformat()
        # Status: pre-disbursement (not yet paid).
        out.append((pid, bid, cid, amount_usd, queue_date, "pre_disbursement"))
    return out

payments_rows = _build_payments()
payments_df = spark.createDataFrame(
    payments_rows,
    "payment_id string, beneficiary_id string, claim_id string, payment_amount_usd double, "
    "queue_date string, payment_status string",
).withColumn("queue_date", F.to_date("queue_date"))
_save(payments_df, "raw_payments")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 4. Fraud signals + payment flags — the anomaly
# MAGIC Each payment inherits the fraud signals from its beneficiary (if any) + gets a
# MAGIC random smattering of additional signals. The FRAUD_WAVE_ONSET marks when the
# MAGIC new cross-agency fraud feed started (flagging old cases too), creating the spike.
# MAGIC High-risk: 2+ signals. Moderate: 1 signal. Low: 0 signals.

# COMMAND ----------

print("\n[4/5] Generating fraud signals + payment flags...")

# raw_payment_fraud_flags: one row per (payment, signal). Each payment INHERITS its
# beneficiary's designed signals (BEN_SIGNALS) — this keeps the cohorts real: the hero
# carries its two strong signals, high-risk beneficiaries their 2–4, moderate a single
# weak one, low none.
#
# The FRAUD_WAVE_ONSET makes the "spike ~3 weeks ago" TRUE and VISIBLE on the trend:
# the cross-agency feed only started ~3 weeks ago, so it's what SURFACES most flags.
#   • Post-wave payments (queue_date ≥ onset): signals surface fully → high flagged rate.
#   • Pre-wave payments: the feed wasn't running, so most designed signals stay LATENT
#     (only ~15% surface — the baseline pre-feed detection) → low flagged rate.
# Net effect: a clear step-up in daily flagged rate at the onset (~weeks 1–5 low,
# last ~3 weeks high). The hero payment is pinned post-wave (see _build_payments), so
# it keeps both strong signals and sits in the current queue.
def _build_flag_rows() -> list[tuple]:
    rng = np.random.default_rng(seed=61)
    wave = FRAUD_WAVE_ONSET.date().isoformat()
    rows: list[tuple] = []
    fid = 0
    for pid, bid, _cid, _amt, qdate, _st in payments_rows:
        designed = set(BEN_SIGNALS.get(bid, set()))
        post_wave = qdate >= wave
        if post_wave:
            sigs = set(designed)  # feed is live → all designed signals surface
        else:
            # Pre-feed baseline: only ~15% of designed signals were caught back then.
            sigs = {s for s in designed if rng.random() < 0.15}
        for s in sorted(sigs):
            rows.append((f"FLG-{fid:08d}", pid, s))
            fid += 1
    return rows

flag_rows = _build_flag_rows()
signals_df = spark.createDataFrame(
    flag_rows, "flag_id string, payment_id string, signal string"
)
_save(signals_df, "raw_payment_fraud_flags")
print(f"   fraud flags: {len(flag_rows)} (payment,signal) rows across {len({r[1] for r in flag_rows})} flagged payments")

# COMMAND ----------

# MAGIC %md
# MAGIC ## 5. Disposition outcomes history — training data for the model
# MAGIC 18 months of historical cases with outcomes (which disposition was chosen,
# MAGIC recovery outcome). Shapes the model's learning: stacked signals → investigate;
# MAGIC single weak signals → release; moderate → hold-for-verification.

# COMMAND ----------

print("\n[5/5] Generating disposition outcomes history...")

_DISPOSITIONS = ["release", "hold_for_verification", "refer_to_investigation"]

outcomes_df = (
    spark.range(0, 8_000)
    .withColumn("case_id", F.concat(F.lit("CASE-"), F.lpad((F.col("id") + 1).cast("string"), 8, "0")))
    .withColumn("beneficiary_id", F.concat(F.lit("BEN-"), F.lpad((F.rand(81) * 10000).cast("int").cast("string"), 7, "0")))
    .withColumn("case_date", F.date_sub(F.lit(HIST_END.date().isoformat()).cast("date"), (F.rand(82) * HIST_SPAN_DAYS).cast("int")))
    .withColumn("amount_usd", 100 + F.rand(83) * 3000)
    .withColumn("n_signals", (F.rand(84) * 5).cast("int"))
    .withColumn(
        "disposition_chosen",
        F.when(F.col("n_signals") >= 3, F.lit("refer_to_investigation"))
        .when(F.col("n_signals") >= 2, F.element_at(F.array(F.lit("hold_for_verification"), F.lit("refer_to_investigation")), (F.rand(85) * 2 + 1).cast("int")))
        .when(F.col("n_signals") == 1, F.element_at(F.array(F.lit("release"), F.lit("hold_for_verification")), (F.rand(86) * 2 + 1).cast("int")))
        .otherwise(F.lit("release")),
    )
    .withColumn("was_improper", F.when(F.col("n_signals") >= 2, F.rand(87) < 0.85).otherwise(F.rand(88) < 0.08))
    .withColumn(
        "recovery_amount_usd",
        F.when(F.col("was_improper"), F.round(F.col("amount_usd") * F.rand(89), 2)).otherwise(F.lit(0.0)),
    )
    .withColumn("days_to_resolution", (1 + F.rand(90) * 30).cast("int"))
    .select(
        "case_id", "beneficiary_id", "case_date", "amount_usd", "n_signals",
        "disposition_chosen", "was_improper", "recovery_amount_usd", "days_to_resolution",
    )
)
_save(outcomes_df, "raw_disposition_outcomes")

# COMMAND ----------

# MAGIC %md
# MAGIC ## Done
# MAGIC Five raw datasets written to the Volume. Next: run the SDP pipeline
# MAGIC (`src/pipeline/*.sql`) to build silver + gold, then the metric view, the disposition
# MAGIC model (`src/ml/disposition_train_score.py`), the dashboard, and the Genie space.
# MAGIC Validate against `specifications/01-lakeflow.md` Section C before publishing.

# COMMAND ----------

print("\n✅ Sentinel raw data generated.")
print(f"   Catalog/schema: {CATALOG}.{SCHEMA}")
print(f"   Hero payment: {HERO_PAYMENT} (beneficiary={BEN_HERO[0]}, program={HERO_PROGRAM})")
print(f"   High-risk payments (stacked signals): ~{N_HIGH_RISK}  Moderate-risk: ~{N_MODERATE_RISK}")
if IN_NOTEBOOK:
    import json

    dbutils.notebook.exit(json.dumps({
        "catalog": CATALOG, "schema": SCHEMA,
        "hero_payment": HERO_PAYMENT, "hero_beneficiary": BEN_HERO[0], "hero_program": HERO_PROGRAM,
        "high_risk_count": N_HIGH_RISK, "moderate_risk_count": N_MODERATE_RISK,
    }))