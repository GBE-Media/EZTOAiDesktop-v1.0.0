/**
 * Structured "ask the user" cards: several questions in one card (choices, a point picked on the
 * drawing, typed answers). Tools return `askUser` to pause the run deterministically; the model can
 * send the same `fields` on a clarify payload. Answers resume the same run.
 */
import type {
  AssistantFocus,
  ClarificationField,
  ClarificationFieldAnswer,
  ClarificationRequest,
  PickedPoint,
} from '@/types/assistant';

export interface AskUserRequest {
  question: string;
  description?: string;
  fields: ClarificationField[];
  focus?: AssistantFocus;
  /** Re-run this tool with the answers merged in (field id → argument path). */
  resume?: { toolId: string; args: Record<string, unknown>; apply: Record<string, string> };
}

const KINDS = new Set(['choice', 'point', 'text', 'area']);

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parsePoint(raw: unknown): PickedPoint | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const x = num(obj.xPct ?? obj.x);
  const y = num(obj.yPct ?? obj.y);
  const page = num(obj.page);
  if (x == null || y == null || x < 0 || x > 100 || y < 0 || y > 100) return undefined;
  return {
    ...(str(obj.documentId) ? { documentId: str(obj.documentId) } : {}),
    page: page && page > 0 ? Math.round(page) : 0,
    xPct: x,
    yPct: y,
  };
}

/** Validate model/tool supplied fields (drops anything malformed, caps at 5). */
export function sanitizeClarificationFields(raw: unknown): ClarificationField[] {
  if (!Array.isArray(raw)) return [];
  const out: ClarificationField[] = [];
  const seen = new Set<string>();
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const kind = str(obj.kind || obj.type).toLowerCase();
    const prompt = str(obj.prompt || obj.question || obj.label);
    if (!KINDS.has(kind) || !prompt) continue;
    let id = str(obj.id) || `field_${index + 1}`;
    while (seen.has(id)) id = `${id}_${index + 1}`;
    seen.add(id);
    const options = Array.isArray(obj.options)
      ? obj.options.flatMap((option, optionIndex) => {
        if (!option || typeof option !== 'object') return [];
        const o = option as Record<string, unknown>;
        const label = str(o.label);
        const value = str(o.value) || label;
        if (!label) return [];
        const point = parsePoint(o.point);
        return [{ id: str(o.id) || `${id}_opt_${optionIndex + 1}`, label, value, ...(point ? { point } : {}) }];
      }).slice(0, 8)
      : undefined;
    if (kind === 'choice' && !options?.length) continue;
    const page = num(obj.page);
    out.push({
      id,
      prompt,
      kind: kind as ClarificationField['kind'],
      ...(options?.length ? { options } : {}),
      ...(str(obj.recommended) ? { recommended: str(obj.recommended) } : {}),
      ...(kind === 'choice' && obj.multi === true ? { multi: true } : {}),
      ...(str(obj.documentId) ? { documentId: str(obj.documentId) } : {}),
      ...(page && page > 0 ? { page: Math.round(page) } : {}),
      ...(str(obj.pickLabel) ? { pickLabel: str(obj.pickLabel) } : {}),
      ...(obj.optional === true ? { optional: true } : {}),
      ...(str(obj.placeholder) ? { placeholder: str(obj.placeholder) } : {}),
    });
    if (out.length >= 5) break;
  }
  return out;
}

/** Is every required field answered? */
export function fieldsComplete(fields: ClarificationField[], answers: Record<string, ClarificationFieldAnswer>): boolean {
  return fields.every(field => {
    if (field.optional) return true;
    const answer = answers[field.id];
    if (!answer) return false;
    if (field.kind === 'point') return !!answer.point || !!str(answer.value);
    if (field.kind === 'area') return !!answer.areas?.length || !!str(answer.value);
    return !!str(answer.value);
  });
}

export function describeFieldAnswer(field: ClarificationField, answer: ClarificationFieldAnswer | undefined): string {
  if (!answer) return 'skipped';
  if (answer.areas?.length) return `${answer.areas.length} area${answer.areas.length === 1 ? '' : 's'} marked`;
  if (answer.point) {
    return answer.label
      ? answer.label
      : `picked on page ${answer.point.page}`;
  }
  return answer.label || str(answer.value) || 'skipped';
}

/** Short one-line summary shown on the answered card / in the chat. */
export function fieldAnswersDisplayText(fields: ClarificationField[], answers: Record<string, ClarificationFieldAnswer>): string {
  return fields
    .filter(field => answers[field.id])
    .map(field => `${shortPrompt(field.prompt)}: ${describeFieldAnswer(field, answers[field.id])}`)
    .join(' · ') || 'Answered';
}

function shortPrompt(prompt: string): string {
  return prompt.replace(/\?$/, '').replace(/^(which|what|where is|where's)\s+/i, '').replace(/^\w/, c => c.toUpperCase()).slice(0, 48);
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.').filter(Boolean);
  let cursor: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== 'object') cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * Merge answers into the tool arguments. Point answers set `<path>.x` / `<path>.y` (display
 * percent) and `<path>.page`; choice/text answers set `<path>`.
 */
export function applyFieldAnswers(
  args: Record<string, unknown>,
  apply: Record<string, string>,
  answers: Record<string, ClarificationFieldAnswer>,
): Record<string, unknown> {
  const merged = JSON.parse(JSON.stringify(args || {})) as Record<string, unknown>;
  for (const [fieldId, rawPath] of Object.entries(apply)) {
    const answer = answers[fieldId];
    if (!answer || !rawPath) continue;
    // "path#num": the answer is a number (e.g. "40" or a typed "52 VA").
    const numeric = rawPath.endsWith('#num');
    const path = numeric ? rawPath.slice(0, -4) : rawPath;
    // "path#list": a multi-select / typed list ("A, C") becomes a string array.
    if (rawPath.endsWith('#list')) {
      const list = str(answer.value).split(/[,;/]|\band\b/i).map(v => v.trim()).filter(Boolean);
      if (list.length) setPath(merged, rawPath.slice(0, -5), [...new Set(list)]);
      continue;
    }
    if (numeric) {
      const n = parseFloat(str(answer.value).replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) setPath(merged, path, n);
      continue;
    }
    if (answer.areas) {
      setPath(merged, path, answer.areas.map(area => ({
        x: round1(area.xPct),
        y: round1(area.yPct),
        width: round1(area.wPct),
        height: round1(area.hPct),
        ...(area.label ? { label: area.label } : {}),
      })));
      continue;
    }
    if (answer.point) {
      setPath(merged, `${path}.x`, round1(answer.point.xPct));
      setPath(merged, `${path}.y`, round1(answer.point.yPct));
      continue;
    }
    const value = str(answer.value);
    if (value.startsWith('flag:')) {
      setPath(merged, `${path}.${value.slice(5)}`, true);
      continue;
    }
    if (value) setPath(merged, path, value);
  }
  return merged;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Lines appended to the conversation when the user answers a structured card. */
export function formatFieldAnswersForModel(
  clarification: Pick<ClarificationRequest, 'fields' | 'resume'>,
  answers: Record<string, ClarificationFieldAnswer>,
): string[] {
  const fields = clarification.fields || [];
  const lines: string[] = [];
  for (const field of fields) {
    const answer = answers[field.id];
    if (!answer) {
      lines.push(`- ${field.id}: (not answered)`);
      continue;
    }
    if (answer.areas) {
      lines.push(`- ${field.id}: user marked ${answer.areas.length} area${answer.areas.length === 1 ? '' : 's'}${answer.areas.length ? `: ${answer.areas.map(a => `x=${round1(a.xPct)} y=${round1(a.yPct)} w=${round1(a.wPct)} h=${round1(a.hPct)}`).join('; ')} (percent of the displayed page)` : ''}`);
    } else if (answer.point) {
      const p = answer.point;
      lines.push(`- ${field.id}: user picked a point on page ${p.page}${p.documentId ? ` of document ${p.documentId}` : ''} at x=${round1(p.xPct)}, y=${round1(p.yPct)} (percent of the displayed page)${answer.label ? ` — ${answer.label}` : ''}`);
    } else {
      lines.push(`- ${field.id}: ${str(answer.value)}${answer.label && answer.label !== answer.value ? ` (${answer.label})` : ''}`);
    }
  }
  if (clarification.resume) {
    const merged = applyFieldAnswers(clarification.resume.args, clarification.resume.apply, answers);
    lines.push(`Now call ${clarification.resume.toolId} with exactly these arguments: ${JSON.stringify(merged)}`);
  }
  return lines;
}
