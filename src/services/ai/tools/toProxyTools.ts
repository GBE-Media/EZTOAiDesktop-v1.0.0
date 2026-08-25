import type { AIToolCall, AIToolDefinition } from '../providers/types';
import type { AgentModelDecision, AgentToolCallRequest } from '../agent/types';
import { listAssistantTools, getAssistantTool } from './registry';
import { zodToJsonSchema } from './zodToJsonSchema';
import { parseAgentDecision } from '../agent/decisionParser';
import {
  looksLikeAgentProtocolJson,
  sanitizeAssistantVisibleText,
} from '../agent/assistantVisibleText';

/**
 * Convert the live assistant tool registry into proxy/provider tool definitions.
 * Uses each tool's Zod `schema` as JSON Schema `inputSchema` (per-tool mutation shapes).
 */
export function assistantToolsToProxyDefinitions(): AIToolDefinition[] {
  return listAssistantTools().map(tool => ({
    name: tool.id,
    description: [
      tool.description,
      tool.requiresConfirmation ? 'Requires user approval before applying changes.' : null,
      tool.isStub ? 'Stub — may not return real data yet.' : null,
    ].filter(Boolean).join(' '),
    inputSchema: zodToJsonSchema(tool.schema),
  }));
}

/**
 * Prefer native provider toolCalls when present, but ALSO merge any JSON-protocol
 * tool_calls embedded in content (models often dual-emit). Never leak raw protocol
 * JSON into assistantText — that previously dumped place_markups payloads into chat
 * and skipped the approval UI.
 */
export function decisionFromCompletion(options: {
  content: string;
  toolCalls?: AIToolCall[] | null;
}): AgentModelDecision {
  const nativeCalls = mapNativeToolCalls(options.toolCalls);
  const contentTrimmed = typeof options.content === 'string' ? options.content.trim() : '';
  const contentDecision = contentTrimmed && looksLikeAgentProtocolJson(contentTrimmed)
    ? parseAgentDecision(contentTrimmed)
    : null;

  if (nativeCalls.length > 0) {
    const fromJson = contentDecision?.type === 'tool_calls'
      ? contentDecision.toolCalls
      : [];
    const toolCalls = mergeToolCalls(nativeCalls, fromJson).slice(0, 3);

    return {
      type: 'tool_calls',
      toolCalls,
      assistantText: humanAssistantText(contentTrimmed, contentDecision) || undefined,
    };
  }

  // No native tools — full JSON / prose decision parser.
  const decision = parseAgentDecision(options.content || '');
  if (decision.type === 'tool_calls') {
    return {
      ...decision,
      assistantText: sanitizeAssistantVisibleText(decision.assistantText) || undefined,
    };
  }
  if (decision.type === 'final') {
    return {
      ...decision,
      message: sanitizeAssistantVisibleText(decision.message) || decision.message,
    };
  }
  return decision;
}

function mapNativeToolCalls(toolCalls?: AIToolCall[] | null): AgentToolCallRequest[] {
  const native = toolCalls || [];
  return native.map((call, index) => {
    const input = call.input;
    const args = (typeof input === 'object' && input && !Array.isArray(input)
      ? input
      : typeof input === 'string'
        ? safeParseObject(input)
        : {}) as Record<string, unknown>;
    return {
      id: String(call.id || `call_${index + 1}`),
      name: String(call.name || ''),
      arguments: args,
    };
  }).filter(call => call.name);
}

/**
 * Union native + JSON-protocol calls. Approval-required mutations are ordered first
 * so a dual-emit place_markups is not dropped by the 3-call cap behind read tools.
 */
export function mergeToolCalls(
  native: AgentToolCallRequest[],
  fromJson: AgentToolCallRequest[],
): AgentToolCallRequest[] {
  const seen = new Set<string>();
  const out: AgentToolCallRequest[] = [];

  const keyOf = (call: AgentToolCallRequest) =>
    `${call.name}|${stableArgsKey(call.arguments)}`;

  const push = (call: AgentToolCallRequest) => {
    if (!call.name) return;
    const key = keyOf(call);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(call);
  };

  const all = [...native, ...fromJson];
  for (const call of all) {
    if (getAssistantTool(call.name)?.requiresConfirmation) push(call);
  }
  for (const call of all) push(call);
  return out;
}

function humanAssistantText(
  content: string,
  contentDecision: AgentModelDecision | null,
): string {
  if (contentDecision?.type === 'tool_calls') {
    return sanitizeAssistantVisibleText(contentDecision.assistantText);
  }
  if (contentDecision?.type === 'final') {
    return sanitizeAssistantVisibleText(contentDecision.message);
  }
  if (contentDecision?.type === 'clarify') {
    return sanitizeAssistantVisibleText(contentDecision.message);
  }
  if (contentDecision?.type === 'plan') {
    return sanitizeAssistantVisibleText(contentDecision.plan);
  }
  if (!content) return '';
  if (looksLikeAgentProtocolJson(content)) {
    return sanitizeAssistantVisibleText(content);
  }
  return content.trim();
}

/**
 * Deterministic deep serialization for tool-call dedup keys.
 * Sorts object keys at every nesting level; preserves array element order.
 * Must NOT use JSON.stringify's property-allowlist replacer (that strips nested fields).
 */
export function stableArgsKey(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(normalizeForStableKey(args));
  } catch {
    return String(args);
  }
}

function normalizeForStableKey(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(item => normalizeForStableKey(item));
  }
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = normalizeForStableKey(obj[key]);
  }
  return sorted;
}

function safeParseObject(raw: string): Record<string, unknown> {
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
