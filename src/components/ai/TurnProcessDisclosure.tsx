import { memo, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import type { AssistantMessageBlock } from '@/types/assistant';
import { useAIChatStore } from '@/store/aiChatStore';
import { cn } from '@/lib/utils';
import { collapsedProcessLabel, friendlyStatusLine } from '@/lib/assistantTurnPresentation';
import { RunStepList } from './RunTimeline';
import { ProgressEventRow } from './ProgressEventRow';
import { ToolActivityCard } from './ToolActivityCard';

export const TurnProcessDisclosure = memo(function TurnProcessDisclosure({
  blocks,
}: {
  blocks: AssistantMessageBlock[];
}) {
  const [open, setOpen] = useState(false);
  const processBlocks = blocks;
  const activity = processBlocks.find(block => block.type === 'activity');
  const runId = activity && activity.type === 'activity' ? activity.runId : undefined;
  const run = useAIChatStore(state => (runId ? state.runs[runId] : undefined));
  const label = collapsedProcessLabel(run, processBlocks);

  if (processBlocks.length === 0) return null;

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="my-2 rounded-xl border border-border/80 bg-secondary/20"
      data-testid="turn-process"
    >
      <CollapsibleTrigger
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground',
          'rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'motion-safe:transition-colors motion-safe:duration-200',
        )}
      >
        <span className="flex-1" data-testid="turn-process-summary">{label}</span>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 motion-safe:transition-transform motion-safe:duration-200',
            open && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {open ? (
          <div className="border-t border-border/80 px-3 py-2" data-testid="turn-process-details">
            {runId ? <RunStepList runId={runId} /> : (
              <div className="space-y-1.5">
                {processBlocks.map(block => {
                  if (block.type === 'progress') {
                    return (
                      <ProgressEventRow
                        key={block.id}
                        label={friendlyStatusLine(block.label)}
                        status={block.status}
                      />
                    );
                  }
                  if (block.type === 'tool-result') {
                    return <ToolActivityCard key={block.id} activity={block.activity} />;
                  }
                  return null;
                })}
              </div>
            )}
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
});
