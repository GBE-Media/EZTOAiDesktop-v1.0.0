import { describe, expect, it } from 'vitest';
import type { AgentModelMessage } from './types';
import type { AIMessage } from '../providers/types';
import {
  agentMessagesToProviderMessages,
  assertOpenAIToolBijection,
  assertOpenAIToolPairing,
  repairToolCallPairing,
} from './providerMessages';
import { toAnthropicChatMessages, toOpenAIChatMessages } from '../providers/toolMessageAdapters';

function historyAfterTwoDifferentTools(): AgentModelMessage[] {
  return [
    { role: 'user', content: 'How many type A fixtures are there?' },
    { role: 'user', content: 'ROUTER_HINT: Prefer a concise final answer. Use tools only if facts are required.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'call_analyze_1',
        name: 'analyze_page',
        arguments: { page: 1, scope: 'full' },
      }],
    },
    {
      role: 'tool',
      name: 'analyze_page',
      toolCallId: 'call_analyze_1',
      content: JSON.stringify({ status: 'completed', summary: 'Analyzed page 1.' }),
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'call_summary_2',
        name: 'getTakeoffSummary',
        arguments: {},
      }],
    },
    {
      role: 'tool',
      name: 'getTakeoffSummary',
      toolCallId: 'call_summary_2',
      content: JSON.stringify({ status: 'completed', summary: 'Read takeoff summary.' }),
    },
  ];
}

describe('providerMessages multi-round tool continuity', () => {
  it('keeps OpenAI + Anthropic pairing valid after analyze_page then getTakeoffSummary', () => {
    const providerMessages = agentMessagesToProviderMessages(historyAfterTwoDifferentTools());
    expect(assertOpenAIToolBijection(providerMessages).ok).toBe(true);

    const anthropic = toAnthropicChatMessages([
      { role: 'system', content: 'sys' },
      ...providerMessages,
    ]);
    const blocks = anthropic.messages.flatMap(m => (
      Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : []
    ));
    const useIds = new Set(blocks.filter(b => b.type === 'tool_use').map(b => String(b.id)));
    const resultIds = blocks.filter(b => b.type === 'tool_result').map(b => String(b.tool_use_id));
    expect(resultIds.every(id => useIds.has(id))).toBe(true);
    expect(useIds.size).toBe(resultIds.length);
  });

  it('keeps pairing valid across three sequential tool rounds', () => {
    const messages: AgentModelMessage[] = [
      { role: 'user', content: 'Count fixtures' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'analyze_page', arguments: { page: 1 } }],
      },
      { role: 'tool', name: 'analyze_page', toolCallId: 'c1', content: '{}' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c2', name: 'getTakeoffSummary', arguments: {} }],
      },
      { role: 'tool', name: 'getTakeoffSummary', toolCallId: 'c2', content: '{}' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c3', name: 'getMaterialCounts', arguments: {} }],
      },
      { role: 'tool', name: 'getMaterialCounts', toolCallId: 'c3', content: '{}' },
    ];

    const providerMessages = agentMessagesToProviderMessages(messages);
    expect(assertOpenAIToolBijection(providerMessages).ok).toBe(true);
  });

  it('bijection: unmatched call_A on assistant + tool result for call_B synthesizes placeholder for call_A', () => {
    // Assistant already has call_A (no result). Tool result arrives for different call_B.
    // Forward-only repair would append call_B and leave call_A unmatched — invalid for OpenAI.
    const broken: AIMessage[] = [
      { role: 'user', content: 'How many?' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_A', name: 'analyze_page', input: { page: 1 } }],
      },
      { role: 'tool', name: 'getTakeoffSummary', toolCallId: 'call_B', content: '{"ok":true}' },
    ];

    expect(assertOpenAIToolBijection(broken).ok).toBe(false);
    const repaired = repairToolCallPairing(broken);
    expect(assertOpenAIToolBijection(repaired).ok).toBe(true);
    expect(assertOpenAIToolPairing(repaired).ok).toBe(true);

    const assistant = repaired.find(m => m.role === 'assistant' && m.toolCalls?.length);
    const callIds = (assistant?.toolCalls || []).map(c => c.id).sort();
    expect(callIds).toEqual(['call_A', 'call_B']);

    const toolIds = repaired.filter(m => m.role === 'tool').map(m => m.toolCallId).sort();
    expect(toolIds).toEqual(['call_A', 'call_B']);

    const placeholder = repaired.find(m => m.role === 'tool' && m.toolCallId === 'call_A');
    expect(placeholder?.content).toContain('synthesized');
  });

  it('same tool twice with blank ids gets distinct paired ids (no call_<name>_1 collision)', () => {
    const messages: AgentModelMessage[] = [
      { role: 'user', content: 'Analyze two pages' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '   ', name: 'analyze_page', arguments: { page: 1, scope: 'full' } }],
      },
      { role: 'tool', name: 'analyze_page', toolCallId: '', content: '{"page":1}' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '\t', name: 'analyze_page', arguments: { page: 2, scope: 'full' } }],
      },
      { role: 'tool', name: 'analyze_page', toolCallId: '  ', content: '{"page":2}' },
    ];

    const providerMessages = agentMessagesToProviderMessages(messages);
    expect(assertOpenAIToolBijection(providerMessages).ok).toBe(true);

    const assistants = providerMessages.filter(m => m.role === 'assistant' && m.toolCalls?.length);
    const ids = assistants.flatMap(m => (m.toolCalls || []).map(c => c.id));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);

    const toolIds = providerMessages.filter(m => m.role === 'tool').map(m => m.toolCallId);
    expect(toolIds).toEqual(ids);
  });

  it('dedupes duplicate tool results for the same call id (keeps last)', () => {
    const duplicated: AIMessage[] = [
      { role: 'user', content: 'Place markups' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'call_1', name: 'place_markups', input: {} }],
      },
      {
        role: 'tool',
        name: 'place_markups',
        toolCallId: 'call_1',
        content: JSON.stringify({ status: 'approval-required', summary: 'Waiting' }),
      },
      {
        role: 'tool',
        name: 'place_markups',
        toolCallId: 'call_1',
        content: JSON.stringify({ status: 'completed', summary: 'Placed 1 markup' }),
      },
    ];

    expect(assertOpenAIToolBijection(duplicated).ok).toBe(false);
    const repaired = repairToolCallPairing(duplicated);
    const tools = repaired.filter(m => m.role === 'tool');
    expect(tools).toHaveLength(1);
    expect(tools[0].toolCallId).toBe('call_1');
    expect(tools[0].content).toContain('Placed 1 markup');
    expect(assertOpenAIToolBijection(repaired).ok).toBe(true);
  });

  it('normalizes AgentToolCallRequest.arguments into AIToolCall.input', () => {
    const messages = agentMessagesToProviderMessages([
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'analyze_page', arguments: { page: 2, scope: 'full' } }],
      },
      { role: 'tool', toolCallId: 'c1', name: 'analyze_page', content: 'ok' },
    ]);
    expect(messages[0].toolCalls?.[0]).toEqual({
      id: 'c1',
      name: 'analyze_page',
      input: { page: 2, scope: 'full' },
    });
  });
});
