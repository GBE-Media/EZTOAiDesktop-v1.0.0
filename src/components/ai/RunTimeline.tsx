import { useEffect, useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  Circle,
  Loader2,
  XCircle,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress } from '@/components/ui/progress';
import { useAIChatStore } from '@/store/aiChatStore';
import { cn } from '@/lib/utils';
import { useCanvasStore } from '@/store/canvasStore';

export function RunTimeline({ runId }: { runId: string }) {
  const run = useAIChatStore(state => state.runs[runId]);
  const setCurrentPage = useCanvasStore(state => state.setCurrentPage);
  const isActive = run?.status === 'running' || run?.status === 'waiting-approval';
  // Open while working; collapse when the answer arrives so thought process
  // stays available but out of the final answer surface.
  const [open, setOpen] = useState(!!isActive);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (userToggled || !run) return;
    setOpen(run.status === 'running' || run.status === 'waiting-approval');
  }, [run?.status, userToggled, run]);

  if (!run) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setUserToggled(true);
        setOpen(next);
      }}
      className="my-2 rounded-lg border border-border bg-secondary/20"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
        {run.status === 'running' ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-500" />
        ) : run.status === 'error' ? (
          <XCircle className="h-3.5 w-3.5 text-destructive" />
        ) : run.status === 'waiting-approval' ? (
          <Loader2 className="h-3.5 w-3.5 animate-pulse text-amber-500" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        )}
        <span className="flex-1 text-xs font-medium">
          {isActive ? (run.summary || 'Working…') : 'Activity'}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {run.steps.filter(step => step.status === 'completed').length}/{run.steps.length}
        </span>
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t border-border px-3 py-2">
        <div className="space-y-2">
          {run.steps.map(step => (
            <div key={step.id} className="flex gap-2">
              <div className="pt-0.5">
                {step.status === 'running' ? (
                  <Loader2 className="h-3 w-3 animate-spin text-violet-500" />
                ) : step.status === 'completed' ? (
                  <CheckCircle2 className="h-3 w-3 text-emerald-500" />
                ) : step.status === 'error' ? (
                  <XCircle className="h-3 w-3 text-destructive" />
                ) : (
                  <Circle className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn('text-xs', step.status === 'running' && 'animate-pulse')}>
                  {step.label}
                </div>
                {step.summary && <div className="text-[11px] text-muted-foreground">{step.summary}</div>}
                {step.status === 'running' && step.progress !== undefined && (
                  <Progress value={step.progress} className="mt-1 h-1" />
                )}
                {step.error && <div className="text-[11px] text-destructive">{step.error}</div>}
                {step.citations && step.citations.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {step.citations.map(citation => (
                      <button
                        key={citation.id}
                        type="button"
                        onClick={() => setCurrentPage(citation.page)}
                        className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:border-emerald-500/50"
                      >
                        Page {citation.page}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
