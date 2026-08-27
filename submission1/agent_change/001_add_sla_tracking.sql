-- Migration: 001_add_sla_tracking.sql
-- Author: Genie Code (coding agent)
-- Co-authored-by: Genie Code <genie-code@databricks.com>
-- Branch: dev (projects/sentinel-payments/branches/dev)
-- Promoted to: production (projects/sentinel-payments/branches/production)
-- Purpose: Add SLA tracking table to monitor case processing deadlines and escalations

-- Step 1: Create SLA tracking table on dev branch
CREATE TABLE sentinel.sla_tracking (
    sla_id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
    case_id             TEXT NOT NULL REFERENCES sentinel.cases(case_id),
    sla_type            TEXT NOT NULL CHECK (sla_type IN ('first_review', 'review_duration', 'hold_duration', 'handoff_ack')),
    threshold_seconds   INTEGER NOT NULL,
    started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deadline_at         TIMESTAMPTZ NOT NULL,
    resolved_at         TIMESTAMPTZ,
    breached            BOOLEAN DEFAULT FALSE,
    escalated_to        TEXT,
    notes               TEXT
);

-- Step 2: Partial index for efficient deadline queries on unresolved SLAs
CREATE INDEX idx_sla_deadline ON sentinel.sla_tracking(deadline_at) WHERE resolved_at IS NULL;

-- Step 3: Enable replication for reverse Lakehouse Sync
ALTER TABLE sentinel.sla_tracking REPLICA IDENTITY FULL;

-- Step 4: Seed SLA entries for pending_review cases
INSERT INTO sentinel.sla_tracking (case_id, sla_type, threshold_seconds, deadline_at, notes)
SELECT case_id, 'first_review',
       CASE WHEN risk_level = 'high' THEN 14400 ELSE 86400 END,
       created_at + CASE WHEN risk_level = 'high' THEN INTERVAL '4 hours' ELSE INTERVAL '24 hours' END,
       'Auto-created SLA for ' || risk_level || '-risk case'
FROM sentinel.cases
WHERE status = 'pending_review'
LIMIT 20;

-- Validation query (run after migration):
-- SELECT sla_type, COUNT(*), MIN(deadline_at) FROM sentinel.sla_tracking GROUP BY sla_type;
-- Expected: first_review | 20 | <4h from now for high-risk cases>
