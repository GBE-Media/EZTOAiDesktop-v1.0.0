import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIMessage } from '../providers/types';
import type { AgentModelMessage } from './types';
import { assertOpenAIToolPairing } from './providerMessages';
import { toOpenAIChatMessages } from '../providers/toolMessageAdapters';

const { visionForRole, completeForRole, getAgentRoleConfig } = vi.hoisted(() => ({
  visionForRole: vi.fn(),
  completeForRole: vi.fn(),
  getAgentRoleConfig: vi.fn(() => ({ provider: 'openai', model: 'gpt-4o' })),
}));

vi.mock('../aiService', () => ({
  getAIService: () => ({
    visionForRole,
    completeForRole,
    getAgentRoleConfig,
  }),
}));

vi.mock('./tools/registerAll', () => ({
  registerAllAgentTools: vi.fn(),
}));

vi.mock('../tools/toProxyTools', async () => {
  const actual = await vi.importActual<typeof import('../tools/toProxyTools')>('../tools/toProxyTools');
  return {
    ...actual,
    assistantToolsToProxyDefinitions: () => [],
  };
});

import { createJsonToolModelAdapter } from './modelAdapter';

function historyAfterTwoDifferentTools(): AgentModelMessage[] {
  return [
    { role: 'user', content: 'How many type A fixtures are there?' },
    { role: 'user', content: 'ROUTER_HINT: Prefer a concise final answer.' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_analyze_1', name: 'analyze_page', arguments: { page: 1, scope: 'full' } }],
    },
    {
      role: 'tool',
      name: 'analyze_page',
      toolCallId: 'call_analyze_1',
      content: '{"summary":"Analyzed page 1."}',
    },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_summary_2', name: 'getTakeoffSummary', arguments: {} }],
    },
    {
      role: 'tool',
      name: 'getTakeoffSummary',
      toolCallId: 'call_summary_2',
      content: '{"summary":"Read takeoff summary."}',
    },
  ];
}

describe('non-vision multi-round continue (Continue step N)', () => {
  beforeEach(() => {
    completeForRole.mockReset();
    visionForRole.mockReset();
    completeForRole.mockResolvedValue({
      content: JSON.stringify({ type: 'final', message: 'There are 12 type A fixtures.' }),
      model: 'gpt-4o',
      toolCalls: [],
    });
  });

  it('third complete sends OpenAI-valid pairing for two prior different tools', async () => {
    const adapter = createJsonToolModelAdapter('primary');
    await adapter.complete({
      runId: 'run-multi',
      messages: historyAfterTwoDifferentTools(),
      contextText: 'ctx',
    });

    expect(completeForRole).toHaveBeenCalledOnce();
    expect(visionForRole).not.toHaveBeenCalled();

    const request = completeForRole.mock.calls[0][1] as { messages: AIMessage[]; temperature?: number };
    const withoutSystem = request.messages.filter(m => m.role !== 'system');
    expect(assertOpenAIToolPairing(withoutSystem).ok).toBe(true);

    const openai = toOpenAIChatMessages(request.messages);
    const toolMsgs = openai.filter(m => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    for (let index = 0; index < openai.length; index += 1) {
      const msg = openai[index];
      if (msg.role !== 'tool') continue;
      const tool = msg as { tool_call_id: string };
      let found = false;
      for (let j = index - 1; j >= 0; j -= 1) {
        const prev = openai[j];
        if (prev.role === 'tool') continue;
        if (prev.role === 'assistant' && Array.isArray(prev.tool_calls)) {
          found = prev.tool_calls.some(call => call.id === tool.tool_call_id);
        }
        break;
      }
      expect(found).toBe(true);
    }
  });

  it('omits temperature for temperature-restricted models', async () => {
    getAgentRoleConfig.mockReturnValueOnce({ provider: 'lovable', model: 'openai/gpt-5.5' });
    completeForRole.mockResolvedValueOnce({
      content: JSON.stringify({ type: 'final', message: 'ok' }),
      model: 'openai/gpt-5.5',
      toolCalls: [],
    });

    const adapter = createJsonToolModelAdapter('primary');
    await adapter.complete({
      runId: 'run-temp',
      messages: [{ role: 'user', content: 'hi' }],
      contextText: 'ctx',
    });

    const request = completeForRole.mock.calls[0][1] as { temperature?: number };
    expect(request.temperature).toBeUndefined();
  });

  it('keeps temperature for models that support it', async () => {
    getAgentRoleConfig.mockReturnValueOnce({ provider: 'openai', model: 'gpt-4o' });

    const adapter = createJsonToolModelAdapter('primary');
    await adapter.complete({
      runId: 'run-temp-ok',
      messages: [{ role: 'user', content: 'hi' }],
      contextText: 'ctx',
    });

    const request = completeForRole.mock.calls[0][1] as { temperature?: number };
    expect(request.temperature).toBe(0.2);
  });
});
