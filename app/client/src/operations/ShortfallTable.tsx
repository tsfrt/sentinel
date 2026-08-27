/**
 * The filterable flagged-payment queue table. Risk filter chips + search +
 * the row list itself. Click a row → opens the case detail drawer. Rows whose
 * disposition changed between dataMutated refetches pulse a soft primary
 * highlight (1.5s) so the user's eye lands on what the agent just flipped.
 *
 * (Named `ShortfallTable`/exported as such for import stability; the
 * OperationsView imports it aliased as `FlaggedTable`.)
 */
import { Search } from 'lucide-react';
import { usePulseOnChange } from '@/lib/usePulseOnChange';
import type { PaymentRow, RiskLevel } from '@/shared/types';
import { RiskBadge, DispositionBadge } from '@/shared/badges';

type StatusFilter = RiskLevel | 'all' | 'in_review';
type SortKey = 'exposure' | 'recovery';

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'high', label: 'High risk' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'in_review', label: 'In review' },
];

const usd = (v: number | null): string =>
  v === null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

function SortHeader({
  label,
  active,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  align?: 'left' | 'right';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 ${
        align === 'right' ? 'flex-row-reverse' : ''
      } ${active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'} transition-colors cursor-pointer`}
    >
      {label}
      <span className="text-[10px]" aria-hidden>
        {active ? '↓' : '↕'}
      </span>
    </button>
  );
}

type Props = {
  rows: PaymentRow[];
  loading: boolean;
  error: string | null;
  statusFilter: StatusFilter;
  onStatusFilter: (s: StatusFilter) => void;
  search: string;
  onSearch: (s: string) => void;
  program?: string;
  onProgramFilter?: (p: string | null) => void;
  sort: SortKey;
  onSortChange: (s: SortKey) => void;
  onSelect: (id: string) => void;
};

export function ShortfallTable({
  rows,
  loading,
  error,
  statusFilter,
  onStatusFilter,
  search,
  onSearch,
  sort,
  onSortChange,
  onSelect,
}: Props) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="tablist"
          aria-label="Risk filter"
          className="relative inline-flex rounded-full border border-border bg-card p-0.5 text-sm"
        >
          {STATUS_TABS.map((s) => {
            const active = statusFilter === s.value;
            return (
              <button
                key={s.value}
                onClick={() => onStatusFilter(s.value)}
                aria-pressed={active}
                className={`relative z-10 rounded-full px-3 py-1 transition-colors duration-200 ${
                  active ? 'text-background' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {active && (
                  <span className="absolute inset-0 rounded-full bg-foreground" aria-hidden />
                )}
                <span className="relative">{s.label}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 text-sm flex-1 sm:flex-initial min-w-[180px]">
          <Search className="size-3.5 text-muted-foreground shrink-0" />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search payment, program, signal…"
            className="bg-transparent outline-none w-full sm:w-60 placeholder:text-muted-foreground"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="relative rounded-xl border border-border bg-card overflow-hidden">
        <div className={`overflow-x-auto transition-opacity duration-150 ${loading && rows.length > 0 ? 'opacity-70' : 'opacity-100'}`}>
          <table className="w-full min-w-[900px] text-sm">
            <thead className="bg-muted text-xs uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2 font-semibold">Payment</th>
                <th className="text-left px-4 py-2 font-semibold">Program</th>
                <th className="text-left px-4 py-2 font-semibold">Signals</th>
                <th className="text-left px-4 py-2 font-semibold">Risk</th>
                <th className="text-right px-4 py-2 font-semibold">
                  <SortHeader
                    label="Recovery $"
                    align="right"
                    active={sort === 'recovery'}
                    onClick={() => onSortChange(sort === 'recovery' ? 'exposure' : 'recovery')}
                  />
                </th>
                <th className="text-right px-4 py-2 font-semibold">
                  <SortHeader
                    label="Exposure $"
                    align="right"
                    active={sort === 'exposure'}
                    onClick={() => onSortChange(sort === 'exposure' ? 'recovery' : 'exposure')}
                  />
                </th>
                <th className="text-left px-4 py-2 font-semibold">Recommended</th>
                <th className="text-left px-4 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    No flagged payments match the current filters.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <Row key={r.paymentId} row={r} onSelect={onSelect} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Row({ row, onSelect }: { row: PaymentRow; onSelect: (id: string) => void }) {
  const pulse = usePulseOnChange(row.liveDisposition ?? row.recommendedDisposition ?? '');
  return (
    <tr
      onClick={() => onSelect(row.paymentId)}
      className={`border-t border-border cursor-pointer hover:bg-muted/50 transition-colors ${
        pulse ? 'animate-pulse-ring' : ''
      }`}
    >
      <td className="px-4 py-3 font-medium text-foreground">{row.paymentId}</td>
      <td className="px-4 py-3 text-muted-foreground">{row.program ?? '—'}</td>
      <td className="px-4 py-3 text-muted-foreground max-w-[280px] truncate" title={row.signals ?? ''}>
        {row.signals ?? '—'}
      </td>
      <td className="px-4 py-3">
        <RiskBadge risk={row.riskLevel} />
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
        {usd(row.projectedRecoveryIfInvestigatedUsd)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums font-medium text-foreground">
        {usd(row.improperPaymentExposureUsd)}
      </td>
      <td className="px-4 py-3">
        {row.recommendedDisposition ? (
          <DispositionBadge disposition={row.recommendedDisposition} />
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        {row.liveDisposition ? (
          <DispositionBadge disposition={row.liveDisposition} live />
        ) : (
          <span className="text-xs text-muted-foreground">flagged</span>
        )}
      </td>
    </tr>
  );
}
