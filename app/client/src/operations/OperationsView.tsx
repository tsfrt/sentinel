/**
 * The Operations page — the WRITE SURFACE for the use case.
 *
 * Template intent: every use case has a "work queue" — rows waiting for a
 * decision + an audit trail of what happened. This page renders the
 * pre-disbursement flagged-payment queue from Lakebase (live, writable,
 * transactional) and stays in sync with the agent's actions via the
 * `dataMutated` pub/sub (when the chat stream completes, the queue refetches —
 * so you literally WATCH the agent's case-action writes land here).
 *
 * Responsibility: orchestration only — owns filter/selection state, fetches
 * data, subscribes to `dataMutated`. Sub-components render the pieces:
 *
 *    KpiCards        — improper-payment exposure / projected recovery / flagged
 *    FlaggedTable    — filterable queue, click a row to open the drawer
 *    PaymentDrawer   — slide-over with 3 tabs (Flag / Program / Activity)
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Sparkles, ArrowRight } from 'lucide-react';
import { fetchPayments, fetchQueueSummary } from '@/lib/payments';
import { useSession } from '@/lib/api';
import { dataMutated } from '@/lib/events';
import { dockController } from '@/chat/dockController';
import type { PaymentRow, RiskLevel, QueueSummary } from '@/shared/types';

import { KpiCards } from './KpiCards';
import { ShortfallTable as FlaggedTable } from './ShortfallTable';
import { PositionDrawer as PaymentDrawer } from './PositionDrawer';
import { IngestionFlow } from '@/architecture/IngestionFlow';

export function OperationsView() {
  const [searchParams, setSearchParams] = useSearchParams();
  const programFromUrl = searchParams.get('program') ?? '';
  const paymentFromUrl = searchParams.get('payment') ?? '';

  const [filter, setFilter] = useState<RiskLevel | 'all' | 'in_review'>(
    (searchParams.get('risk') as RiskLevel | 'in_review' | null) ?? 'all',
  );
  const [programFilter, setProgramFilter] = useState(programFromUrl);
  const [paymentFilter, setPaymentFilter] = useState(paymentFromUrl);
  const [sort, setSort] = useState<'exposure' | 'recovery'>(
    (searchParams.get('sort') as 'exposure' | 'recovery') ?? 'exposure',
  );
  const [search, setSearch] = useState('');

  // Sync all queue filters → URL so deep links + back/forward work.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDelete = (key: string, value: string | null) => {
      if (value) next.set(key, value);
      else next.delete(key);
    };
    setOrDelete('program', programFilter || null);
    setOrDelete('payment', paymentFilter || null);
    setOrDelete('risk', filter === 'all' ? null : filter);
    setOrDelete('sort', sort === 'exposure' ? null : sort);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [programFilter, paymentFilter, filter, sort]);

  // Update state when URL changes (e.g. user clicks a link from Analytics).
  useEffect(() => {
    const urlProgram = searchParams.get('program') ?? '';
    if (urlProgram !== programFilter) setProgramFilter(urlProgram);
    const urlPayment = searchParams.get('payment') ?? '';
    if (urlPayment !== paymentFilter) setPaymentFilter(urlPayment);
    const urlRisk = (searchParams.get('risk') as RiskLevel | 'in_review' | null) ?? 'all';
    if (urlRisk !== filter) setFilter(urlRisk);
    const urlSort = (searchParams.get('sort') as 'exposure' | 'recovery') ?? 'exposure';
    if (urlSort !== sort) setSort(urlSort);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [summary, setSummary] = useState<QueueSummary | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { config } = useSession();

  async function reload() {
    setLoading(true);
    try {
      const riskParam: RiskLevel | undefined =
        filter === 'high' || filter === 'moderate' ? filter : undefined;
      const [list, sum] = await Promise.all([
        fetchPayments({
          statusGroup: 'all',
          risk: riskParam,
          program: programFilter || undefined,
          payment: paymentFilter || undefined,
          sort,
        }),
        fetchQueueSummary(),
      ]);
      setRows(list);
      setSummary(sum);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, programFilter, paymentFilter, sort]);

  useEffect(() => {
    return dataMutated.subscribe(() => {
      void reload();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, programFilter, paymentFilter, sort]);

  // Client-side "in review" filter (payments with a recorded case action) + search.
  const filteredRows = useMemo(() => {
    let result = rows;
    if (filter === 'in_review') {
      result = result.filter((r) => r.liveDisposition !== null);
    }
    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (r) =>
          (r.paymentId ?? '').toLowerCase().includes(q) ||
          (r.program ?? '').toLowerCase().includes(q) ||
          (r.signals ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rows, filter, search]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-8 py-6 sm:py-10 space-y-6 sm:space-y-8">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-4 lg:items-end">
          <div className="flex flex-col gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-2">
                Program integrity — pre-disbursement queue
              </div>
              <h1 className="display text-4xl font-semibold tracking-tight text-foreground mb-2">
                Work the flagged-payment queue.
              </h1>
            </div>
            <p className="text-muted-foreground max-w-2xl">
              Every flagged payment is public money about to disburse. Hold the
              likely-improper ones for verification, refer the worst to
              investigation, and release the clean ones so beneficiaries aren't delayed.
            </p>
            {config?.assistantScript?.[0] && (
              <button
                onClick={() =>
                  dockController.openAndSend(config.assistantScript[0].prompt)
                }
                className="w-full text-left rounded-xl border border-border bg-card hover:border-foreground/30 hover:shadow-sm px-5 py-4 transition-all flex items-center gap-4 group"
              >
                <div
                  className="size-10 rounded-full flex items-center justify-center shrink-0"
                  style={{
                    background: 'var(--primary)',
                    color: 'var(--primary-foreground)',
                  }}
                >
                  <Sparkles className="size-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                    Ask the assistant
                  </div>
                  <div className="text-sm font-medium text-foreground mt-0.5">
                    About this fraud-flag spike
                  </div>
                </div>
                <ArrowRight className="size-4 text-muted-foreground group-hover:text-foreground transition-colors shrink-0" />
              </button>
            )}
          </div>
          <IngestionFlow />
        </div>

        {summary && <KpiCards summary={summary} />}

        <FlaggedTable
          rows={filteredRows}
          loading={loading}
          error={error}
          statusFilter={filter}
          onStatusFilter={setFilter}
          search={search}
          onSearch={setSearch}
          program={programFilter || undefined}
          onProgramFilter={(p) => setProgramFilter(p ?? '')}
          sort={sort}
          onSortChange={setSort}
          onSelect={setSelectedId}
        />
      </div>

      <PaymentDrawer
        id={selectedId}
        open={selectedId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        onMutated={() => {
          setSelectedId(null);
          void reload();
        }}
      />
    </div>
  );
}
