import { Check, Copy, ShieldCheck, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAIChatStore } from '@/store/aiChatStore';
import type { ApprovalRequest } from '@/types/assistant';

/** Format optional approval.preview (typed as unknown) for the card body. */
export function formatApprovalPreview(preview: unknown): string | null {
  if (preview == null) return null;
  if (typeof preview === 'string') {
    const trimmed = preview.trim();
    return trimmed || null;
  }
  if (typeof preview === 'number' || typeof preview === 'boolean') {
    return String(preview);
  }
  if (Array.isArray(preview)) {
    if (preview.length === 0) return null;
    return `${preview.length} item${preview.length === 1 ? '' : 's'}`;
  }
  if (typeof preview === 'object') {
    const record = preview as Record<string, unknown>;
    const entries = Object.entries(record).filter(([, value]) => value != null);
    if (entries.length === 0) return null;

    // Common place_markups shape: { count, pages }
    if (typeof record.count === 'number' && Array.isArray(record.pages)) {
      const pages = record.pages.filter((page): page is number => typeof page === 'number');
      const pageLabel = pages.length > 0 ? ` on page${pages.length === 1 ? '' : 's'} ${pages.join(', ')}` : '';
      return `${record.count} markup${record.count === 1 ? '' : 's'}${pageLabel}`;
    }

    return entries
      .map(([key, value]) => {
        if (Array.isArray(value)) return `${key}: ${value.join(', ')}`;
        if (typeof value === 'object') return `${key}: ${JSON.stringify(value)}`;
        return `${key}: ${String(value)}`;
      })
      .join(' · ');
  }
  return null;
}

export function formatDroppedLine(row: { index?: number; itemId?: string; reason: string }): string {
  const who = typeof row.itemId === 'string' && row.itemId.trim()
    ? row.itemId
    : typeof row.index === 'number'
      ? `row ${row.index + 1}`
      : 'row';
  return `${who}: ${row.reason}`;
}

export function uniqueDroppedLines(
  dropped: Array<{ index?: number; itemId?: string; reason: string }> | undefined,
): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const row of dropped || []) {
    const line = formatDroppedLine(row);
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

export function approvalStatPills(approval: ApprovalRequest): string[] {
  const pills: string[] = [];
  const preview = approval.preview;
  if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
    const record = preview as Record<string, unknown>;
    if (typeof record.count === 'number') {
      pills.push(`${record.count} marker${record.count === 1 ? '' : 's'}`);
    }
  }
  if (Array.isArray(approval.payload)) {
    const codes = new Map<string, number>();
    for (const row of approval.payload) {
      if (!row || typeof row !== 'object') continue;
      const code = (row as Record<string, unknown>).code;
      if (typeof code === 'string' && code.trim()) {
        codes.set(code, (codes.get(code) || 0) + 1);
      }
    }
    for (const [code, count] of codes) {
      pills.push(`${code} ${count}`);
    }
  }
  return pills;
}

export function formatExecutionSummary(result: NonNullable<ApprovalRequest['executionResult']>): string {
  const parts = [
    `placed ${result.placed ?? 0}`,
    `auto-committed ${result.autoCommitted ?? 0}`,
    `needs confirmation ${result.needsConfirmation ?? 0}`,
    `review-queued ${result.reviewQueued ?? 0}`,
  ];
  const dropped = result.dropped?.length ?? 0;
  if (dropped > 0) {
    parts.push(`dropped ${dropped}`);
  }
  if (result.status === 'partial') parts.unshift('partial');
  return parts.join(' · ');
}

export function ApprovalCardView({
  approval,
  onResolve,
}: {
  approval: ApprovalRequest;
  onResolve?: (decision: 'approved' | 'rejected') => void;
}) {
  const previewText = formatApprovalPreview(approval.preview);
  const resolve = (decision: 'approved' | 'rejected') => {
    onResolve?.(decision);
  };
  const busy = !!approval.executing || approval.status !== 'pending';
  const droppedLines = uniqueDroppedLines(approval.executionResult?.dropped);
  const collapseDrops = droppedLines.length > 6;
  const pills = approvalStatPills(approval);

  return (
    <div className="my-2 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{approval.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">{approval.description}</div>
          {pills.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {pills.map(pill => (
                <span key={pill} className="rounded-full border border-border bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground">
                  {pill}
                </span>
              ))}
            </div>
          )}
          {previewText && (
            <details
              data-testid="approval-preview"
              className="mt-2 rounded-md border border-emerald-500/20 bg-background/60 px-2 py-1.5 text-[11px] text-foreground/90"
            >
              <summary className="cursor-pointer text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Preview
              </summary>
              <div className="mt-1 whitespace-pre-wrap break-words">{previewText}</div>
            </details>
          )}
          {approval.undoable && <Badge variant="outline" className="mt-2 text-[10px]">Undoable</Badge>}
        </div>
      </div>
      {approval.status === 'pending' ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => resolve('rejected')}
          >
            <X className="mr-1 h-3 w-3" /> Reject
          </Button>
          <Button
            size="sm"
            className="h-7 bg-emerald-600 text-xs hover:bg-emerald-700"
            disabled={busy}
            data-testid="approval-approve"
            onClick={() => resolve('approved')}
          >
            <Check className="mr-1 h-3 w-3" /> {approval.executing ? 'Placing…' : 'Approve'}
          </Button>
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          <div className="text-[11px] capitalize text-muted-foreground">{approval.status}</div>
          {approval.status === 'failed' && approval.error && (
            <div
              data-testid="approval-error"
              className="flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5"
            >
              <p className="line-clamp-3 min-w-0 flex-1 text-[11px] text-red-600">{approval.error}</p>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-6 shrink-0 px-1.5 text-[10px]"
                onClick={() => {
                  void navigator.clipboard?.writeText(approval.error || '');
                }}
              >
                <Copy className="mr-1 h-3 w-3" /> Copy
              </Button>
            </div>
          )}
          {(approval.status === 'executed' || approval.executionResult) && approval.executionResult && (
            <div data-testid="approval-result" className="rounded-md border border-emerald-500/20 bg-background/60 px-2 py-1.5 text-[11px] text-foreground/90">
              {formatExecutionSummary(approval.executionResult)}
              {droppedLines.length > 0 && (
                <details
                  data-testid="approval-dropped"
                  className="mt-1"
                  open={!collapseDrops}
                >
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-muted-foreground">
                    Dropped rows
                  </summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-4">
                    {droppedLines.map(line => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const approval = useAIChatStore(state => state.approvals[approvalId]);
  if (!approval) return null;
  return (
    <ApprovalCardView
      approval={approval}
      onResolve={(decision) => {
        window.dispatchEvent(new CustomEvent('bidveraai:approval', {
          detail: { approvalId, decision },
        }));
      }}
    />
  );
}
