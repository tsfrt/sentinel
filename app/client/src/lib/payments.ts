/**
 * REST helpers for the payment-integrity domain (flagged payments, open-flag
 * context, disposition recommendations, case actions, activity feed).
 *
 * REPURPOSING THE TEMPLATE: when you swap data models, rename this file
 * to match your domain and update the imports that reference it. The TYPES
 * live in `shared/types.ts` — change those there, not here. This file should
 * only contain `fetch` calls.
 */
import { okOrThrow } from './api';
import type {
  ProgramBucket,
  RiskLevel,
  PaymentRow,
  PaymentDetail,
  QueueSummary,
  ActivityEvent,
} from '@/shared/types';

export async function fetchPayments(
  filters: {
    statusGroup?: 'open' | 'all';
    risk?: RiskLevel;
    program?: string;
    payment?: string;
    sort?: 'exposure' | 'recovery';
  } = {},
): Promise<PaymentRow[]> {
  const qs = new URLSearchParams();
  if (filters.statusGroup) qs.set('statusGroup', filters.statusGroup);
  if (filters.risk) qs.set('risk', filters.risk);
  if (filters.program) qs.set('program', filters.program);
  if (filters.payment) qs.set('payment', filters.payment);
  if (filters.sort) qs.set('sort', filters.sort);
  const res = await okOrThrow(await fetch(`/api/payments?${qs}`), '/api/payments');
  return res.json();
}

export async function fetchQueueSummary(): Promise<QueueSummary> {
  const res = await okOrThrow(
    await fetch('/api/payments/summary'),
    '/api/payments/summary',
  );
  return res.json();
}

export async function fetchProgramBreakdown(
  filters: { risk?: RiskLevel } = {},
): Promise<ProgramBucket[]> {
  const qs = new URLSearchParams();
  if (filters.risk) qs.set('risk', filters.risk);
  const res = await okOrThrow(
    await fetch(`/api/payments/by-program?${qs}`),
    '/api/payments/by-program',
  );
  return res.json();
}

export async function fetchPayment(paymentId: string): Promise<PaymentDetail> {
  const res = await okOrThrow(
    await fetch(`/api/payments/${encodeURIComponent(paymentId)}`),
    `/api/payments/${paymentId}`,
  );
  return res.json();
}

export async function fetchProgramPayments(
  program: string,
  limit = 10,
): Promise<PaymentRow[]> {
  const res = await okOrThrow(
    await fetch(`/api/programs/${encodeURIComponent(program)}/payments?limit=${limit}`),
    `/api/programs/${program}/payments`,
  );
  return res.json();
}

export async function fetchActivity(limit = 20): Promise<ActivityEvent[]> {
  const res = await okOrThrow(
    await fetch(`/api/activity/recent?limit=${limit}`),
    '/api/activity/recent',
  );
  return res.json();
}
