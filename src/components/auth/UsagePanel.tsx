import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  USAGE_UPDATED_EVENT,
  formatUsd,
  loadUsageRows,
  summarizeUsage,
  type UsageAccess,
  type UsageSummary,
} from "@/services/billing/usage";

/** How often an open meter refreshes on its own. */
export const USAGE_REFRESH_MS = 30_000;

function day(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function UsagePanel({
  open,
  onOpenChange,
  userId,
  access,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId: string;
  access: UsageAccess;
}) {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const requestSeq = useRef(0);
  const periodStartMs = access.periodStart.getTime();

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const { rows, truncated } = await loadUsageRows(userId, new Date(periodStartMs));
      if (seq !== requestSeq.current) return;
      setSummary(summarizeUsage(rows, truncated));
      setError("");
      setUpdatedAt(new Date());
    } catch {
      if (seq !== requestSeq.current) return;
      setError("AI usage could not be loaded right now.");
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [userId, periodStartMs]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), USAGE_REFRESH_MS);
    const onUsage = () => void refresh();
    window.addEventListener(USAGE_UPDATED_EVENT, onUsage);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener(USAGE_UPDATED_EVENT, onUsage);
      requestSeq.current++;
    };
  }, [open, refresh]);

  const period = access.periodEnd
    ? `${day(access.periodStart)} to ${day(access.periodEnd)}`
    : `Since ${day(access.periodStart)}`;
  const top = summary ? Math.max(...summary.people.map((p) => p.chargeUsd), 0) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Usage</DialogTitle>
          <DialogDescription>
            Live AI usage for your team this billing period ({period}). It is added to your next invoice.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">AI usage so far</div>
          <div className="mt-1 text-3xl font-semibold tabular-nums" data-testid="usage-total">
            {summary ? formatUsd(summary.totalUsd) : "—"}
          </div>
          {summary && (
            <div className="mt-1 text-xs text-muted-foreground">
              {summary.totalRequests.toLocaleString()} AI requests
              {summary.freeRequests > 0 && ` · ${summary.freeRequests.toLocaleString()} free during trial`}
            </div>
          )}
          {access.status === "trialing" && (
            <div className="mt-2 text-xs text-muted-foreground">AI usage during your free trial isn't charged.</div>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {!summary && !error ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading usage
          </div>
        ) : summary && summary.people.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI usage yet this billing period.</p>
        ) : summary ? (
          <div className="max-h-72 overflow-y-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Person</th>
                  <th className="py-2 pr-3 text-right font-medium">Requests</th>
                  <th className="py-2 text-right font-medium">Usage</th>
                </tr>
              </thead>
              <tbody>
                {summary.people.map((p) => (
                  <tr key={p.userId} className="border-b border-border/50 align-top">
                    <td className="py-2 pr-3">
                      <div className="break-all text-foreground">
                        {p.email}
                        {p.userId === userId && <span className="ml-1 text-xs text-muted-foreground">(you)</span>}
                      </div>
                      <div className="mt-1 h-1.5 w-full rounded bg-muted" aria-hidden>
                        <div
                          className="h-1.5 rounded bg-primary"
                          style={{ width: `${top > 0 ? Math.max(2, (p.chargeUsd / top) * 100) : 0}%` }}
                        />
                      </div>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{p.requests.toLocaleString()}</td>
                    <td className="py-2 text-right tabular-nums">{formatUsd(p.chargeUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {summary?.truncated && (
          <p className="text-xs text-muted-foreground">Showing the first 50,000 requests. See Account Settings on the website for the full total.</p>
        )}

        <div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
          <span>{updatedAt ? `Updated ${updatedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}</span>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Totals update after each AI reply and every 30 seconds. Your invoice is the final amount.
        </p>
      </DialogContent>
    </Dialog>
  );
}
