import type { AgentModelDecision, AgentToolCallRequest } from './types';

/** Parse model JSON (or prose fallback) into an agent decision. */
export function parseAgentDecision(raw: string): AgentModelDecision {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
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
      ? obj.questions.map(String)
      : [];
    return {
      type: 'clarify',
      message: String(obj.message || obj.assistantMessage || 'I need a bit more information.'),
      questions,
    };
  }

  if (type === 'tool_calls' || Array.isArray(obj.toolCalls) || Array.isArray(obj.tool_calls)) {
    const rawCalls = (obj.toolCalls || obj.tool_calls || []) as unknown[];
    const toolCalls: AgentToolCallRequest[] = rawCalls.slice(0, 3).map((call, index) => {
      const item = (call || {}) as Record<string, unknown>;
      const args = item.arguments ?? item.args ?? {};
      return {
        id: String(item.id || `call_${index + 1}`),
        name: String(item.name || item.tool || ''),
        arguments: (typeof args === 'object' && args && !Array.isArray(args)
          ? args
          : {}) as Record<string, unknown>,
      };
    }).filter(call => call.name);

    if (toolCalls.length === 0) {
      return {
        type: 'final',
        message: String(obj.assistantText || obj.message || 'No valid tool calls were produced.'),
      };
    }

    return {
      type: 'tool_calls',
      toolCalls,
      assistantText: typeof obj.assistantText === 'string' ? obj.assistantText : undefined,
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
