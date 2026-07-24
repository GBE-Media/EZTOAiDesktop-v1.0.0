import { RunTimeline } from './RunTimeline';
import type { AssistantMessageBlock } from '@/types/assistant';
import { ApprovalCard } from './ApprovalCard';
import { EvidenceCard } from './EvidenceCard';
import { ToolActivityCard } from './ToolActivityCard';

export function AssistantMessageBlocks({ blocks }: { blocks?: AssistantMessageBlock[] }) {
  if (!blocks?.length) return null;
  return (
    <div className="space-y-2">
      {blocks.map(block => {
        switch (block.type) {
          case 'activity':
            return <RunTimeline key={block.id} runId={block.runId} />;
          case 'citations':
          case 'evidence':
            return <EvidenceCard
              key={block.id}
              title={'title' in block ? block.title : undefined}
              summary={'summary' in block ? block.summary : undefined}
              citations={block.citations}
            />;
          case 'approval':
            return <ApprovalCard key={block.id} approvalId={block.approvalId} />;
          case 'artifact':
            return (
              <div key={block.id} className="rounded-lg border border-border p-2.5">
                <div className="text-xs font-medium">{block.artifact.title}</div>
                {block.artifact.summary && <div className="text-[11px] text-muted-foreground">{block.artifact.summary}</div>}
              </div>
            );
          case 'tool-result':
            return <ToolActivityCard key={block.id} activity={block.activity} />;
          case 'markdown':
            return <div key={block.id} className="whitespace-pre-wrap text-sm">{block.markdown}</div>;
          default:
            return null;
        }
      })}
    </div>
  );
}
