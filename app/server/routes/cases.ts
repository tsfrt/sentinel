import type { Application } from 'express';
import {
  getOpenFlag,
  getPayment,
  getRecommendation,
  listActionsForPayment,
  listPayments,
  programBreakdown,
  queueSummary,
  type RiskLevel,
} from '../db/queries/index.js';
import type { AppDb } from '../db/index.js';

/**
 * Payment-integrity read routes — the pre-disbursement flagged-payment queue,
 * KPI summary, per-program risk breakdown, and payment detail (open-flag
 * context + ranked disposition options + the case-action timeline). Drives the
 * Operations page (the Visualize layer).
 *
 * NOTE: there is NO write route here. The Act layer writes through the
 * agent's `execute_case_action` tool (the trainee's Build-3 task) →
 * app.case_actions. See APP_WORKSHOP.md.
 */

const VALID_RISK_LEVEL = ['high', 'moderate'] as const;

function strParam(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function intParam(v: unknown, fallback: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), max);
}

function parseRiskLevel(v: unknown): RiskLevel | undefined {
  const s = strParam(v);
  return s && (VALID_RISK_LEVEL as readonly string[]).includes(s)
    ? (s as RiskLevel)
    : undefined;
}

function parseStatusGroup(v: unknown): 'open' | 'all' | undefined {
  const s = strParam(v);
  return s === 'open' || s === 'all' ? s : undefined;
}

type Deps = { db: AppDb };

export function registerCaseRoutes(app: Application, deps: Deps): void {
  const { db } = deps;

  // --- GET /api/payments (the flagged-payment queue) ---------------------
  app.get('/api/payments', async (req, res) => {
    const sort = strParam(req.query.sort);
    const rows = await listPayments(db, {
      statusGroup: parseStatusGroup(req.query.statusGroup),
      riskLevel: parseRiskLevel(req.query.risk),
      program: strParam(req.query.program),
      payment: strParam(req.query.payment),
      sort: sort === 'recovery' || sort === 'exposure' ? sort : undefined,
    });
    res.json(rows);
  });

  // --- GET /api/payments/summary (KPI rollup) ----------------------------
  app.get('/api/payments/summary', async (_req, res) => {
    res.json(await queueSummary(db));
  });

  // --- GET /api/payments/by-program (risk breakdown buckets) -------------
  app.get('/api/payments/by-program', async (req, res) => {
    const rows = await programBreakdown(db, {
      riskLevel: parseRiskLevel(req.query.risk),
    });
    res.json(rows);
  });

  // --- GET /api/payments/:paymentId (detail — flag + recommendation + actions)
  app.get('/api/payments/:paymentId', async (req, res) => {
    const payment = await getPayment(db, req.params.paymentId);
    if (!payment) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const [flag, recommendation, actions] = await Promise.all([
      getOpenFlag(db, payment.paymentId),
      getRecommendation(db, payment.paymentId),
      listActionsForPayment(db, payment.paymentId),
    ]);
    res.json({ payment, flag, recommendation, actions });
  });

  // --- GET /api/programs/:program/payments (all flagged payments for a program)
  app.get('/api/programs/:program/payments', async (req, res) => {
    const rows = await listPayments(db, {
      statusGroup: 'all',
      program: req.params.program,
      limit: intParam(req.query.limit, 50, 200),
    });
    res.json(rows);
  });
}
