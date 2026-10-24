/**
 * Detects when an assistant answer ends by offering a next step in prose
 * ("Would you like me to place review markers…?") so the chat can attach
 * one-click reply buttons instead of making the user type "yes".
 */
export interface FollowUpOption {
  label: string;
  /** Message sent as the user's reply. Null = dismiss without sending. */
  reply: string | null;
  primary?: boolean;
}

export interface FollowUpOffer {
  question: string;
  options: FollowUpOption[];
}

const OFFER_RE = /^(?:would you like(?: me)? to|do you want(?: me)? to|want me to|should i|shall i|would it help if i)\s+(.+?)\?\s*$/i;
const MARKER_RE = /\b(?:place|add|drop|put|show|mark)\b[^?]{0,60}\b(?:markers?|markups?|callouts?|pins?|review marks?)\b/i;

function lastParagraph(text: string): string {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return paragraphs[paragraphs.length - 1] ?? '';
}

function lastSentence(paragraph: string): string {
  const flat = paragraph.replace(/\s+/g, ' ').replace(/\*\*/g, '').trim();
  const parts = flat.split(/(?<=[.!])\s+/);
  return parts[parts.length - 1] ?? flat;
}

function toSecondPerson(clause: string): string {
  // "...so you can verify each light" -> "...so I can verify each light"
  return clause
    .replace(/\byou can\b/gi, 'I can')
    .replace(/\byour\b/gi, 'my')
    .replace(/\byou\b/gi, 'me');
}

export function detectFollowUpOffer(answer: string | undefined | null): FollowUpOffer | null {
  if (!answer || typeof answer !== 'string') return null;
  const sentence = lastSentence(lastParagraph(answer));
  if (!sentence.endsWith('?')) return null;
  const match = sentence.match(OFFER_RE);
  if (!match) return null;
  const clause = match[1].trim().replace(/[.\s]+$/, '');
  if (!clause) return null;
  const reply = `Yes, please ${toSecondPerson(clause)}.`;
  const isMarkers = MARKER_RE.test(clause);
  return {
    question: sentence,
    options: [
      { label: isMarkers ? 'Yes, place markers' : 'Yes, go ahead', reply, primary: true },
      { label: 'Not now', reply: null },
    ],
  };
}
