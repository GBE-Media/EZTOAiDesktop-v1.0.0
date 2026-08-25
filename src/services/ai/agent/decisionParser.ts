import type { AgentModelDecision, AgentToolCallRequest } from './types';

/** Parse model JSON (or prose fallback) into an agent decision. */
export function parseAgentDecision(raw: string): AgentModelDecision {
  let cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  // Unwrap a single layer of double-encoded JSON strings.
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
    if (typeof parsed === 'string') {
      const inner = parsed.trim();
      try {
        parsed = JSON.parse(inner);
        cleaned = inner;
      } catch {
        return { type: 'final', message: inner || 'I could not produce a structured response.' };
      }
    }
  } catch {
    return { type: 'final', message: cleaned || 'I could not produce a structured response.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { type: 'final', message: String(parsed) };
  }

  const obj = parsed as Record<string, unknown>;
  const type = String(obj.type || '').toLowerCase();

  if (type === 'plan' && typeof obj.plan === 'string') {
    return { type: 'plan', plan: obj.plan };
  }

  if (type === 'clarify') {
    const questions = Array.isArray(obj.questions)
      ? obj.questions.map(item => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            const prompt = (item as Record<string, unknown>).prompt
              ?? (item as Record<string, unknown>).question
              ?? (item as Record<string, unknown>).message;
            return prompt != null ? String(prompt) : '';
          }
          return String(item ?? '');
        }).filter(Boolean)
      : [];
    const decision: Extract<AgentModelDecision, { type: 'clarify' }> = {
      type: 'clarify',
      message: String(obj.message || obj.assistantMessage || questions[0] || 'I need a bit more information.'),
      questions,
    };
    if (Array.isArray(obj.options)) {
      decision.options = obj.options as NonNullable<typeof decision.options>;
    }
    return decision;
  }

  if (type === 'tool_calls' || Array.isArray(obj.toolCalls) || Array.isArray(obj.tool_calls)) {
    const rawCalls = (obj.toolCalls || obj.tool_calls || []) as unknown[];
    const toolCalls: AgentToolCallRequest[] = rawCalls.slice(0, 3).map((call, index) => {
      const item = (call || {}) as Record<string, unknown>;
      const args = item.arguments ?? item.args ?? item.input ?? {};
      return {
        id: String(item.id || `call_${index + 1}`),
        name: String(item.name || item.tool || ''),
        arguments: (typeof args === 'object' && args && !Array.isArray(args)
          ? args
          : typeof args === 'string'
            ? safeParseArgs(args)
            : {}) as Record<string, unknown>,
      };
    }).filter(call => call.name);

    if (toolCalls.length === 0) {
      return {
        type: 'final',
        message: String(obj.assistantText || obj.message || 'No valid tool calls were produced.'),
      };
    }

    // Hybrid envelopes sometimes nest final.message alongside tool_calls.
    const nestedFinal = obj.final && typeof obj.final === 'object' && !Array.isArray(obj.final)
      ? obj.final as Record<string, unknown>
      : null;
    const nestedFinalMessage = nestedFinal && typeof nestedFinal.message === 'string'
      ? nestedFinal.message
      : undefined;

    return {
      type: 'tool_calls',
      toolCalls,
      assistantText: typeof obj.assistantText === 'string'
        ? obj.assistantText
        : nestedFinalMessage,
    };
  }

  if (type === 'final' || obj.message || obj.assistantMessage) {
    const clarifyingQuestions = Array.isArray(obj.clarifyingQuestions)
      ? obj.clarifyingQuestions.map(String)
      : undefined;
    return {
      type: 'final',
      message: String(obj.message || obj.assistantMessage || ''),
      clarifyingQuestions,
    };
  }

  return { type: 'final', message: cleaned };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}
