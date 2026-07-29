import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assistantDb, readPersistedAgentSession } from '@/db/assistantDb';
import { useAIChatStore } from '@/store/aiChatStore';
import { createAgentToolContext } from './createToolContext';
import {
  clearAgentSessionMemoryForTests,
  parkAgentSession,
} from './runner';
import {
  resumeTaskAfterApproval,
  resumeTaskAfterClarification,
  startPipelineTask,
} from './orchestrator';
import type { AgentSessionState } from './types';
import type { ModelAdapter } from './modelAdapter';

const pipelineMock = vi.hoisted(() => vi.fn());
vi.mock('../pipeline', async importOriginal => {
  const actual = await importOriginal<typeof import('../pipeline')>();
  return { ...actual, runPipeline: pipelineMock };
});

const analysis = [{
  page: 1,
  items: [],
  dimensions: [],
  text: [],
  symbols: [],
  evidence: ['Sheet E-101'],
}];

function resetStore() {
  useAIChatStore.setState({
    messages: [],
    runs: {},
    approvals: {},
    clarifications: {},
    conversation: null,
    conversationContextId: null,
    conversationHydrated: true,
  });
}

function createRun(runId: string, messageId: string) {
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
        conversationId: 'session',
        status: 'running',
        summary: 'Count fixtures',
        steps: [],
        startedAt: new Date().toISOString(),
      },
    },
  });
}

function toolContext(runId: string, messageId: string) {
  return createAgentToolContext({
    runId,
    messageId,
    trade: 'electrical',
    placeMarkups: () => ({ placed: 0 }),
  });
}

describe('agent task orchestrator resume continuity', () => {
  beforeEach(async () => {
    pipelineMock.mockReset();
    clearAgentSessionMemoryForTests();
    await assistantDb.agentSessions.clear();
    resetStore();
  });

  it('resumes pipeline analysis under the same run without invoking vision again', async () => {
    createRun('run-pipeline', 'message-pipeline');
    pipelineMock
      .mockResolvedValueOnce({
        success: true,
        analysis,
        questions: ['Which fixture scope?'],
        questionOptions: [{
          id: 'scope',
          prompt: 'Which fixture scope?',
          options: ['All fixtures', 'New work only'],
        }],
        evidence: ['Sheet E-101'],
        duration: 10,
      })
      .mockResolvedValueOnce({
        success: true,
        analysis,
        estimate: { items: [], totalMaterialCost: 0, totalLaborCost: 0, totalCost: 0 },
        duration: 4,
      });

    const started = await startPipelineTask({
      runId: 'run-pipeline',
      messageId: 'message-pipeline',
      userMessage: 'Count fixtures',
      pipeline: {
        trade: 'electrical',
        pages: [1],
        imageGenerator: vi.fn(),
        pageWidth: 612,
        pageHeight: 792,
      },
    });
    expect(started.status).toBe('needs_clarification');
    expect(useAIChatStore.getState().runs['run-pipeline'].status).toBe('waiting-clarification');

    clearAgentSessionMemoryForTests();
    const resumed = await resumeTaskAfterClarification({
      clarification: started.clarificationRequest!,
      answer: {
        selectedValues: ['All fixtures'],
        displayText: 'All fixtures',
      },
      toolContext: toolContext('run-pipeline', 'message-pipeline'),
    });

    expect(resumed.runId).toBe('run-pipeline');
    expect(resumed.messageId).toBe('message-pipeline');
    expect(resumed.pipelineResult?.success).toBe(true);
    expect(pipelineMock).toHaveBeenCalledTimes(2);
    expect(pipelineMock.mock.calls[1][0]).toMatchObject({
      resumeFrom: {
        analysis,
        clarificationContext: expect.stringContaining('All fixtures'),
      },
    });
    expect(pipelineMock.mock.calls[1][0].imageGenerator).toBeUndefined();
    expect(await readPersistedAgentSession('run-pipeline')).toBeUndefined();
  });

  it('advances multiple pipeline questions sequentially on one run', async () => {
    createRun('run-multi', 'message-multi');
    pipelineMock
      .mockResolvedValueOnce({
        success: true,
        analysis,
        questionOptions: [
          { id: 'scope', prompt: 'Which scope?', options: ['All', 'New'] },
          { id: 'placement', prompt: 'Place callouts?', options: ['Yes', 'No'] },
        ],
        duration: 10,
      })
      .mockResolvedValueOnce({
        success: true,
        analysis,
        estimate: { items: [], totalMaterialCost: 0, totalLaborCost: 0, totalCost: 0 },
        duration: 4,
      });
    const started = await startPipelineTask({
      runId: 'run-multi',
      messageId: 'message-multi',
      userMessage: 'Count fixtures',
      pipeline: {
        trade: 'electrical',
        pages: [1],
        imageGenerator: vi.fn(),
        pageWidth: 612,
        pageHeight: 792,
      },
    });

    const first = await resumeTaskAfterClarification({
      clarification: started.clarificationRequest!,
      answer: { selectedValues: ['All'], displayText: 'All' },
      toolContext: toolContext('run-multi', 'message-multi'),
    });
    expect(first.status).toBe('needs_clarification');
    expect(first.clarificationRequest?.question).toBe('Place callouts?');
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    const staleClarification = {
      ...started.clarificationRequest!,
      id: 'stale-first-question',
      status: 'pending' as const,
    };
    useAIChatStore.getState().addClarification(staleClarification);
    const resynced = await resumeTaskAfterClarification({
      clarification: staleClarification,
      answer: { selectedValues: ['All'], displayText: 'All' },
      toolContext: toolContext('run-multi', 'message-multi'),
    });
    expect(resynced.status).toBe('needs_clarification');
    expect(resynced.clarificationRequest?.question).toBe('Place callouts?');
    expect(pipelineMock).toHaveBeenCalledTimes(1);

    const second = await resumeTaskAfterClarification({
      clarification: resynced.clarificationRequest!,
      answer: { selectedValues: ['Yes'], displayText: 'Yes' },
      toolContext: toolContext('run-multi', 'message-multi'),
    });
    expect(second.status).toBe('completed');
    expect(second.runId).toBe('run-multi');
    expect(pipelineMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a pipeline resume when a different document is active', async () => {
    createRun('run-document', 'message-document');
    pipelineMock.mockResolvedValueOnce({
      success: true,
      analysis,
      questions: ['Which scope?'],
      duration: 10,
    });
    const started = await startPipelineTask({
      runId: 'run-document',
      messageId: 'message-document',
      userMessage: 'Count fixtures',
      documentId: 'document-a',
      pipeline: {
        trade: 'electrical',
        pages: [1],
        imageGenerator: vi.fn(),
        pageWidth: 612,
        pageHeight: 792,
      },
    });

    const resumed = await resumeTaskAfterClarification({
      clarification: started.clarificationRequest!,
      answer: { selectedValues: ['all'], displayText: 'All' },
      toolContext: toolContext('run-document', 'message-document'),
      pipelineRuntime: { activeDocumentId: 'document-b' },
    });

    expect(resumed.status).toBe('failed');
    expect(resumed.errorCode).toBe('DOCUMENT_MISMATCH');
    expect(useAIChatStore.getState().clarifications[started.clarificationRequest!.id].status).toBe('pending');
    expect(pipelineMock).toHaveBeenCalledTimes(1);
  });

  it('hydrates and appends an agent clarification answer after reload', async () => {
    createRun('run-agent', 'message-agent');
    const session: AgentSessionState = {
      runId: 'run-agent',
      messageId: 'message-agent',
      messages: [
        { role: 'user', content: 'Estimate this page' },
        { role: 'assistant', content: '{"type":"clarify","message":"Which scope?"}' },
      ],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'context',
      continuation: { kind: 'agent', waitingFor: 'clarification' },
    };
    await parkAgentSession(session, 'waiting-clarification');
    const clarification = {
      id: 'clarification-agent',
      runId: session.runId,
      messageId: session.messageId,
      stepKey: 'scope',
      question: 'Which scope?',
      options: [],
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    useAIChatStore.getState().addClarification(clarification);
    clearAgentSessionMemoryForTests();

    const complete = vi.fn<ModelAdapter['complete']>().mockResolvedValue({
      type: 'final',
      message: 'Continuing with all pages.',
    });
    const result = await resumeTaskAfterClarification({
      clarification,
      answer: { selectedValues: ['all'], displayText: 'All pages' },
      toolContext: toolContext(session.runId, session.messageId),
      model: { complete },
    });

    expect(result.runId).toBe(session.runId);
    expect(result.agentResult?.assistantMessage).toBe('Continuing with all pages.');
    expect(complete.mock.calls[0][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.stringContaining('All pages') }),
    ]));
    expect(await readPersistedAgentSession(session.runId)).toBeUndefined();
  });

  it('hydrates an approval continuation after reload', async () => {
    createRun('run-approval', 'message-approval');
    const approval = {
      id: 'approval-1',
      runId: 'run-approval',
      messageId: 'message-approval',
      toolId: 'place_markups',
      title: 'Place markups',
      description: 'Place one markup',
      status: 'pending' as const,
      payload: { markups: [] },
      undoable: true,
      createdAt: new Date().toISOString(),
    };
    await parkAgentSession({
      runId: approval.runId,
      messageId: approval.messageId,
      messages: [{ role: 'user', content: 'Place a callout' }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'context',
      pendingApprovalId: approval.id,
      continuation: { kind: 'agent', waitingFor: 'approval' },
    }, 'waiting-approval');
    clearAgentSessionMemoryForTests();
    const complete = vi.fn<ModelAdapter['complete']>().mockResolvedValue({
      type: 'final',
      message: 'The document was not changed.',
    });

    const resumed = await resumeTaskAfterApproval({
      runId: approval.runId,
      approval,
      decision: 'rejected',
      toolContext: toolContext(approval.runId, approval.messageId),
      model: { complete },
    });

    expect(resumed.runId).toBe(approval.runId);
    expect(resumed.agentResult?.assistantMessage).toBe('The document was not changed.');
    expect(complete.mock.calls[0][0].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'tool', content: expect.stringContaining('rejected') }),
    ]));
    expect(await readPersistedAgentSession(approval.runId)).toBeUndefined();
  });

  it('returns the explicit expiration failure instead of creating a replacement run', async () => {
    createRun('missing-run', 'missing-message');
    const clarification = {
      id: 'missing-clarification',
      runId: 'missing-run',
      messageId: 'missing-message',
      stepKey: 'scope',
      question: 'Which scope?',
      options: [],
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    useAIChatStore.getState().addClarification(clarification);
    const result = await resumeTaskAfterClarification({
      clarification,
      answer: { selectedValues: ['all'], displayText: 'All pages' },
      toolContext: toolContext('missing-run', 'missing-message'),
    });

    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('SESSION_EXPIRED');
    expect(result.agentResult?.assistantMessage).toContain('session expired');
    expect(Object.keys(useAIChatStore.getState().runs)).toEqual(['missing-run']);
    expect(useAIChatStore.getState().clarifications[clarification.id].status).toBe('pending');
    expect(useAIChatStore.getState().messages).toHaveLength(1);
  });
});
