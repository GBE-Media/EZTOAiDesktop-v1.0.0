/**
 * Safety net: the model sometimes ends a turn asking the user for something in plain prose
 * ("Please provide the fixture load…"). Every question must be a card, so turn those into one.
 */
import type { ClarificationField } from '@/types/assistant';
import type { AskUserRequest } from './askUser';

const ASK_RE = new RegExp(
  [
    String.raw`\bplease (?:provide|confirm|specify|share|tell me|let me know|upload|point me|send|clarify|choose|select|pick|advise|indicate|mark|show me)\b`,
    String.raw`\blet me know (?:which|what|whether|if|the|how|where)\b`,
    String.raw`\bpoint me (?:to|at)\b`,
    String.raw`\b(?:could|can|would) you (?:please )?(?:provide|confirm|tell|share|point|specify|clarify|upload|send|show|mark|choose|select|pick)\b`,
    String.raw`\bi (?:will |'ll )?need (?:you to|your|to know|the user)\b`,
    String.raw`\b(?:waiting|need) (?:for )?(?:your|the user's) (?:input|answer|confirmation)\b`,
  ].join('|'),
  'i',
);

/** Offers of a next step are shown as follow-up chips already. */
const OFFER_RE = /^(?:want me to|would you like me to|shall i|do you want me to|should i go ahead)\b/i;
const DRAWING_RE = /\b(point me|show me|on the drawing|which (?:sheet|page)|where (?:is|are)|mark|locate|the location)\b/i;

function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.?!])\s+(?=[A-Z0-9"“(])/)
    .map(s => s.trim())
    .filter(Boolean);
}

function stripMarkdown(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/^#+\s*/gm, '').replace(/^\s*[-*]\s+/gm, '');
}

export interface ProseQuestionCard {
  ask: AskUserRequest;
  /** The message without the question (shown above the card). */
  remainder: string;
}

/** A card for a final message that asks the user for input in prose, or null. */
export function proseQuestionToCard(message: string, page?: number): ProseQuestionCard | null {
  const text = stripMarkdown(message || '').trim();
  if (!text) return null;
  const all = sentences(text);
  if (!all.length) return null;
  // Only the closing part of the message counts: an ask buried mid-answer is usually rhetorical.
  const tail = all.slice(-3);
  const asks = tail.filter(s => (ASK_RE.test(s) || /\?$/.test(s)) && !OFFER_RE.test(s));
  if (!asks.length) return null;
  const question = asks.join(' ').slice(0, 280);
  const example = /e\.g\.,?\s*["“']([^"”']{2,60})["”']/i.exec(question)?.[1];
  const wantsDrawing = DRAWING_RE.test(question);
  const fields: ClarificationField[] = [
    {
      id: 'answer',
      kind: 'text',
      prompt: asks.length === 1 ? 'Your answer' : 'Your answers',
      placeholder: example ? `e.g. ${example}` : 'Type your answer…',
      ...(wantsDrawing ? { optional: true } : {}),
    },
  ];
  if (wantsDrawing) {
    fields.push({
      id: 'location',
      kind: 'point',
      prompt: 'Or show me on the drawing',
      ...(page ? { page } : {}),
      pickLabel: 'Click the spot on the drawing',
      optional: true,
    });
  }
  let remainder = message;
  for (const ask of asks) remainder = remainder.includes(ask) ? remainder.replace(ask, '') : remainder;
  remainder = remainder.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return {
    ask: { question, fields },
    remainder,
  };
}
