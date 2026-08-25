import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAIChatStore } from '@/store/aiChatStore';
import type { AssistantToolContext } from '../tools/types';
import type { AgentSessionState } from './types';
import {
  canonicalizeAgentToolCalls,
  clearAgentSession,
  clearAgentSessionMemoryForTests,
  runPrimaryAgentLoop,
  setAgentSession,
} from './runnerCore';
import { createJsonToolModelAdapter } from './modelAdapter';
import { agentMessagesToProviderMessages, assertOpenAIToolBijection } from './providerMessages';
import { registerAllAgentTools } from './tools/registerAll';
import { toOpenAIChatMessages } from '../providers/toolMessageAdapters';
import type { AIMessage } from '../providers/types';

const { completeForRole, visionForRole, getAgentRoleConfig } = vi.hoisted(() => ({
  completeForRole: vi.fn(),
  visionForRole: vi.fn(),
  getAgentRoleConfig: vi.fn(() => ({ provider: 'openai', model: 'gpt-4o' })),
}));

vi.mock('../aiService', () => ({
  getAIService: () => ({
    completeForRole,
    visionForRole,
    getAgentRoleConfig,
  }),
}));

function seedStore(runId: string, messageId: string) {
  useAIChatStore.setState({
    messages: [{
      id: messageId,
      role: 'assistant',
      content: '',
      isLoading: true,
      timestamp: new Date(),
      blocks: [{ id: `block_${runId}`, type: 'activity', runId }],
    }],
    runs: {
      [runId]: {
        id: runId,
        messageId,
        status: 'running',
        startedAt: new Date().toISOString(),
        steps: [],
      },
    },
    approvals: {},
    clarifications: {},
  } as never);
}

function toolContext(runId: string, messageId: string): AssistantToolContext {
  return {
    runId,
    messageId,
    getDocumentContext: vi.fn(() => ({ page: 1 })),
    analyzePage: vi.fn(async (input) => ({ analyzed: true, input })),
    extractPageText: vi.fn(async () => ({})),
    searchDocument: vi.fn(async () => []),
    inspectCatalog: vi.fn(() => []),
    searchCatalog: vi.fn(() => ({ matches: [], noConfidentMatch: true, confidentMatches: [], message: '' })),
    inspectMarkups: vi.fn(() => []),
    getTakeoffSummary: vi.fn(() => ({ totals: { fixtures: 12 } })),
    navigateToPage: vi.fn(),
    activateEditorTool: vi.fn(),
    placeMarkups: vi.fn(() => ({ placed: 0 })),
    updateMarkups: vi.fn(),
    deleteMarkups: vi.fn(),
    linkCatalog: vi.fn(),
    addApproval: vi.fn(),
  };
}

function assertOutboundBijection(messages: AIMessage[]) {
  const withoutSystem = messages.filter(m => m.role !== 'system');
  const bijection = assertOpenAIToolBijection(withoutSystem);
  expect(bijection.problems).toEqual([]);
  expect(bijection.ok).toBe(true);

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
    expect(found).toBe(true);
  }
}

describe('canonicalizeAgentToolCalls', () => {
  it('uses the same generated id for blank ids (single canonicalization)', () => {
    const canonical = canonicalizeAgentToolCalls([
      { id: '   ', name: 'analyze_page', arguments: { page: 1, scope: 'full' } },
    ], 1);
    expect(canonical[0].id).toBe('call_analyze_page_1_1');
    expect(canonical[0].id.trim().length).toBeGreaterThan(0);
  });

  it('de-collides duplicate explicit ids within one decision (keeps first, renames rest)', () => {
    const canonical = canonicalizeAgentToolCalls([
      { id: 'call_abc', name: 'analyze_page', arguments: { page: 1, scope: 'full' } },
      { id: 'call_abc', name: 'getTakeoffSummary', arguments: {} },
    ], 1);
    expect(canonical[0].id).toBe('call_abc');
    expect(canonical[1].id).toBe('call_abc__2');
    expect(canonical[0].id).not.toBe(canonical[1].id);
  });
});

describe('runnerCore multi-round tool continuity (real loop)', () => {
  beforeEach(() => {
    clearAgentSessionMemoryForTests();
    completeForRole.mockReset();
    visionForRole.mockReset();
    getAgentRoleConfig.mockReturnValue({ provider: 'openai', model: 'gpt-4o' });
    registerAllAgentTools();
    useAIChatStore.setState({
      messages: [],
      runs: {},
      approvals: {},
      clarifications: {},
    } as never);
  });

  async function runTwoToolThenFinal(options: {
    runId: string;
    withImage: boolean;
    secondTool: { id: string; name: string; input: Record<string, unknown> };
  }) {
    const messageId = `msg-${options.runId}`;
    seedStore(options.runId, messageId);
    clearAgentSession(options.runId);

    const session: AgentSessionState = {
      runId: options.runId,
      messageId,
      messages: [{ role: 'user', content: 'How many type A fixtures are there?' }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'estimate context',
      imageBase64: options.withImage ? 'data:image/png;base64,AAA' : undefined,
    };
    setAgentSession(session);

    const transport = options.withImage ? visionForRole : completeForRole;
    transport
      .mockResolvedValueOnce({
        content: '',
        model: 'gpt-4o',
        toolCalls: [{
          id: 'call_analyze_1',
          name: 'analyze_page',
          input: { page: 1, scope: 'full' },
        }],
      })
      .mockResolvedValueOnce({
        content: '',
        model: 'gpt-4o',
        toolCalls: [{
          id: options.secondTool.id,
          name: options.secondTool.name,
          input: options.secondTool.input,
        }],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ type: 'final', message: 'There are 12 type A fixtures.' }),
        model: 'gpt-4o',
        toolCalls: [],
      });

    const result = await runPrimaryAgentLoop({
      session,
      toolContext: toolContext(options.runId, messageId),
      model: createJsonToolModelAdapter('primary'),
      maxSteps: 8,
    });

    expect(result.finalStatus).toBe('completed');
    expect(transport).toHaveBeenCalledTimes(3);

    const finalRequest = transport.mock.calls[2][1] as { messages: AIMessage[] };
    assertOutboundBijection(finalRequest.messages);

    // Also validate the session history the runner actually built.
    const fromSession = agentMessagesToProviderMessages(session.messages);
    expect(assertOpenAIToolBijection(fromSession).ok).toBe(true);

    return { session, finalRequest };
  }

  it('non-vision: analyze_page then getTakeoffSummary then Continue has bijective pairing', async () => {
    const { finalRequest } = await runTwoToolThenFinal({
      runId: 'run-multi-novision',
      withImage: false,
      secondTool: { id: 'call_summary_2', name: 'getTakeoffSummary', input: {} },
    });
    expect(visionForRole).not.toHaveBeenCalled();
    expect(completeForRole).toHaveBeenCalledTimes(3);
    const tools = finalRequest.messages.filter(m => m.role === 'tool');
    expect(tools.map(t => t.name)).toEqual(['analyze_page', 'getTakeoffSummary']);
    expect(tools.map(t => t.toolCallId)).toEqual(['call_analyze_1', 'call_summary_2']);
  });

  it('vision: analyze_page then getTakeoffSummary then Continue has bijective pairing', async () => {
    const { finalRequest } = await runTwoToolThenFinal({
      runId: 'run-multi-vision',
      withImage: true,
      secondTool: { id: 'call_summary_2', name: 'getTakeoffSummary', input: {} },
    });
    expect(completeForRole).not.toHaveBeenCalled();
    expect(visionForRole).toHaveBeenCalledTimes(3);
    const tools = finalRequest.messages.filter(m => m.role === 'tool');
    expect(tools.map(t => t.name)).toEqual(['analyze_page', 'getTakeoffSummary']);
    expect(tools.map(t => t.toolCallId)).toEqual(['call_analyze_1', 'call_summary_2']);
  });

  it('same tool twice (analyze_page page1 then page2) then Continue stays bijective', async () => {
    const { finalRequest, session } = await runTwoToolThenFinal({
      runId: 'run-same-tool-twice',
      withImage: false,
      secondTool: {
        id: 'call_analyze_2',
        name: 'analyze_page',
        input: { page: 2, scope: 'full' },
      },
    });

    const toolIds = finalRequest.messages
      .filter(m => m.role === 'tool')
      .map(m => m.toolCallId);
    expect(toolIds).toEqual(['call_analyze_1', 'call_analyze_2']);
    expect(new Set(toolIds).size).toBe(2);

    const assistantCalls = session.messages
      .filter(m => m.role === 'assistant' && m.toolCalls?.length)
      .flatMap(m => (m.toolCalls || []).map(c => c.id));
    expect(assistantCalls).toEqual(toolIds);
  });

  it('blank tool-call id is shared by assistant history and tool-result message', async () => {
    const runId = 'run-blank-id';
    const messageId = `msg-${runId}`;
    seedStore(runId, messageId);
    clearAgentSession(runId);

    const session: AgentSessionState = {
      runId,
      messageId,
      messages: [{ role: 'user', content: 'Analyze page' }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'ctx',
    };
    setAgentSession(session);

    completeForRole
      .mockResolvedValueOnce({
        content: '',
        model: 'gpt-4o',
        toolCalls: [{
          id: '   ',
          name: 'analyze_page',
          input: { page: 1, scope: 'full' },
        }],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ type: 'final', message: 'Done.' }),
        model: 'gpt-4o',
        toolCalls: [],
      });

    await runPrimaryAgentLoop({
      session,
      toolContext: toolContext(runId, messageId),
      model: createJsonToolModelAdapter('primary'),
      maxSteps: 8,
    });

    const assistant = session.messages.find(m => m.role === 'assistant' && m.toolCalls?.length);
    const tool = session.messages.find(m => m.role === 'tool');
    expect(assistant?.toolCalls?.[0]?.id).toBeTruthy();
    expect(assistant?.toolCalls?.[0]?.id.trim().length).toBeGreaterThan(0);
    expect(tool?.toolCallId).toBe(assistant?.toolCalls?.[0]?.id);

    const secondRequest = completeForRole.mock.calls[1][1] as { messages: AIMessage[] };
    assertOutboundBijection(secondRequest.messages);
  });

  it('duplicate explicit ids in one decision are de-collided so both tool results survive', async () => {
    const runId = 'run-dup-ids';
    const messageId = `msg-${runId}`;
    seedStore(runId, messageId);
    clearAgentSession(runId);

    const session: AgentSessionState = {
      runId,
      messageId,
      messages: [{ role: 'user', content: 'How many fixtures?' }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'ctx',
    };
    setAgentSession(session);

    // Simulate JSON/free-form fallback emitting two different tools with the same id.
    completeForRole
      .mockResolvedValueOnce({
        content: '',
        model: 'gpt-4o',
        toolCalls: [
          { id: 'call_abc', name: 'analyze_page', input: { page: 1, scope: 'full' } },
          { id: 'call_abc', name: 'getTakeoffSummary', input: {} },
        ],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ type: 'final', message: '12 fixtures.' }),
        model: 'gpt-4o',
        toolCalls: [],
      });

    const result = await runPrimaryAgentLoop({
      session,
      toolContext: toolContext(runId, messageId),
      model: createJsonToolModelAdapter('primary'),
      maxSteps: 8,
    });

    expect(result.finalStatus).toBe('completed');

    const assistant = session.messages.find(m => m.role === 'assistant' && m.toolCalls?.length);
    const callIds = (assistant?.toolCalls || []).map(c => c.id);
    expect(callIds).toHaveLength(2);
    expect(new Set(callIds).size).toBe(2);
    expect(callIds[0]).toBe('call_abc');
    expect(callIds[1]).toBe('call_abc__2');

    const tools = session.messages.filter(m => m.role === 'tool');
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.toolCallId).sort()).toEqual([...callIds].sort());
    expect(tools.map(t => t.name).sort()).toEqual(['analyze_page', 'getTakeoffSummary']);

    const finalRequest = completeForRole.mock.calls[1][1] as { messages: AIMessage[] };
    assertOutboundBijection(finalRequest.messages);
    const outboundTools = finalRequest.messages.filter(m => m.role === 'tool');
    expect(outboundTools).toHaveLength(2);
    expect(new Set(outboundTools.map(t => t.toolCallId)).size).toBe(2);
  });
});
