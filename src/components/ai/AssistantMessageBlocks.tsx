import { memo, useMemo } from 'react';
import type { AssistantMessageBlock } from '@/types/assistant';
import { ApprovalCard } from './ApprovalCard';
import { EvidenceCard } from './EvidenceCard';
import { QuestionCard } from './QuestionCard';
import { ResultSummaryCard } from './ResultSummaryCard';
import { AssistantMarkdown } from './AssistantMarkdown';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { groupAssistantBlocks } from '@/lib/assistantTurnPresentation';
import { TurnProcessDisclosure } from './TurnProcessDisclosure';

export const AssistantMessageBlocks = memo(function AssistantMessageBlocks({
  blocks,
}: {
  blocks?: AssistantMessageBlock[];
}) {
  const showEvidenceCitations = useAISettingsStore(state => state.showEvidenceCitations);
  const showActivityTimeline = useAISettingsStore(state => state.showActivityTimeline);
  const grouped = useMemo(() => groupAssistantBlocks(blocks), [blocks]);

  if (!blocks?.length) return null;
  return (
    <div className="space-y-3">
      {showActivityTimeline && grouped.processBlocks.length > 0 && (
        <TurnProcessDisclosure blocks={grouped.processBlocks} />
      )}
      <div className="space-y-3" data-testid="turn-visible">
        {grouped.visibleBlocks.map(block => {
          switch (block.type) {
            case 'citations':
            case 'evidence':
              if (!showEvidenceCitations) return null;
              return (
                <EvidenceCard
                  key={block.id}
                  title={'title' in block ? block.title : undefined}
                  summary={'summary' in block ? block.summary : undefined}
                  citations={block.citations}
                />
              );
            case 'approval':
              return (
                <div key={block.id} data-testid="visible-approval">
                  <ApprovalCard approvalId={block.approvalId} />
                </div>
              );
            case 'question':
              return <QuestionCard key={block.id} clarificationId={block.clarificationId} />;
            case 'result':
              return <ResultSummaryCard key={block.id} result={block.result} />;
            case 'artifact':
              return (
                <div key={block.id} className="rounded-xl border border-border p-3">
                  <div className="text-sm font-medium">{block.artifact.title}</div>
                  {block.artifact.summary && (
                    <div className="text-xs text-muted-foreground">{block.artifact.summary}</div>
                  )}
                </div>
              );
            case 'markdown':
              return <AssistantMarkdown key={block.id} markdown={block.markdown} />;
            default:
              return null;
          }
        })}
      </div>
    </div>
  );
});
