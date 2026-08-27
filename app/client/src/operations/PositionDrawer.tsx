/**
 * Right-side case drawer with two tabs. Opens when the user clicks a row in
 * the flagged-payment queue. Auto-refreshes on dataMutated (so when the
 * assistant records a disposition, this view reflects it live).
 *
 * (Named `PositionDrawer`/exported as such for import stability; the
 * OperationsView imports it aliased as `PaymentDrawer`.)
 */
import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@databricks/appkit-ui/react';
import { fetchPayment } from '@/lib/payments';
import { dataMutated } from '@/lib/events';
import { RiskBadge } from '@/shared/badges';
import type { PaymentDetail } from '@/shared/types';

import { ShortfallTab as FlagTab } from './tabs/ShortfallTab';
import { ActivityTab } from './tabs/ActivityTab';

type Props = {
  id: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMutated: () => void;
};

export function PositionDrawer({ id, open, onOpenChange, onMutated }: Props) {
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setDetail(null);
      return;
    }
    setLoading(true);
    fetchPayment(id)
      .then(setDetail)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
    const unsub = dataMutated.subscribe(() => {
      if (id) void fetchPayment(id).then(setDetail).catch(() => {});
    });
    return unsub;
  }, [id]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="!w-full sm:!w-[60vw] sm:!max-w-[60vw] lg:!w-[640px] lg:!max-w-[640px] p-0 flex flex-col"
      >
        {!detail && loading && (
          <div className="p-8 text-muted-foreground">Loading…</div>
        )}
        {error && <div className="p-8 text-destructive">{error}</div>}
        {detail && (
          <>
            <SheetHeader className="px-8 pt-8 pb-4 border-b border-border">
              <div className="flex items-center gap-3">
                <RiskBadge risk={detail.payment.riskLevel} />
                <span className="font-mono text-xs text-muted-foreground">
                  {detail.payment.paymentId}
                </span>
              </div>
              <SheetTitle className="display text-2xl">
                {detail.payment.program ?? 'Payment'}
                {detail.payment.paymentAmountUsd != null && (
                  <span className="text-muted-foreground font-normal">
                    {' '}· ${detail.payment.paymentAmountUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                )}
              </SheetTitle>
              <SheetDescription className="flex items-center gap-2 flex-wrap">
                <span>{detail.payment.state ?? '—'}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {detail.payment.nSignals ?? 0} signal
                  {detail.payment.nSignals === 1 ? '' : 's'}
                </span>
              </SheetDescription>
            </SheetHeader>
            <Tabs defaultValue="flag" className="flex-1 flex flex-col min-h-0">
              <TabsList className="mx-8 mt-4 w-fit">
                <TabsTrigger value="flag">Flag &amp; disposition</TabsTrigger>
                <TabsTrigger value="activity">
                  <Activity className="size-3.5 mr-1" />
                  Activity{' '}
                  {detail.actions.length > 0 && `(${detail.actions.length})`}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="flag" className="flex-1 overflow-y-auto px-8 py-6">
                <FlagTab detail={detail} onMutated={onMutated} />
              </TabsContent>
              <TabsContent value="activity" className="flex-1 overflow-y-auto px-8 py-6">
                <ActivityTab detail={detail} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
