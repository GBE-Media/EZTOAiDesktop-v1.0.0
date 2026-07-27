import { RunTimeline } from './RunTimeline';
import type { AssistantMessageBlock } from '@/types/assistant';
import { ApprovalCard } from './ApprovalCard';
import { EvidenceCard } from './EvidenceCard';
import { ToolActivityCard } from './ToolActivityCard';
import { QuestionCard } from './QuestionCard';
import { ResultSummaryCard } from './ResultSummaryCard';
import { ProgressEventRow } from './ProgressEventRow';
import { useAISettingsStore } from '@/store/aiSettingsStore';

export function AssistantMessageBlocks({ blocks }: { blocks?: AssistantMessageBlock[] }) {
  const showActivityTimeline = useAISettingsStore(state => state.showActivityTimeline);
  const showEvidenceCitations = useAISettingsStore(state => state.showEvidenceCitations);

  if (!blocks?.length) return null;
  return (
    <div className="space-y-2">
      {blocks.map(block => {
        switch (block.type) {
          case 'activity':
            if (!showActivityTimeline) return null;
            return <RunTimeline key={block.id} runId={block.runId} />;
          case 'citations':
          case 'evidence':
            if (!showEvidenceCitations) return null;
            return <EvidenceCard
              key={block.id}
              title={'title' in block ? block.title : undefined}
              summary={'summary' in block ? block.summary : undefined}
              citations={block.citations}
            />;
          case 'approval':
            // Approvals always stay visible — required for safety.
            return <ApprovalCard key={block.id} approvalId={block.approvalId} />;
          case 'question':
            return <QuestionCard key={block.id} clarificationId={block.clarificationId} />;
          case 'result':
            return <ResultSummaryCard key={block.id} result={block.result} />;
          case 'progress':
            return <ProgressEventRow key={block.id} label={block.label} status={block.status} />;
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
