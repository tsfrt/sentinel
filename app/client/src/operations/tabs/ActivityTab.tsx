/**
 * Timeline of recorded case actions for this payment.
 * Shows disposition, hold duration, predicted recovery $, timestamps, and audit trail.
 */
import { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Clock,
  AlertCircle,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import { DispositionBadge } from '@/shared/badges';
import type { PaymentDetail, CaseAction } from '@/shared/types';

type Props = {
  detail: PaymentDetail;
};

export function ActivityTab({ detail }: Props) {
  const actions: CaseAction[] = detail.actions ?? [];

  if (actions.length === 0) {
    return (
      <div className="text-sm text-muted-foreground max-w-md">
        No case actions recorded yet. When you approve a disposition, it lands here.
      </div>
    );
  }

  return (
    <ol className="space-y-3 max-w-3xl">
      {actions.map((action) => (
        <li key={action.id}>
          <ActionRow action={action} />
        </li>
      ))}
    </ol>
  );
}

function ActionRow({ action }: { action: CaseAction }) {
  const [expanded, setExpanded] = useState(false);

  const statusIcon = {
    proposed: <AlertCircle className="size-3.5" />,
    approved: <CheckCircle2 className="size-3.5" />,
    executed: <Clock className="size-3.5" />,
    overridden: <XCircle className="size-3.5" />,
  };

  const statusColor = {
    proposed: 'bg-amber-100 text-amber-800',
    approved: 'bg-blue-100 text-blue-800',
    executed: 'bg-green-100 text-green-800',
    overridden: 'bg-destructive/15 text-destructive',
  };

  const holdInfo =
    action.holdDurationHours != null ? ` · ${action.holdDurationHours}h hold` : '';

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-muted/40 transition-colors"
      >
        <div
          className={`size-7 rounded-full flex items-center justify-center shrink-0 ${statusColor[action.status]}`}
        >
          {statusIcon[action.status]}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] font-medium">
            <DispositionBadge disposition={action.actionType} />
            <span className="ml-2 text-foreground">{action.status}{holdInfo}</span>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            predicted recovery +${action.predictedRecoveryUsd?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? '—'}
          </div>
        </div>
        <div className="text-xs text-muted-foreground shrink-0">
          {fmt(action.createdAt)}
        </div>
        {expanded ? (
          <ChevronDown className="size-4 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="px-4 py-3 border-t border-border space-y-3 bg-background">
          {action.draftedRequest && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-1">
                Request
              </div>
              <div className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                {action.draftedRequest}
              </div>
            </div>
          )}

          {action.approvedBy && (
            <div className="text-xs text-muted-foreground">
              Approved by <span className="font-semibold">{action.approvedBy}</span>
              {action.decidedAt ? ` on ${fmt(action.decidedAt)}` : ''}
            </div>
          )}

          {action.auditTrail && action.auditTrail.length > 0 && (
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground mb-2">
                Audit trail
              </div>
              <ol className="space-y-1.5">
                {action.auditTrail.map((entry, i) => (
                  <li key={i} className="text-xs text-muted-foreground">
                    <div className="font-semibold text-foreground">
                      {entry.action}
                    </div>
                    <div>
                      {entry.by} · {fmt(entry.at)}
                    </div>
                    {entry.notes && (
                      <div className="mt-1 text-foreground italic">"{entry.notes}"</div>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmt(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
}
