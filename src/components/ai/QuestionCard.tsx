import { useEffect, useMemo, useState } from 'react';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useAIChatStore } from '@/store/aiChatStore';

export interface ClarificationAnswerDetail {
  clarificationId: string;
  selectedValues: string[];
  freeform?: string;
  displayText: string;
}

function buildDisplayText(
  selectedLabels: string[],
  freeform?: string,
): string {
  const parts = [...selectedLabels];
  if (freeform?.trim()) parts.push(freeform.trim());
  return parts.join(', ') || 'Answered';
}

export function QuestionCard({ clarificationId }: { clarificationId: string }) {
  const clarification = useAIChatStore(state => state.clarifications[clarificationId]);
  const [selected, setSelected] = useState<string[]>([]);
  const [freeform, setFreeform] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setSelected([]);
    setFreeform('');
    setSubmitting(false);
  }, [clarificationId, clarification?.status]);

  const allowMulti = Boolean(clarification?.allowMultiSelect);
  const allowFreeform = clarification?.allowFreeform !== false;
  const options = clarification?.options ?? [];
  const isPending = clarification?.status === 'pending';

  const selectedLabels = useMemo(() => {
    if (!clarification) return [];
    return clarification.options
      .filter(option => selected.includes(option.value))
      .map(option => option.label);
  }, [clarification, selected]);

  if (!clarification) return null;

  const submit = (values: string[], freeformValue?: string) => {
    if (submitting || !isPending) return;
    const trimmed = freeformValue?.trim();
    if (!values.length && !trimmed) return;
    setSubmitting(true);
    const displayText = buildDisplayText(
      clarification.options
        .filter(option => values.includes(option.value))
        .map(option => option.label),
      trimmed,
    );
    window.dispatchEvent(new CustomEvent('bidveraai:clarification', {
      detail: {
        clarificationId,
        selectedValues: values,
        freeform: trimmed || undefined,
        displayText,
      } satisfies ClarificationAnswerDetail,
    }));
  };

  const toggleOption = (value: string) => {
    if (!isPending || submitting) return;
    if (!allowMulti) {
      setSelected([value]);
      if (!allowFreeform || !freeform.trim()) {
        submit([value]);
      }
      return;
    }
    setSelected(prev =>
      prev.includes(value) ? prev.filter(item => item !== value) : [...prev, value],
    );
  };

  const canContinue = selected.length > 0 || Boolean(freeform.trim());

  return (
    <div className="my-2 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground">{clarification.question}</div>
          {clarification.description && (
            <div className="mt-0.5 text-[11px] text-muted-foreground">{clarification.description}</div>
          )}
        </div>
      </div>

      {isPending ? (
        <>
          {options.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {options.map(option => {
                const isSelected = selected.includes(option.value);
                return (
                  <button
                    key={option.id}
                    type="button"
                    disabled={submitting}
                    onClick={() => toggleOption(option.value)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
                      isSelected
                        ? 'border-foreground/40 bg-foreground/10 text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:border-foreground/25 hover:text-foreground',
                    )}
                  >
                    {option.label}
                  </button>
                );
              })}
            </div>
          )}

          {allowFreeform && (
            <div className="mt-2.5">
              <Input
                value={freeform}
                disabled={submitting}
                placeholder={options.length ? 'Other…' : 'Type your answer…'}
                className="h-8 text-xs"
                onChange={event => setFreeform(event.target.value)}
                onKeyDown={event => {
                  if (event.key === 'Enter' && canContinue) {
                    event.preventDefault();
                    submit(selected, freeform);
                  }
                }}
              />
            </div>
          )}

          {(allowMulti || allowFreeform || options.length === 0) && (
            <div className="mt-3 flex justify-end">
              <Button
                size="sm"
                className="h-7 text-xs"
                disabled={!canContinue || submitting}
                onClick={() => submit(selected, freeform)}
              >
                Continue
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="mt-2 text-[11px] text-muted-foreground">
          {clarification.answer?.displayText
            || (selectedLabels.length ? selectedLabels.join(', ') : clarification.status)}
        </div>
      )}
    </div>
  );
}
