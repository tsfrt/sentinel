/**
 * "Flag & disposition" tab of the case drawer. Shows the payment-level fields +
 * the open-flag signals + the ranked disposition options. No write button;
 * instead, a button to ask the assistant to disposition this payment.
 *
 * (File/export kept as ShortfallTab for import stability; imported aliased as
 * FlagTab by the drawer.)
 */
import { dockController } from '@/chat/dockController';
import { DispositionBadge } from '@/shared/badges';
import type { PaymentDetail } from '@/shared/types';

const usd = (v: number | null | undefined): string =>
  v === null || v === undefined
    ? '—'
    : `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

export function ShortfallTab({
  detail,
  onMutated,
}: {
  detail: PaymentDetail;
  onMutated: () => void;
}) {
  const { payment, flag, recommendation } = detail;

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Payment details grid */}
      <dl className="grid grid-cols-2 sm:grid-cols-1 gap-x-4 gap-y-3 sm:gap-y-4 text-sm">
        <DetailRow label="Program" value={payment.program ?? '—'} />
        <DetailRow label="State" value={payment.state ?? '—'} />
        <DetailRow label="Amount" value={usd(payment.paymentAmountUsd)} />
        <DetailRow label="Queue date" value={payment.queueDate ?? '—'} />
        <DetailRow label="# signals" value={payment.nSignals?.toLocaleString() ?? '—'} />
        <DetailRow
          label="Improper exposure"
          value={usd(payment.improperPaymentExposureUsd)}
        />
        <DetailRow
          label="Projected recovery"
          value={usd(payment.projectedRecoveryIfInvestigatedUsd)}
        />
        <DetailRow
          label="Confidence"
          value={
            payment.confidenceScore !== null
              ? `${(payment.confidenceScore * 100).toFixed(0)}%`
              : '—'
          }
        />
      </dl>

      {/* Signals on this payment */}
      {flag && flag.signalList && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground mb-3">
            Fraud / eligibility signals
          </div>
          <div className="flex flex-wrap gap-1.5">
            {flag.signalList.split(',').map((s, i) => (
              <span
                key={i}
                className="inline-block rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
              >
                {s.trim()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Ranked disposition options */}
      {recommendation && recommendation.actionRanking.length > 0 ? (
        <div className="rounded-xl border border-border bg-card p-4 space-y-4">
          <div className="text-xs font-semibold uppercase tracking-[0.15em] text-muted-foreground">
            Disposition options (ranked)
          </div>
          <div className="space-y-3">
            {recommendation.actionRanking.map((opt, i) => (
              <div
                key={i}
                className={`rounded-lg border p-3 ${
                  i === 0 ? 'border-green-400 bg-green-50' : 'border-border bg-background'
                }`}
              >
                <div className="flex items-center gap-2">
                  <DispositionBadge disposition={opt.disposition} />
                  {i === 0 && (
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-green-700 bg-green-100 rounded px-2 py-0.5">
                      Recommended
                    </span>
                  )}
                  {opt.holdHours > 0 && (
                    <span className="text-xs text-muted-foreground">{opt.holdHours}h hold</span>
                  )}
                </div>
                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground font-semibold">Cost</div>
                    <div className="font-mono">{usd(opt.costUsd)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground font-semibold">Recovery</div>
                    <div className="font-mono text-green-700">{usd(opt.predictedRecoveryUsd)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground font-semibold">Net value</div>
                    <div className="font-mono">{usd(opt.predictedNetValueUsd)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : recommendation ? (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          No disposition recommendation yet — the ML model scores this in the Build 2 step.
        </div>
      ) : null}

      {/* CTA button */}
      <button
        onClick={() => {
          const msg = `Payment ${payment.paymentId} is flagged as likely improper. Should we hold it, release it, or refer it to investigation?`;
          dockController.openAndSend(msg);
          onMutated();
        }}
        className="w-full rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity"
      >
        Ask the assistant to disposition this payment
      </button>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground flex-shrink-0 w-28">
        {label}
      </dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}
