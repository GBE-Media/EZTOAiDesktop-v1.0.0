import type { AIMessage, AIToolCall } from '../providers/types';
import type { AgentModelMessage, AgentToolCallRequest } from '../agent/types';

/**
 * Convert agent session messages into provider AIMessage[] without dropping
 * native tool metadata. Also repairs multi-round pairing so OpenAI/Anthropic
 * see a strict 1:1 bijection between assistant tool_calls and tool results.
 */
export function agentMessagesToProviderMessages(
  messages: AgentModelMessage[],
): AIMessage[] {
  const ids = createToolCallIdAllocator();
  const mapped: AIMessage[] = [];
  /** Open assistant tool-call ids awaiting tool results (order matters for blank ids). */
  let pendingCallIds: string[] = [];
  let pendingClaimIndex = 0;

  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      const rawId = typeof message.toolCallId === 'string' ? message.toolCallId.trim() : '';
      let toolCallId: string;
      if (!rawId) {
        // Blank result id: claim the next unmatched id from the preceding assistant
        // group so same-tool-twice histories stay paired under one global allocator.
        toolCallId = pendingCallIds[pendingClaimIndex] || ids.allocate();
        pendingClaimIndex += 1;
      } else {
        // Explicit id may already be reserved by the assistant — that is correct pairing,
        // not a collision. keep() allows reuse.
        toolCallId = ids.keep(rawId);
        const claimAt = pendingCallIds.indexOf(toolCallId, pendingClaimIndex);
        if (claimAt >= pendingClaimIndex) {
          pendingClaimIndex = claimAt + 1;
        }
      }
      mapped.push({
        role: 'tool',
        content: message.content ?? '',
        toolCallId,
        name: message.name,
      });
      continue;
    }

    if (message.role === 'assistant') {
      const toolCalls = normalizeToolCalls(message.toolCalls, ids);
      if (toolCalls.length > 0) {
        pendingCallIds = toolCalls.map(call => call.id);
        pendingClaimIndex = 0;
        mapped.push({
          role: 'assistant',
          content: message.content ?? '',
          toolCalls,
        });
        continue;
      }
      pendingCallIds = [];
      pendingClaimIndex = 0;
      mapped.push({
        role: 'assistant',
        content: message.content ?? '',
      });
      continue;
    }

    pendingCallIds = [];
    pendingClaimIndex = 0;
    mapped.push({
      role: 'user',
      content: message.content ?? '',
    });
  }

  return repairToolCallPairing(mapped);
}

/**
 * Establish a true bijection between assistant tool_calls and following tool
 * results within each tool round:
 * - every tool result id appears on the nearest preceding assistant tool_calls
 * - every assistant tool_call has exactly one following tool result
 *
 * Choice for unmatched assistant tool_calls: synthesize a placeholder tool
 * result (do not drop the call). Dropping would silently rewrite what the model
 * requested; a failed-placeholder keeps OpenAI/Anthropic valid while preserving
 * that the call existed in history (e.g. lost result / partial repair).
 *
 * Duplicate tool-role messages sharing one toolCallId: keep the LAST one in the
 * consecutive tool block (chronological). Approval resume already replaces the
 * pending result in place (runnerCore.appendApprovalOutcomeMessage), so duplicates
 * are not expected from the live loop after ID canonicalization — but if a stale
 * "approval-required" and a later completed outcome both remain (corrupt/old
 * session, double-append), the later message is the authoritative execution
 * outcome. Same rationale for retries.
 */
export function repairToolCallPairing(messages: AIMessage[]): AIMessage[] {
  const out: AIMessage[] = messages.map(message => ({
    ...message,
    toolCalls: message.toolCalls ? message.toolCalls.map(call => ({ ...call })) : undefined,
  }));

  // Forward: ensure each tool result is listed on the preceding assistant.
  for (let i = 0; i < out.length; i += 1) {
    const message = out[i];
    if (message.role !== 'tool') continue;

    const toolCallId = String(message.toolCallId || '').trim() || `call_orphan_${i}`;
    message.toolCallId = toolCallId;

    const assistantIndex = findPrecedingAssistantIndex(out, i);
    if (assistantIndex < 0) {
      out.splice(i, 0, {
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: toolCallId,
          name: message.name || 'tool',
          input: {},
        }],
      });
      i += 1;
      continue;
    }

    const assistant = out[assistantIndex];
    const existing = assistant.toolCalls || [];
    if (!existing.some(call => call.id === toolCallId)) {
      assistant.toolCalls = [
        ...existing,
        {
          id: toolCallId,
          name: message.name || 'tool',
          input: {},
        },
      ];
    }
  }

  // Dedupe: within each consecutive tool-result block, at most one message per
  // toolCallId (keep last — see file-level policy above).
  dedupeToolResultsKeepLast(out);

  // Reverse: every assistant tool_call must have a matching tool result in the
  // immediately following consecutive tool-role block.
  for (let i = 0; i < out.length; i += 1) {
    const assistant = out[i];
    if (assistant.role !== 'assistant' || !assistant.toolCalls?.length) continue;

    const resultIds = new Set<string>();
    let j = i + 1;
    while (j < out.length && out[j].role === 'tool') {
      resultIds.add(String(out[j].toolCallId || ''));
      j += 1;
    }

    const missing = assistant.toolCalls.filter(call => !resultIds.has(call.id));
    if (missing.length === 0) continue;

    const insertAt = j;
    const placeholders: AIMessage[] = missing.map(call => ({
      role: 'tool' as const,
      name: call.name,
      toolCallId: call.id,
      content: JSON.stringify({
        status: 'failed',
        summary: 'Tool result unavailable; synthesized for provider pairing.',
        synthesized: true,
      }),
    }));
    out.splice(insertAt, 0, ...placeholders);
    i = insertAt + placeholders.length - 1;
  }

  return out;
}

/**
 * Collapse duplicate tool-role messages that share a toolCallId inside each
 * consecutive tool block. Keeps the last occurrence of each id (deterministic).
 */
function dedupeToolResultsKeepLast(messages: AIMessage[]): void {
  let i = 0;
  while (i < messages.length) {
    if (messages[i].role !== 'tool') {
      i += 1;
      continue;
    }
    const start = i;
    while (i < messages.length && messages[i].role === 'tool') {
      i += 1;
    }
    const block = messages.slice(start, i);
    const lastById = new Map<string, AIMessage>();
    const order: string[] = [];
    for (const msg of block) {
      const id = String(msg.toolCallId || '');
      if (!lastById.has(id)) order.push(id);
      lastById.set(id, msg);
    }
    const deduped = order.map(id => lastById.get(id)!);
    if (deduped.length === block.length) continue;
    messages.splice(start, block.length, ...deduped);
    i = start + deduped.length;
  }
}

/** One-directional: every tool message is covered by a preceding assistant tool_calls id. */
export function assertOpenAIToolPairing(messages: AIMessage[]): {
  ok: boolean;
  problems: Array<{ index: number; toolCallId: string }>;
} {
  const problems: Array<{ index: number; toolCallId: string }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role !== 'tool') continue;
    const toolCallId = String(message.toolCallId || '');
    const assistantIndex = findPrecedingAssistantIndex(messages, i);
    if (assistantIndex < 0) {
      problems.push({ index: i, toolCallId });
      continue;
    }
    const calls = messages[assistantIndex].toolCalls || [];
    if (!calls.some(call => call.id === toolCallId)) {
      problems.push({ index: i, toolCallId });
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Strict bijection: each assistant tool_call in a round has exactly one tool
 * result in the following consecutive tool block, and each tool result maps to
 * exactly one call on that assistant.
 */
export function assertOpenAIToolBijection(messages: AIMessage[]): {
  ok: boolean;
  problems: string[];
} {
  const problems: string[] = [];
  const forward = assertOpenAIToolPairing(messages);
  for (const problem of forward.problems) {
    problems.push(`tool@${problem.index} id=${problem.toolCallId} has no preceding assistant tool_calls entry`);
  }

  for (let i = 0; i < messages.length; i += 1) {
    const assistant = messages[i];
    if (assistant.role !== 'assistant' || !assistant.toolCalls?.length) continue;

    const resultIds: string[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') {
      resultIds.push(String(messages[j].toolCallId || ''));
      j += 1;
    }

    const callIds = assistant.toolCalls.map(call => call.id);
    for (const id of callIds) {
      const count = resultIds.filter(r => r === id).length;
      if (count !== 1) {
        problems.push(`assistant@${i} tool_call ${id} has ${count} matching tool results (want 1)`);
      }
    }
    for (const id of resultIds) {
      if (!callIds.includes(id)) {
        problems.push(`tool result ${id} after assistant@${i} not listed in tool_calls`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}

function findPrecedingAssistantIndex(messages: AIMessage[], toolIndex: number): number {
  for (let j = toolIndex - 1; j >= 0; j -= 1) {
    const prev = messages[j];
    if (prev.role === 'tool') continue;
    if (prev.role === 'assistant') return j;
    return -1;
  }
  return -1;
}

function normalizeToolCalls(
  raw: AgentToolCallRequest[] | AIToolCall[] | undefined,
  ids: ToolCallIdAllocator,
): AIToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  return raw.map((call, index) => {
    const record = call as AgentToolCallRequest & AIToolCall & { arguments?: unknown; input?: unknown };
    const name = String(record.name || `tool_${index + 1}`);
    // Preserve non-blank ids already stored on the session (may repeat across
    // sequential rounds). Only allocate for blank/missing — within-batch
    // collisions are resolved earlier by canonicalizeAgentToolCalls.
    const trimmed = typeof record.id === 'string' ? record.id.trim() : '';
    const id = trimmed ? ids.keep(trimmed) : ids.allocate();
    const input = record.input != null
      ? record.input
      : (record.arguments != null ? record.arguments : {});
    return { id, name, input };
  }).filter(call => call.name);
}

export interface ToolCallIdAllocator {
  /** Assistant side: preferred if unused, else monotonic call_N. */
  allocateUnique: (preferred?: string) => string;
  /** Tool-result side with explicit id: keep as-is (reuse of assistant id is expected). */
  keep: (preferred: string) => string;
  /** Fresh unique id (blank tool ids that cannot claim a pending assistant id). */
  allocate: () => string;
}

/**
 * Monotonic id allocator for one history-build pass. Missing/blank ids become
 * call_1, call_2, ... (not name-scoped) so the same tool called twice cannot collide.
 */
export function createToolCallIdAllocator(): ToolCallIdAllocator {
  let next = 1;
  const used = new Set<string>();

  const allocate = (): string => {
    let id: string;
    do {
      id = `call_${next}`;
      next += 1;
    } while (used.has(id));
    used.add(id);
    return id;
  };

  return {
    allocateUnique(preferred?: string): string {
      const trimmed = typeof preferred === 'string' ? preferred.trim() : '';
      if (trimmed && !used.has(trimmed)) {
        used.add(trimmed);
        return trimmed;
      }
      return allocate();
    },
    keep(preferred: string): string {
      const trimmed = preferred.trim();
      if (trimmed) {
        used.add(trimmed);
        return trimmed;
      }
      return allocate();
    },
    allocate,
  };
}
