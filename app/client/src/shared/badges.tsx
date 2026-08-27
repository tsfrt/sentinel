/**
 * Small pill-style badges reused across the Operations page + home activity
 * feed. If you add a new risk level or disposition, update both the type union
 * in shared/types.ts and the colour map here.
 */
import type { RiskLevel, Disposition } from './types';

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const styles: Record<RiskLevel, string> = {
    high: 'bg-[var(--risk-high-subtle,#fee2e2)] text-[var(--risk-high-subtle-foreground,#b91c1c)]',
    moderate: 'bg-[var(--risk-moderate-subtle,#ffedd5)] text-[var(--risk-moderate-subtle-foreground,#c2410c)]',
  };
  const labels: Record<RiskLevel, string> = {
    high: 'High',
    moderate: 'Moderate',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${styles[risk]}`}>
      {labels[risk]}
    </span>
  );
}

export function DispositionBadge({
  disposition,
  live = false,
}: {
  disposition: Disposition;
  live?: boolean;
}) {
  const styles: Record<Disposition, string> = {
    release: 'bg-emerald-100 text-emerald-700',
    hold_for_verification: 'border border-amber-500 text-amber-700 bg-amber-50',
    refer_to_investigation: 'bg-red-600 text-white',
  };
  const labels: Record<Disposition, string> = {
    release: 'Release',
    hold_for_verification: 'Hold',
    refer_to_investigation: 'Investigate',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles[disposition]}`}>
      {labels[disposition]}
      {live ? ' ✓' : ''}
    </span>
  );
}
