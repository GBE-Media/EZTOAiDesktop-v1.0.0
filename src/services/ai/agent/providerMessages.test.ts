import { describe, expect, it } from 'vitest';
import type { AgentModelMessage } from './types';
import type { AIMessage } from '../providers/types';
import {
  agentMessagesToProviderMessages,
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

function assertOpenAIOutboundPairing(messages: AIMessage[]) {
  const openai = toOpenAIChatMessages(messages);
  for (let i = 0; i < openai.length; i += 1) {
    const msg = openai[i];
    if (msg.role !== 'tool') continue;
    let found = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = openai[j];
      if (prev.role === 'tool') continue;
      if (prev.role === 'assistant' && Array.isArray(prev.tool_calls)) {
        found = prev.tool_calls.some(call => call.id === msg.tool_call_id);
      }
      break;
    }
    expect(found, `tool at messages[${i}] missing preceding tool_calls`).toBe(true);
  }
  return openai;
}

describe('providerMessages multi-round tool continuity', () => {
  it('keeps OpenAI + Anthropic pairing valid after analyze_page then getTakeoffSummary', () => {
    const providerMessages = agentMessagesToProviderMessages(historyAfterTwoDifferentTools());
    expect(assertOpenAIToolPairing(providerMessages).ok).toBe(true);
    assertOpenAIOutboundPairing([
      { role: 'system', content: 'sys' },
      ...providerMessages,
    ]);

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
    expect(assertOpenAIToolPairing(providerMessages).ok).toBe(true);
    assertOpenAIOutboundPairing(providerMessages);
  });

  it('repairs assistant toolCalls when they were dropped before tool results', () => {
    const broken: AIMessage[] = [
      { role: 'user', content: 'How many?' },
      { role: 'assistant', content: '' },
      { role: 'tool', name: 'analyze_page', toolCallId: 'call_analyze_1', content: '{}' },
      { role: 'assistant', content: '' },
      { role: 'tool', name: 'getTakeoffSummary', toolCallId: 'call_summary_2', content: '{}' },
    ];

    expect(assertOpenAIToolPairing(broken).ok).toBe(false);
    const repaired = repairToolCallPairing(broken);
    expect(assertOpenAIToolPairing(repaired).ok).toBe(true);
    expect(repaired[1].toolCalls?.[0]?.id).toBe('call_analyze_1');
    expect(repaired[3].toolCalls?.[0]?.id).toBe('call_summary_2');
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
