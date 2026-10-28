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
    if (field.kind === 'choice' && field.multi && field.recommended) {
      const picked = (field.options || []).filter(o => multiValues(field.recommended).includes(o.value));
      if (picked.length) out[field.id] = multiAnswer(picked);
    } else if (field.kind === 'choice' && field.recommended) {
      const option = field.options?.find(o => o.value === field.recommended);
      if (option) out[field.id] = { value: option.value, label: option.label };
    }
  }
  return out;
}

const multiValues = (value: string | undefined) => (value || '').split(',').map(v => v.trim()).filter(Boolean);
const multiAnswer = (options: Array<{ value: string; label: string }>): ClarificationFieldAnswer | undefined =>
  options.length ? { value: options.map(o => o.value).join(','), label: options.map(o => o.label).join(', ') } : undefined;

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
  const [pickError, setPickError] = useState<string | null>(null);
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
        if (current && current.xPct === pin.xPct && current.yPct === pin.yPct && current.page === pin.page && current.documentId === pin.documentId) return prev;
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
        if (current === list || (!current?.length && !list?.length)) return prev;
        const next = { ...prev };
        if (list?.length) next[field.id] = { areas: list };
        else delete next[field.id];
        return next;
      });
    }
  }, [fields, keyPrefix, pickedAreas]);

  // AI-drafted keep-clear boxes: pre-marked on the drawing; the user keeps, removes or adds.
  useEffect(() => {
    if (!isPending) return;
    for (const field of fields) {
      if (field.kind === 'area' && field.suggestedAreas?.length) {
        useDrawingPickStore.getState().seedAreas(`${keyPrefix}${field.id}`, field.suggestedAreas);
      }
    }
  }, [fields, keyPrefix, isPending]);

  useEffect(() => () => {
    // An unmounted card cannot own the drawing. Normal re-renders don't run this cleanup.
    const state = useDrawingPickStore.getState();
    if (state.request?.key.startsWith(keyPrefix)) state.cancel();
  }, [keyPrefix]);
  useEffect(() => {
    if (!isPending) useDrawingPickStore.getState().clearPins(keyPrefix);
  }, [isPending, keyPrefix]);

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
    if (fields.some(f => f.id === fieldId && f.kind === 'point')) useDrawingPickStore.getState().clearPin(`${keyPrefix}${fieldId}`);
    setAnswers(prev => {
      const next = { ...prev };
      if (answer) next[fieldId] = answer;
      else delete next[fieldId];
      return next;
    });
  };

  const startPick = (field: ClarificationField, mode: 'point' | 'area' = 'point') => {
    setPickError(null);
    const canvas = useCanvasStore.getState();
    // Never silently redirect a card for a closed document to the active tab.
    const documentId = field.documentId || canvas.activeDocId || undefined;
    if (!documentId || !canvas.pdfDocuments[documentId]) {
      setPickError('Reopen the drawing this card refers to, then try again. No point was placed on another document.');
      return;
    }
    if (field.page) openAssistantFocus({ documentId, page: field.page, label: field.pickLabel });
    // Rotation-aware click → page percent needs the page geometry.
    if (documentId) void ensureCachedPageGeometry(documentId, field.page || canvas.getCurrentPage() || 1).catch(() => undefined);
    useDrawingPickStore.getState().start({
      key: `${keyPrefix}${field.id}`,
      label: field.pickLabel || field.prompt,
      documentId,
      page: field.page || canvas.getCurrentPage() || 1,
      mode,
    });
  };

  const complete = fieldsComplete(fields, answers) && !pickRequest?.key.startsWith(keyPrefix);
  const submit = () => {
    if (!complete || submitting) return;
    setSubmitting(true);
    const submitted = { ...answers };
    // Optional area fields left empty: answer "none" so the tool doesn't ask again.
    for (const field of fields) {
      if (field.kind === 'area' && !submitted[field.id]) submitted[field.id] = { areas: [] };
    }
    useDrawingPickStore.getState().clearPins(keyPrefix);
    window.dispatchEvent(new CustomEvent('bidveraai:clarification', {
      detail: {
        clarificationId: clarification.id,
        selectedValues: fields.map(field => submitted[field.id]?.value).filter((v): v is string => !!v),
        displayText: fieldAnswersDisplayText(fields, submitted),
        fields: submitted,
      } satisfies ClarificationAnswerDetail,
    }));
  };

  return (
    <div className="mt-3 space-y-3">
      {pickError && <p role="alert" className="text-xs text-destructive">{pickError}</p>}
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
                    <span className="inline-flex items-center gap-1 rounded-md border border-foreground/30 bg-muted px-2.5 py-1 text-[11px] text-foreground">
                      <MousePointerClick className="h-3 w-3 animate-pulse text-muted-foreground" />
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
              <div className="space-y-1.5 pl-5">
                {!!answer?.areas?.length && (
                  <div className="flex flex-wrap gap-1">
                    {answer.areas.map((area, i) => (
                      <span
                        key={`${i}-${area.xPct}-${area.yPct}`}
                        className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 py-0.5 pl-2 pr-1 text-[11px] text-foreground"
                      >
                        <span className="tabular-nums text-muted-foreground">{i + 1}</span>
                        {area.label || 'Keep clear'}
                        <button
                          type="button"
                          aria-label={`Remove area ${i + 1}`}
                          disabled={submitting}
                          className="rounded p-0.5 text-muted-foreground hover:bg-amber-500/20 hover:text-foreground"
                          onClick={() => useDrawingPickStore.getState().removeArea(pickKey, i)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-1.5">
                  {picking ? (
                    <>
                      <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/50 bg-amber-500/10 px-2.5 py-1 text-[11px] text-foreground">
                        <SquareDashed className="h-3 w-3 animate-pulse text-amber-500" />
                        Drag boxes on the drawing — as many as you need (click a box to remove it)
                      </span>
                      <button type="button" className={chip(false)} onClick={() => useDrawingPickStore.getState().cancel()}>
                        <Check className="mr-1 inline h-3 w-3 align-[-2px]" />Done
                      </button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" disabled={submitting} onClick={() => startPick(field, 'area')}>
                        <SquareDashed className="h-3.5 w-3.5" />
                        {answer?.areas?.length ? 'Add areas' : 'Mark on drawing'}
                      </Button>
                      {!!answer?.areas?.length && (
                        <button type="button" className={chip(false)} disabled={submitting} onClick={() => useDrawingPickStore.getState().clearAreas(pickKey)}>
                          <X className="mr-1 inline h-3 w-3 align-[-2px]" />Clear all
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            )}

            {field.kind === 'choice' && (
              <div className="flex flex-wrap gap-1.5 pl-5">
                {field.options?.map(option => (
                  <button
                    key={option.id}
                    type="button"
                    disabled={submitting}
                    aria-pressed={field.multi ? multiValues(answer?.value).includes(option.value) : undefined}
                    className={chip(field.multi ? multiValues(answer?.value).includes(option.value) : answer?.value === option.value)}
                    onClick={() => {
                      if (!field.multi) {
                        setAnswer(field.id, { value: option.value, label: option.label });
                        return;
                      }
                      const current = multiValues(answer?.value);
                      const next = current.includes(option.value)
                        ? current.filter(v => v !== option.value)
                        : [...current, option.value];
                      const ordered = (field.options || []).filter(o => next.includes(o.value));
                      setAnswer(field.id, multiAnswer(ordered));
                    }}
                  >
                    {field.multi && multiValues(answer?.value).includes(option.value) && (
                      <Check className="mr-1 inline h-3 w-3 align-[-2px]" />
                    )}
                    {option.label}
                    {(field.multi ? multiValues(field.recommended).includes(option.value) : field.recommended === option.value) && (
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
