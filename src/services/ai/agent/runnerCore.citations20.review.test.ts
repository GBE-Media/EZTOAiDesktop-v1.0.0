import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAIChatStore } from '@/store/aiChatStore';
import { groupAssistantBlocks } from '@/lib/assistantTurnPresentation';
import { openEvidenceCitation } from '@/lib/openCitation';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { AssistantToolContext } from '../tools/types';
import type { AgentSessionState } from './types';
import { clearAgentSession, clearAgentSessionMemoryForTests, runPrimaryAgentLoop, setAgentSession } from './runnerCore';
import { createJsonToolModelAdapter } from './modelAdapter';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from './tools/registerAll';
import { clearIndexMemory, saveIndexedPages } from '../projectIndex/store';
import type { IndexedPageRecord } from '../projectIndex/types';
import { buildSearchPassages } from '../projectIndex/searchIndex';

const { completeForRole, getAgentRoleConfig } = vi.hoisted(() => ({
  completeForRole: vi.fn(),
  getAgentRoleConfig: vi.fn(() => ({ provider: 'openai', model: 'gpt-4o' })),
}));

vi.mock('../aiService', () => ({
  getAIService: () => ({
    completeForRole,
    visionForRole: vi.fn(),
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

describe('final answer citation chips', () => {
  beforeEach(async () => {
    clearAgentSessionMemoryForTests();
    completeForRole.mockReset();
    getAgentRoleConfig.mockReturnValue({ provider: 'openai', model: 'gpt-4o' });
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    clearIndexMemory();
    const lines = [{ text: '2.2 RECEPTACLES duplex specification grade', bbox: { x: 0, y: 0, width: 100, height: 10 } }];
    const page: IndexedPageRecord = {
      docId: 'man',
      docFp: 'man:1:v3',
      documentName: 'Specs.pdf',
      page: 15,
      lines,
      text: lines[0].text,
      kind: 'spec',
      specSection: '26 27 26',
      needsOcr: false,
      passages: buildSearchPassages(lines),
    };
    const many = Array.from({ length: 20 }, (_, i) => ({ ...page, page: i + 1 }));
    await saveIndexedPages('man:1:v3', many, 'man');
  });

  it('puts search_project chips under the answer, not only in the process disclosure', async () => {
    const runId = 'run-cite';
    const messageId = 'msg-cite';
    seedStore(runId, messageId);
    clearAgentSession(runId);
    const session: AgentSessionState = {
      runId,
      messageId,
      messages: [{ role: 'user', content: 'Where are receptacles specified?' }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'project',
    };
    setAgentSession(session);

    completeForRole
      .mockResolvedValueOnce({
        content: '',
        model: 'gpt-4o',
        toolCalls: [{ id: 'call_search', name: 'search_project', input: { query: '2.2 receptacles', kind: 'spec' } }],
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({ type: 'final', message: 'See wiring devices 2.2.' }),
        model: 'gpt-4o',
        toolCalls: [],
      });

    const result = await runPrimaryAgentLoop({
      session,
      toolContext: toolContext(runId, messageId),
      model: createJsonToolModelAdapter('primary'),
      maxSteps: 6,
    });

    expect(result.finalStatus).toBe('completed');
    expect(result.citations?.length).toBeGreaterThan(0);
    expect(result.citations!.length).toBeLessThanOrEqual(8);

    const message = useAIChatStore.getState().messages.find(m => m.id === messageId);
    const grouped = groupAssistantBlocks(message?.blocks);
    const visibleCites = grouped.visibleBlocks.filter(b => b.type === 'citations');
    expect(visibleCites.length).toBe(1);
    expect(grouped.processBlocks.some(b => b.type === 'citations')).toBe(false);
    const citations = visibleCites[0].type === 'citations' ? visibleCites[0].citations : [];
    expect(citations.length).toBe(8);
    const run = useAIChatStore.getState().runs[runId];
    console.log('[R3] step chips', run?.steps.map(st => st.citations?.length ?? 0), 'final chips', citations.length, 'block order', message?.blocks?.map(b => b.type));
    expect(Math.max(...(run?.steps ?? []).map(st => st.citations?.length ?? 0))).toBeLessThanOrEqual(8);

    useCanvasStore.getState().setPdfDocument('other', {}, 2, 612, 792);
    useCanvasStore.getState().setPdfDocument('man', {}, 20, 612, 792);
    useCanvasStore.getState().setActiveDocId('other');
    useEditorStore.setState({ activeDocument: 'other' } as never);
    openEvidenceCitation(citations[0]);
    expect(useCanvasStore.getState().activeDocId).toBe(citations[0].documentId);
    expect(useCanvasStore.getState().getCurrentPage()).toBe(citations[0].page);
    expect(useEditorStore.getState().activeDocument).toBe(citations[0].documentId);
  });
});
