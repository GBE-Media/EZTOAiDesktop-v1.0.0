import { parseAgentDecision } from './decisionParser';

const FALLBACK_MALFORMED =
  'I prepared an action but couldn\'t display it properly — please try again.';

/**
 * Detect agent protocol JSON that must never be shown raw in the chat UI.
 * Matches tool_calls / final / plan / clarify envelopes (and hybrid blobs).
 */
export function looksLikeAgentProtocolJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return false;
  return (
    /"type"\s*:\s*"(tool_calls|final|plan|clarify)"/i.test(trimmed)
    || /"toolCalls"\s*:/.test(trimmed)
    || /"tool_calls"\s*:/.test(trimmed)
  );
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
