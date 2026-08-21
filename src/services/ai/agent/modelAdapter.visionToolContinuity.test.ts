import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIMessage } from '../providers/types';
import { projectMessagesPreservingToolFields } from '../providers/projectMessagesPreservingToolFields';
import { toAnthropicChatMessages, toOpenAIChatMessages } from '../providers/toolMessageAdapters';

const { visionForRole, completeForRole, getAgentRoleConfig } = vi.hoisted(() => ({
  visionForRole: vi.fn(),
  completeForRole: vi.fn(),
  getAgentRoleConfig: vi.fn(() => ({ provider: 'openai', model: 'gpt-test' })),
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
    assistantToolsToProxyDefinitions: () => [
      {
        name: 'get_document_context',
        description: 'Read document context',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

import { createJsonToolModelAdapter } from './modelAdapter';

describe('projectMessagesPreservingToolFields', () => {
  it('keeps assistant toolCalls and tool toolCallId/name alongside images', () => {
    const projected = projectMessagesPreservingToolFields([
      {
        role: 'assistant',
        content: 'Looking up context',
        toolCalls: [{ id: 'call_abc123', name: 'get_document_context', input: {} }],
      },
      {
        role: 'tool',
        name: 'get_document_context',
        toolCallId: 'call_abc123',
        content: '{"page":2}',
        images: undefined,
      },
      {
        role: 'user',
        content: 'Continue',
        images: ['data:image/png;base64,AAA'],
      },
    ]);

    expect(projected[0].toolCalls).toEqual([
      { id: 'call_abc123', name: 'get_document_context', input: {} },
    ]);
    expect(projected[1]).toMatchObject({
      role: 'tool',
      toolCallId: 'call_abc123',
      name: 'get_document_context',
      content: '{"page":2}',
    });
    expect(projected[2].images).toEqual(['data:image/png;base64,AAA']);
  });
});

describe('image-backed native tool continuity (vision path)', () => {
  beforeEach(() => {
    visionForRole.mockReset();
    completeForRole.mockReset();
  });

  it('second vision request retains assistant tool_calls and matching tool result ids', async () => {
    visionForRole
      .mockResolvedValueOnce({
        content: '',
        model: 'gpt-test',
        toolCalls: [
          { id: 'call_abc123', name: 'get_document_context', input: {} },
        ],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ type: 'final', message: 'Page 2 is active.' }),
        model: 'gpt-test',
        toolCalls: [],
      });

    const adapter = createJsonToolModelAdapter('primary');

    const first = await adapter.complete({
      runId: 'run-vision-1',
      messages: [{ role: 'user', content: 'What page am I on?' }],
      contextText: 'doc context',
      imageBase64: 'img-turn-1',
    });
    expect(first.type).toBe('tool_calls');
    if (first.type !== 'tool_calls') throw new Error('expected tool_calls');

    // Simulate runner appending assistant toolCalls + tool result, then asking again with an image.
    await adapter.complete({
      runId: 'run-vision-1',
      messages: [
        { role: 'user', content: 'What page am I on?' },
        {
          role: 'assistant',
          content: '',
          toolCalls: first.toolCalls,
        },
        {
          role: 'tool',
          name: 'get_document_context',
          toolCallId: 'call_abc123',
          content: JSON.stringify({ status: 'completed', output: { page: 2 } }),
        },
      ],
      contextText: 'doc context',
      imageBase64: 'img-turn-2',
    });

    expect(visionForRole).toHaveBeenCalledTimes(2);
    const secondRequest = visionForRole.mock.calls[1][1] as { messages: AIMessage[] };
    const outbound = secondRequest.messages;

    const assistant = outbound.find(m => m.role === 'assistant' && m.toolCalls?.length);
    const tool = outbound.find(m => m.role === 'tool');
    expect(assistant?.toolCalls?.[0]).toMatchObject({
      id: 'call_abc123',
      name: 'get_document_context',
    });
    expect(tool).toMatchObject({
      role: 'tool',
      toolCallId: 'call_abc123',
      name: 'get_document_context',
    });

    // Provider shapes stay associated after vision projection.
    const openai = toOpenAIChatMessages(outbound.filter(m => m.role !== 'system') as AIMessage[]);
    expect(openai.some(m => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown }).tool_calls))).toBe(true);
    expect(openai.some(m => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === 'call_abc123')).toBe(true);

    const anthropic = toAnthropicChatMessages(outbound as AIMessage[]);
    const flat = anthropic.messages.flatMap((m) => {
      if (!Array.isArray(m.content)) return [];
      return m.content as Array<Record<string, unknown>>;
    });
    expect(flat.some(b => b.type === 'tool_use' && b.id === 'call_abc123')).toBe(true);
    expect(flat.some(b => b.type === 'tool_result' && b.tool_use_id === 'call_abc123')).toBe(true);
  });
});
