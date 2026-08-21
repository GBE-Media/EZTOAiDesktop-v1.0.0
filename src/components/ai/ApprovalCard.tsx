import { Check, ShieldCheck, X } from 'lucide-react';
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

  return (
    <div className="my-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">{approval.title}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{approval.description}</div>
          {previewText && (
            <div
              data-testid="approval-preview"
              className="mt-2 rounded-md border border-emerald-500/20 bg-background/60 px-2 py-1.5 text-[11px] text-foreground/90"
            >
              <div className="mb-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                Preview
              </div>
              <div className="whitespace-pre-wrap break-words">{previewText}</div>
            </div>
          )}
          {approval.undoable && <Badge variant="outline" className="mt-2 text-[10px]">Undoable</Badge>}
        </div>
      </div>
      {approval.status === 'pending' ? (
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => resolve('rejected')}>
            <X className="mr-1 h-3 w-3" /> Reject
          </Button>
          <Button size="sm" className="h-7 bg-emerald-600 text-xs hover:bg-emerald-700" onClick={() => resolve('approved')}>
            <Check className="mr-1 h-3 w-3" /> Approve
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-[11px] capitalize text-muted-foreground">{approval.status}</div>
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
