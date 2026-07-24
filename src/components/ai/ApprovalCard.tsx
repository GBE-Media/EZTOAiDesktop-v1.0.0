import { Check, ShieldCheck, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAIChatStore } from '@/store/aiChatStore';

export function ApprovalCard({ approvalId }: { approvalId: string }) {
  const approval = useAIChatStore(state => state.approvals[approvalId]);
  if (!approval) return null;
  const resolve = (decision: 'approved' | 'rejected') => {
    window.dispatchEvent(new CustomEvent('bidveraai:approval', {
      detail: { approvalId, decision },
    }));
  };

  return (
    <div className="my-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
      <div className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 h-4 w-4 text-emerald-500" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium">{approval.title}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{approval.description}</div>
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
