import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApprovalRequest } from '@/types/assistant';
import type { AssistantToolContext } from '../tools/types';
import type { AgentModelMessage, AgentSessionState } from './types';
import {
  clearAgentSession,
  resumeAgentAfterApproval,
  setAgentSession,
} from './runnerCore';
import { toAnthropicChatMessages, toOpenAIChatMessages } from '../providers/toolMessageAdapters';
import type { AIMessage } from '../providers/types';
import { useAIChatStore } from '@/store/aiChatStore';

function toolContext(runId: string, messageId: string): AssistantToolContext {
  return {
    runId,
    messageId,
    getDocumentContext: vi.fn(() => ({ page: 2 })),
    analyzePage: vi.fn(async () => ({})),
    extractPageText: vi.fn(async () => ({})),
    searchDocument: vi.fn(async () => []),
    inspectCatalog: vi.fn(() => []),
    inspectMarkups: vi.fn(() => [{ id: 'm1' }]),
    navigateToPage: vi.fn(),
    activateEditorTool: vi.fn(),
    placeMarkups: vi.fn(() => ({ placed: 1 })),
    updateMarkups: vi.fn(),
    deleteMarkups: vi.fn(),
    linkCatalog: vi.fn(),
    addApproval: vi.fn(),
  };
}

function seedRun(runId: string, messageId: string) {
  useAIChatStore.setState({
    messages: [{
      id: messageId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      blocks: [],
    }],
    runs: {
      [runId]: {
        id: runId,
        messageId,
        status: 'waiting-approval',
        startedAt: new Date().toISOString(),
        steps: [],
      },
    },
    approvals: {},
    clarifications: {},
  } as never);
}

function baseMessages(callId: string): AgentModelMessage[] {
  return [
    { role: 'user', content: 'Place a callout' },
    {
      role: 'assistant',
      content: 'I can place that after approval.',
      toolCalls: [{
        id: callId,
        name: 'place_markups',
        arguments: {
          description: 'Place one callout',
          pointers: [{ type: 'callout', ref: 1, point: { x: 10, y: 20 }, page: 2 }],
        },
      }],
    },
    {
      role: 'tool',
      name: 'place_markups',
      toolCallId: callId,
      content: JSON.stringify({ status: 'approval-required', summary: 'Waiting for approval' }),
    },
  ];
}

describe('approval resume toolCallId continuity', () => {
  beforeEach(() => {
    clearAgentSession('run-approval-id');
    useAIChatStore.setState({
      messages: [],
      runs: {},
      approvals: {},
      clarifications: {},
    } as never);
  });

  it('approved outcome uses originating call.id for OpenAI and Anthropic shapes', async () => {
    const callId = 'call_abc123';
    const approvalId = 'approval_ui_999';
    seedRun('run-approval-id', 'message-approval-id');

    const approval: ApprovalRequest = {
      id: approvalId,
      runId: 'run-approval-id',
      messageId: 'message-approval-id',
      toolId: 'place_markups',
      title: 'Place document markups',
      description: 'Place one callout',
      status: 'pending',
      payload: [{ type: 'callout', ref: 1, point: { x: 10, y: 20 }, page: 2 }],
      undoable: true,
      createdAt: new Date().toISOString(),
      toolCallId: callId,
    };

    setAgentSession({
      runId: approval.runId,
      messageId: approval.messageId,
      messages: baseMessages(callId),
      toolHistory: [],
      actionsTaken: [],
      contextText: 'context',
      pendingApprovalId: approval.id,
      continuation: { kind: 'agent', waitingFor: 'approval' },
    } as AgentSessionState);

    const complete = vi.fn().mockResolvedValue({
      type: 'final',
      message: 'Callout placed.',
    });

    await resumeAgentAfterApproval({
      runId: approval.runId,
      approval,
      decision: 'approved',
      executionResult: { placed: 1 },
      toolContext: toolContext(approval.runId, approval.messageId),
      model: { complete },
    });

    const outbound = complete.mock.calls[0][0].messages as AgentModelMessage[];
    const toolMsgs = outbound.filter(m => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].toolCallId).toBe(callId);
    expect(toolMsgs[0].toolCallId).not.toBe(approvalId);
    expect(toolMsgs[0].content).toContain('Approved');

    // Verifier for place_markups (inspect_markups) must not be an invalid tool message.
    const invalidTool = outbound.filter(m => m.role === 'tool' && !m.toolCallId);
    expect(invalidTool).toHaveLength(0);
    expect(outbound.some(m => m.role === 'user' && String(m.content).startsWith('Verification ('))).toBe(true);

    const asAi = outbound as unknown as AIMessage[];
    const openai = toOpenAIChatMessages(asAi);
    expect(openai.some(m => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === callId)).toBe(true);
    expect(openai.some(m => m.role === 'tool' && (m as { tool_call_id?: string }).tool_call_id === approvalId)).toBe(false);

    const anthropic = toAnthropicChatMessages(asAi);
    const blocks = anthropic.messages.flatMap((m) => Array.isArray(m.content) ? m.content as Array<Record<string, unknown>> : []);
    expect(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === callId)).toBe(true);
    expect(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === approvalId)).toBe(false);
  });

  it('rejected outcome also uses originating call.id (not approval.id)', async () => {
    const callId = 'call_abc123';
    const approvalId = 'approval_ui_999';
    seedRun('run-approval-id', 'message-approval-id');

    const approval: ApprovalRequest = {
      id: approvalId,
      runId: 'run-approval-id',
      messageId: 'message-approval-id',
      toolId: 'place_markups',
      title: 'Place document markups',
      description: 'Place one callout',
      status: 'pending',
      payload: [],
      undoable: true,
      createdAt: new Date().toISOString(),
      toolCallId: callId,
    };

    setAgentSession({
      runId: approval.runId,
      messageId: approval.messageId,
      messages: baseMessages(callId),
      toolHistory: [],
      actionsTaken: [],
      contextText: 'context',
      pendingApprovalId: approval.id,
      continuation: { kind: 'agent', waitingFor: 'approval' },
    } as AgentSessionState);

    const complete = vi.fn().mockResolvedValue({
      type: 'final',
      message: 'No changes made.',
    });

    await resumeAgentAfterApproval({
      runId: approval.runId,
      approval,
      decision: 'rejected',
      toolContext: toolContext(approval.runId, approval.messageId),
      model: { complete },
    });

    const outbound = complete.mock.calls[0][0].messages as AgentModelMessage[];
    const toolMsg = outbound.find(m => m.role === 'tool');
    expect(toolMsg?.toolCallId).toBe(callId);
    expect(toolMsg?.toolCallId).not.toBe(approvalId);
    expect(toolMsg?.content).toMatch(/rejected/i);
  });
});
