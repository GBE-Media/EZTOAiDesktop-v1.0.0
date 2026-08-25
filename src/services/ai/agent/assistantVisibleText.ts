import { parseAgentDecision } from './decisionParser';

const FALLBACK_MALFORMED =
  'I prepared an action but couldn\'t display it properly — please try again.';

const PROTOCOL_TYPES = new Set(['tool_calls', 'final', 'plan', 'clarify']);

/**
 * Detect agent protocol JSON that must never be shown raw in the chat UI.
 * Requires a real JSON object with a recognized `type` field — not a loose
 * substring match on "toolCalls" (which false-positives unrelated JSON).
 * Truncated envelopes that clearly begin as our protocol are also flagged.
 */
export function looksLikeAgentProtocolJson(text: string): boolean {
  const trimmed = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  if (!trimmed.startsWith('{')) return false;

  try {
    let parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      const inner = parsed.trim();
      if (!inner.startsWith('{')) return false;
      parsed = JSON.parse(inner);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const type = String((parsed as Record<string, unknown>).type || '').toLowerCase();
    return PROTOCOL_TYPES.has(type);
  } catch {
    // Unparseable but clearly our envelope prefix (e.g. truncated mid-stream).
    return /^\{\s*"type"\s*:\s*"(tool_calls|final|plan|clarify)"/i.test(trimmed);
  }
}

/**
 * Convert model/assistant text into something safe to show end users.
 * Protocol JSON is re-parsed into a human message; unrecoverable blobs get a
 * clear fallback — never the raw internal payload.
 */
export function sanitizeAssistantVisibleText(text: string | undefined | null): string {
  if (text == null) return '';
  const trimmed = String(text).trim();
  if (!trimmed) return '';
  if (!looksLikeAgentProtocolJson(trimmed)) return trimmed;

  const decision = parseAgentDecision(trimmed);
  if (decision.type === 'final') {
    const message = (decision.message || '').trim();
    return message && !looksLikeAgentProtocolJson(message) ? message : FALLBACK_MALFORMED;
  }
  if (decision.type === 'tool_calls') {
    const status = (decision.assistantText || '').trim();
    if (status && !looksLikeAgentProtocolJson(status)) return status;
    return FALLBACK_MALFORMED;
  }
  if (decision.type === 'clarify') {
    const message = (decision.message || '').trim();
    return message && !looksLikeAgentProtocolJson(message) ? message : FALLBACK_MALFORMED;
  }
  if (decision.type === 'plan') {
    const plan = (decision.plan || '').trim();
    return plan && !looksLikeAgentProtocolJson(plan) ? plan : FALLBACK_MALFORMED;
  }
  return FALLBACK_MALFORMED;
}

export const ASSISTANT_PROTOCOL_DISPLAY_FALLBACK = FALLBACK_MALFORMED;
