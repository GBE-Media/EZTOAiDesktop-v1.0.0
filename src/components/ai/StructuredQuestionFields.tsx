import { useEffect, useMemo, useState } from 'react';
import { Check, LocateFixed, MousePointerClick, RotateCcw, SquareDashed, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { openAssistantFocus } from '@/lib/openCitation';
import { useCanvasStore } from '@/store/canvasStore';
import { useDrawingPickStore } from '@/store/drawingPickStore';
import { ensureCachedPageGeometry } from '@/services/ai/placement/cachedCountMarkers';
import { describeFieldAnswer, fieldAnswersDisplayText, fieldsComplete } from '@/services/ai/agent/askUser';
import type { ClarificationField, ClarificationFieldAnswer, ClarificationRequest } from '@/types/assistant';
import type { ClarificationAnswerDetail } from './QuestionCard';

function initialAnswers(fields: ClarificationField[]): Record<string, ClarificationFieldAnswer> {
  const out: Record<string, ClarificationFieldAnswer> = {};
  for (const field of fields) {
    if (field.kind === 'choice' && field.recommended) {
      const option = field.options?.find(o => o.value === field.recommended);
      if (option) out[field.id] = { value: option.value, label: option.label };
    }
  }
  return out;
}

const chip = (selected: boolean) => cn(
  'rounded-md border px-2.5 py-1 text-[11px] transition-colors',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
  selected
    ? 'border-foreground/40 bg-foreground/10 text-foreground'
    : 'border-border bg-background text-muted-foreground hover:border-foreground/25 hover:text-foreground',
);

/** Several questions in one card: choices, "show me on the drawing", typed answers. */
export function StructuredQuestionFields({ clarification }: { clarification: ClarificationRequest }) {
  const fields = useMemo(() => clarification.fields || [], [clarification.fields]);
  const [answers, setAnswers] = useState<Record<string, ClarificationFieldAnswer>>(() => initialAnswers(fields));
  const [submitting, setSubmitting] = useState(false);
  const pickRequest = useDrawingPickStore(state => state.request);
  const pins = useDrawingPickStore(state => state.pins);
  const pickedAreas = useDrawingPickStore(state => state.areas);
  const isPending = clarification.status === 'pending';
  const keyPrefix = `${clarification.id}:`;

  // A point picked on the drawing lands in the pick store; copy it into this card's answers.
  useEffect(() => {
    for (const field of fields) {
      if (field.kind !== 'point') continue;
      const pin = pins[`${keyPrefix}${field.id}`];
      if (!pin) continue;
      setAnswers(prev => {
        const current = prev[field.id]?.point;
        if (current && current.xPct === pin.xPct && current.yPct === pin.yPct && current.page === pin.page) return prev;
        return { ...prev, [field.id]: { point: { documentId: pin.documentId, page: pin.page, xPct: pin.xPct, yPct: pin.yPct }, label: `Picked on page ${pin.page}` } };
      });
    }
  }, [fields, keyPrefix, pins]);

  // Boxes dragged on the drawing → area answers.
  useEffect(() => {
    for (const field of fields) {
      if (field.kind !== 'area') continue;
      const list = pickedAreas[`${keyPrefix}${field.id}`];
      setAnswers(prev => {
        const current = prev[field.id]?.areas;
        if ((current?.length || 0) === (list?.length || 0)) return prev;
        const next = { ...prev };
        if (list?.length) next[field.id] = { areas: list };
        else delete next[field.id];
        return next;
      });
    }
  }, [fields, keyPrefix, pickedAreas]);

  useEffect(() => () => {
    // Leaving the card mid-pick: stop pick mode.
    const state = useDrawingPickStore.getState();
    if (state.request?.key.startsWith(keyPrefix)) state.cancel();
  }, [keyPrefix]);

  if (!isPending) {
    const answered = clarification.answer?.fields || {};
    return (
      <div className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
        {fields.map(field => (
          <div key={field.id} className="flex gap-1.5">
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
            <span className="text-foreground/80">{field.prompt.replace(/\?$/, '')}:</span>
            <span>{describeFieldAnswer(field, answered[field.id])}</span>
          </div>
        ))}
      </div>
    );
  }

  const setAnswer = (fieldId: string, answer: ClarificationFieldAnswer | undefined) => {
    setAnswers(prev => {
      const next = { ...prev };
      if (answer) next[fieldId] = answer;
      else delete next[fieldId];
      return next;
    });
  };

  const startPick = (field: ClarificationField, mode: 'point' | 'area' = 'point') => {
    const canvas = useCanvasStore.getState();
    const documentId = field.documentId && canvas.pdfDocuments[field.documentId] ? field.documentId : canvas.activeDocId || undefined;
    if (field.page) openAssistantFocus({ documentId, page: field.page, label: field.pickLabel });
    // Rotation-aware click → page percent needs the page geometry.
    if (documentId) void ensureCachedPageGeometry(documentId, field.page || canvas.getCurrentPage() || 1).catch(() => undefined);
    useDrawingPickStore.getState().start({
      key: `${keyPrefix}${field.id}`,
      label: field.pickLabel || field.prompt,
      documentId,
      page: field.page,
      mode,
    });
  };

  const complete = fieldsComplete(fields, answers);
  const submit = () => {
    if (!complete || submitting) return;
    setSubmitting(true);
    // Optional area fields left empty: answer "none" so the tool doesn't ask again.
    for (const field of fields) {
      if (field.kind === 'area' && !answers[field.id]) answers[field.id] = { areas: [] };
    }
    useDrawingPickStore.getState().clearPins(keyPrefix);
    window.dispatchEvent(new CustomEvent('bidveraai:clarification', {
      detail: {
        clarificationId: clarification.id,
        selectedValues: fields.map(field => answers[field.id]?.value).filter((v): v is string => !!v),
        displayText: fieldAnswersDisplayText(fields, answers),
        fields: answers,
      } satisfies ClarificationAnswerDetail,
    }));
  };

  return (
    <div className="mt-3 space-y-3">
      {fields.map((field, index) => {
        const answer = answers[field.id];
        const pickKey = `${keyPrefix}${field.id}`;
        const picking = pickRequest?.key === pickKey;
        const done = field.kind === 'point' ? !!(answer?.point || answer?.value) : field.kind === 'area' ? !!answer?.areas?.length : !!answer?.value;
        return (
          <div key={field.id} className="space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
              <span className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px]',
                done ? 'bg-emerald-500/20 text-emerald-500' : 'bg-muted text-muted-foreground',
              )}>
                {done ? <Check className="h-2.5 w-2.5" /> : index + 1}
              </span>
              {field.prompt}
              {field.optional && <span className="font-normal text-muted-foreground">(optional)</span>}
            </div>

            {field.kind === 'point' && (
              <div className="flex flex-wrap items-center gap-1.5 pl-5">
                {picking ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/50 bg-violet-500/10 px-2.5 py-1 text-[11px] text-foreground">
                      <MousePointerClick className="h-3 w-3 animate-pulse text-violet-400" />
                      Click on the drawing…
                    </span>
                    <button type="button" className={chip(false)} onClick={() => useDrawingPickStore.getState().cancel()}>
                      <X className="mr-1 inline h-3 w-3 align-[-2px]" />Cancel
                    </button>
                  </>
                ) : answer?.value && !answer.point ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-foreground">
                      <Check className="h-3 w-3 text-emerald-500" />
                      {answer.label || answer.value}
                    </span>
                    <button type="button" className={chip(false)} onClick={() => setAnswer(field.id, undefined)}>
                      <RotateCcw className="mr-1 inline h-3 w-3 align-[-2px]" />Change
                    </button>
                  </>
                ) : answer?.point ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-foreground">
                      <LocateFixed className="h-3 w-3 text-emerald-500" />
                      {answer.label || `Picked on page ${answer.point.page}`}
                    </span>
                    <button type="button" className={chip(false)} onClick={() => answer.point && openAssistantFocus({ documentId: answer.point.documentId, page: answer.point.page })}>
                      Show
                    </button>
                    <button type="button" className={chip(false)} onClick={() => { setAnswer(field.id, undefined); startPick(field); }}>
                      <RotateCcw className="mr-1 inline h-3 w-3 align-[-2px]" />Redo
                    </button>
                  </>
                ) : (
                  <Button size="sm" className="h-7 gap-1 text-xs" disabled={submitting} onClick={() => startPick(field)}>
                    <MousePointerClick className="h-3.5 w-3.5" />
                    Show me on the drawing
                  </Button>
                )}
                {!answer?.point && !answer?.value && !picking && field.options?.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    className={chip(false)}
                    disabled={submitting}
                    onClick={() => {
                      // Options without a point (e.g. "On another sheet") answer with their value.
                      if (!option.point) {
                        setAnswer(field.id, { value: option.value, label: option.label });
                        return;
                      }
                      setAnswer(field.id, { point: option.point, label: option.label, value: option.value });
                      openAssistantFocus({ documentId: option.point.documentId, page: option.point.page });
                    }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}

            {field.kind === 'area' && (
              <div className="flex flex-wrap items-center gap-1.5 pl-5">
                {picking ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-[11px] text-foreground">
                      <SquareDashed className="h-3 w-3 animate-pulse text-amber-500" />
                      Drag a box on the drawing{answer?.areas?.length ? ` · ${answer.areas.length} marked` : ''}
                    </span>
                    <button type="button" className={chip(false)} onClick={() => useDrawingPickStore.getState().cancel()}>
                      <Check className="mr-1 inline h-3 w-3 align-[-2px]" />Done
                    </button>
                  </>
                ) : answer?.areas?.length ? (
                  <>
                    <span className="inline-flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-foreground">
                      <SquareDashed className="h-3 w-3 text-emerald-500" />
                      {answer.areas.length} area{answer.areas.length === 1 ? '' : 's'} marked
                    </span>
                    <button type="button" className={chip(false)} onClick={() => startPick(field, 'area')}>Add another</button>
                    <button type="button" className={chip(false)} onClick={() => useDrawingPickStore.getState().clearAreas(pickKey)}>
                      <X className="mr-1 inline h-3 w-3 align-[-2px]" />Clear
                    </button>
                  </>
                ) : (
                  <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={submitting} onClick={() => startPick(field, 'area')}>
                    <SquareDashed className="h-3.5 w-3.5" />
                    Mark on drawing
                  </Button>
                )}
              </div>
            )}

            {field.kind === 'choice' && (
              <div className="flex flex-wrap gap-1.5 pl-5">
                {field.options?.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={submitting}
                    className={chip(answer?.value === option.value)}
                    onClick={() => setAnswer(field.id, { value: option.value, label: option.label })}
                  >
                    {option.label}
                    {field.recommended === option.value && (
                      <span className="ml-1 rounded bg-emerald-500/15 px-1 text-[9px] text-emerald-500">Recommended</span>
                    )}
                  </button>
                ))}
                {field.placeholder && (
                  <Input
                    value={answer && !field.options?.some(option => option.value === answer.value) ? answer.value || '' : ''}
                    disabled={submitting}
                    placeholder={field.placeholder}
                    className="h-7 w-44 text-xs"
                    onChange={event => setAnswer(field.id, event.target.value ? { value: event.target.value } : undefined)}
                  />
                )}
              </div>
            )}

            {field.kind === 'text' && (
              <div className="pl-5">
                <Input
                  value={answer?.value || ''}
                  disabled={submitting}
                  placeholder={field.placeholder || 'Type your answer…'}
                  className="h-8 text-xs"
                  onChange={event => setAnswer(field.id, event.target.value ? { value: event.target.value } : undefined)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-end gap-2">
        {!complete && <span className="text-[10px] text-muted-foreground">Answer each step to continue</span>}
        <Button size="sm" className="h-7 text-xs" disabled={!complete || submitting} onClick={submit}>
          Continue
        </Button>
      </div>
    </div>
  );
}
