import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import {
  clearAgentSessionMemoryForTests,
  runPrimaryAgentLoop,
  resumeAgentAfterApproval,
  setAgentSession,
} from './runnerCore';
import { createAgentToolContext } from './createToolContext';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from './tools/registerAll';
import {
  ASSISTANT_PROTOCOL_DISPLAY_FALLBACK,
  sanitizeAssistantVisibleText,
} from './assistantVisibleText';
import { decisionFromCompletion } from '../tools/toProxyTools';
import { executeApprovedAssistantAction, executeAssistantTool } from '../tools/registry';

describe('place_markups approval path (no raw JSON leak)', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    clearAgentSessionMemoryForTests();
    useAIChatStore.setState({
      messages: [],
      runs: {},
      approvals: {},
      conversation: null,
      conversationContextId: null,
      conversationHydrated: false,
    });
    useCanvasStore.getState().clearAllDocuments();
  });

  it('dual-protocol native get_document_context + JSON place_markups triggers needs_approval', async () => {
    const messageId = useAIChatStore.getState().addMessage({
      role: 'assistant',
      content: '',
      isLoading: true,
    });
    const placeMarkups = vi.fn(async () => ({ placed: 1 }));
    const context = createAgentToolContext({
      runId: 'run-place-leak',
      messageId,
      trade: 'electrical',
      placeMarkups,
    });

    const hybridContent = JSON.stringify({
      type: 'tool_calls',
      assistantText: "I'll place a preliminary count note. This requires your approval.",
      toolCalls: [{
        id: 'call_1',
        name: 'place_markups',
        arguments: {
          description: 'Place preliminary lighting fixture count summary',
          preview: 'Adds one text note with fixture counts',
          markups: [{
            type: 'text',
            page: 1,
            points: [{ x: 100, y: 200 }],
            content: 'A: 8',
            confidence: 0.72,
          }],
        },
      }],
      final: {
        message: 'Please approve the markup placement.',
        clarifyingQuestions: [],
      },
    });

    let round = 0;
    const model = {
      complete: vi.fn(async () => {
        round += 1;
        if (round === 1) {
          return decisionFromCompletion({
            content: hybridContent,
            toolCalls: [{ id: 'call_native_ctx', name: 'get_document_context', input: {} }],
          });
        }
        return { type: 'final' as const, message: 'Done.', clarifyingQuestions: [] };
      }),
    };

    const session = {
      runId: 'run-place-leak',
      messageId,
      messages: [{ role: 'user' as const, content: 'Please place the counts on the document' }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'ctx',
    };
    setAgentSession(session);

    const result = await runPrimaryAgentLoop({
      session,
      toolContext: context,
      model: model as never,
      maxSteps: 4,
      preferTools: true,
    });

    expect(result.status).toBe('needs_approval');
    expect(result.finalStatus).toBe('needs_approval');
    expect(result.approvalRequest?.toolId).toBe('place_markups');
    expect(result.assistantMessage).toContain('approval');
    expect(result.assistantMessage).not.toContain('"type":"tool_calls"');
    expect(result.assistantMessage).not.toMatch(/^\s*\{/);

    const msg = useAIChatStore.getState().messages.find(m => m.id === messageId);
    expect(msg?.content).not.toContain('"toolCalls"');
    expect(msg?.content).not.toContain('"type":"tool_calls"');
    expect(msg?.blocks?.some(b => b.type === 'approval')).toBe(true);
    expect(placeMarkups).not.toHaveBeenCalled();
  });

  it('approving place_markups writes markups; rejecting does not', async () => {
    const messageId = useAIChatStore.getState().addMessage({
      role: 'assistant',
      content: 'Waiting for approval',
      isLoading: true,
    });
    const placeMarkups = vi.fn(async () => ({ placed: 1 }));
    const context = createAgentToolContext({
      runId: 'run-place-approve',
      messageId,
      trade: 'electrical',
      placeMarkups,
    });

    const proposal = await executeAssistantTool('place_markups', {
      description: 'Place count note',
      markups: [{
        type: 'text',
        page: 1,
        points: [{ x: 10, y: 20 }],
        content: 'A: 8',
      }],
    }, context);
    expect(proposal.status).toBe('approval-required');
    expect(placeMarkups).not.toHaveBeenCalled();

    const approval = proposal.approval!;
    approval.toolCallId = 'call_place_1';
    const payload = (approval.payload && typeof approval.payload === 'object')
      ? approval.payload as Record<string, unknown>
      : {};

    const session = {
      runId: 'run-place-approve',
      messageId,
      messages: [
        { role: 'user' as const, content: 'place counts' },
        {
          role: 'assistant' as const,
          content: 'Need approval',
          toolCalls: [{ id: 'call_place_1', name: 'place_markups', arguments: payload }],
        },
        {
          role: 'tool' as const,
          name: 'place_markups',
          toolCallId: 'call_place_1',
          content: JSON.stringify({ status: 'approval-required' }),
        },
      ],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'ctx',
      pendingApprovalId: approval.id,
      continuation: { kind: 'agent' as const, waitingFor: 'approval' as const },
    };
    setAgentSession(session);
    useAIChatStore.getState().addApproval(approval);

    const rejected = await resumeAgentAfterApproval({
      runId: 'run-place-approve',
      approval,
      decision: 'rejected',
      toolContext: context,
      model: {
        complete: vi.fn(async () => ({
          type: 'final' as const,
          message: 'Understood, I will not place markups.',
          clarifyingQuestions: [],
        })),
      } as never,
    });
    expect(placeMarkups).not.toHaveBeenCalled();
    expect(rejected.assistantMessage).not.toContain('"type":"tool_calls"');

    // Fresh approve path via executeApprovedAssistantAction (UI approve button).
    const proposal2 = await executeAssistantTool('place_markups', {
      description: 'Place count note again',
      markups: [{
        type: 'text',
        page: 1,
        points: [{ x: 10, y: 20 }],
        content: 'A: 8',
      }],
    }, {
      ...context,
      runId: 'run-place-approve-2',
      messageId,
    });
    expect(proposal2.status).toBe('approval-required');
    const executed = await executeApprovedAssistantAction(proposal2.approval!, {
      ...context,
      runId: 'run-place-approve-2',
      messageId,
      placeMarkups,
    });
    expect(executed).toEqual({ placed: 1 });
    expect(placeMarkups).toHaveBeenCalled();
  });
  it('sanitizeAssistantVisibleText never returns raw tool_calls JSON', () => {
    const raw = JSON.stringify({
      type: 'tool_calls',
      assistantText: 'Preparing placement',
      toolCalls: [{ id: 'call_1', name: 'place_markups', arguments: { description: 'x' } }],
    });
    expect(sanitizeAssistantVisibleText(raw)).toBe('Preparing placement');
    expect(sanitizeAssistantVisibleText(raw)).not.toContain('toolCalls');

    const malformed = '{"type":"tool_calls","toolCalls":[';
    const guarded = sanitizeAssistantVisibleText(malformed);
    expect(guarded).not.toContain('"toolCalls"');
    expect(guarded === ASSISTANT_PROTOCOL_DISPLAY_FALLBACK || guarded.length > 0).toBe(true);
    expect(guarded).not.toMatch(/"type"\s*:\s*"tool_calls"/);
  });
});
