import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAIChatStore } from '@/store/aiChatStore';
import type { AssistantMessageBlock } from '@/types/assistant';

type FollowUpBlock = Extract<AssistantMessageBlock, { type: 'follow-up' }>;

/**
 * One-click reply for an answer that ends by offering a next step.
 * Becomes read-only once the user replies (by click or by typing) or dismisses it.
 */
export function FollowUpCard({ block }: { block: FollowUpBlock }) {
  const [dismissed, setDismissed] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const laterUserReply = useAIChatStore(state => {
    const index = state.messages.findIndex(message => message.id === block.messageId);
    if (index < 0) return null;
    return state.messages.slice(index + 1).find(message => message.role === 'user')?.content ?? null;
  });
  const busy = useAIChatStore(state => Object.values(state.runs).some(run => run.status === 'running'));

  const settled = dismissed || Boolean(chosen) || Boolean(laterUserReply);

  if (dismissed && !laterUserReply) return null;

  return (
    <div
      className="my-2 rounded-xl border border-border bg-card p-3"
      data-testid="follow-up-card"
      role="group"
      aria-label="Suggested next step"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 text-xs font-medium text-foreground">{block.question}</div>
      </div>
      {settled ? (
        <div className="mt-1.5 text-[11px] text-muted-foreground">
          {chosen || (laterUserReply ? 'Replied' : 'Dismissed')}
        </div>
      ) : (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {block.options.map(option => (
            <Button
              key={option.label}
              size="sm"
              variant={option.primary ? 'default' : 'outline'}
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => {
                if (!option.reply) {
                  setDismissed(true);
                  return;
                }
                setChosen(option.label);
                window.dispatchEvent(new CustomEvent('bidveraai:quick-reply', {
                  detail: { content: option.reply },
                }));
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
