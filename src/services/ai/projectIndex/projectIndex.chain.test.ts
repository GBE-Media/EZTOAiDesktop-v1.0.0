import '../agent/testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';
import {
  clearAgentSession,
  runPrimaryAgentLoop,
  setAgentSession,
} from '../agent/runnerCore';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
import type { AssistantToolContext } from '../tools/types';
import type { AgentSessionState } from '../agent/types';
import { clearIndexMemory, saveIndexedPages } from './store';
import { classifyPage } from './classify';
import type { IndexedLine, IndexedPageRecord } from './types';

function line(text: string, x: number, y: number): IndexedLine {
  return { text, bbox: { x, y, width: Math.max(40, text.length * 6), height: 12 } };
}

function specRecord(): IndexedPageRecord {
  const lines = [
    line('SECTION 26 27 26 - WIRING DEVICES', 72, 36),
    line('PART 2 PRODUCTS', 72, 120),
    line('2.2 RECEPTACLES Specification Grade 20A 125V duplex.', 72, 160),
  ];
  const classified = classifyPage(lines, 612, 792);
  return {
    docId: 'specs',
    docFp: 'specs:120',
    documentName: 'ProjectManual.pdf',
    page: 40,
    lines,
    kind: classified.kind,
    specSection: classified.specSection,
    sheetTitle: classified.sheetTitle,
    articles: classified.articles,
    needsOcr: false,
  };
}

function drawingRecord(): IndexedPageRecord {
  const lines = [
    line('Panel LP-2', 200, 400),
    line('E-100', 1500, 2500),
  ];
  const classified = classifyPage(lines, 1728, 2592);
  return {
    docId: 'drawings',
    docFp: 'drawings:30',
    documentName: 'Drawings.pdf',
    page: 1,
    label: 'E-100',
    lines,
    kind: classified.kind,
    sheetNumber: classified.sheetNumber,
    discipline: classified.discipline,
    needsOcr: false,
  };
}

describe('cross-document agent chain', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    clearIndexMemory();
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.getState().setPdfDocument('drawings', { id: 'drawings' }, 10, 1728, 2592);
    useCanvasStore.getState().setPdfDocument('specs', { id: 'specs' }, 120, 612, 792);
    useCanvasStore.getState().setActiveDocId('drawings');
  });

  it('searches spec, reads article, counts on E-100 without forcing single-page vision', async () => {
    await saveIndexedPages('specs:120', [specRecord()]);
    await saveIndexedPages('drawings:30', [drawingRecord()]);

    const runId = 'run-cross-doc';
    const messageId = 'msg-cross-doc';
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
    clearAgentSession(runId);

    const session: AgentSessionState = {
      runId,
      messageId,
      messages: [{
        role: 'user',
        content: 'What receptacle type does the spec require and how many are on E-100?',
      }],
      toolHistory: [],
      actionsTaken: [],
      contextText: 'Project documents: Drawings.pdf drawing, ProjectManual.pdf spec.',
    };
    setAgentSession(session);

    const countCalls: unknown[] = [];
    const toolContext: AssistantToolContext = {
      runId,
      messageId,
      getDocumentContext: () => ({ page: 1, documentId: 'drawings' }),
      analyzePage: vi.fn(async () => ({ status: 'completed', analysis: { items: [] } })),
      extractPageText: vi.fn(async () => ({ text: '' })),
      countPageItems: vi.fn(async (input) => {
        countCalls.push(input);
        return {
          status: 'completed',
          total: 12,
          query: 'receptacle',
          page: 1,
          documentId: (input as { documentId?: string }).documentId,
        };
      }),
      searchDocument: vi.fn(async () => []),
      inspectCatalog: vi.fn(() => []),
      searchCatalog: vi.fn(() => ({ matches: [], noConfidentMatch: true, confidentMatches: [], message: '' })),
      inspectMarkups: vi.fn(() => []),
      navigateToPage: vi.fn(),
      activateEditorTool: vi.fn(),
      placeMarkups: vi.fn(),
      updateMarkups: vi.fn(),
      deleteMarkups: vi.fn(),
      linkCatalog: vi.fn(),
      addApproval: vi.fn(),
    };

    let step = 0;
    const result = await runPrimaryAgentLoop({
      session,
      toolContext,
      maxSteps: 6,
      model: {
        async complete() {
          step += 1;
          if (step === 1) {
            return {
              type: 'tool_calls',
              toolCalls: [
                { id: 'call_search', name: 'search_project', arguments: { query: 'receptacle', kind: 'spec' } },
                { id: 'call_read', name: 'read_spec_section', arguments: { section: '26 27 26', part: 2, article: '2.2' } },
              ],
            };
          }
          if (step === 2) {
            return {
              type: 'tool_calls',
              toolCalls: [
                {
                  id: 'call_count',
                  name: 'count_page_items',
                  arguments: { page: 1, query: 'receptacle', documentId: 'drawings' },
                },
              ],
            };
          }
          return {
            type: 'final',
            message:
              'Spec 26 27 26 article 2.2 requires Specification Grade 20A duplex (ProjectManual.pdf p.40). '
              + 'E-100 has 12 receptacles (Drawings.pdf · E-100).',
          };
        },
      },
    });

    const names = result.toolHistory.map(entry => entry.toolId);
    expect(names).toEqual(expect.arrayContaining(['search_project', 'read_spec_section', 'count_page_items']));
    expect(countCalls[0]).toMatchObject({ documentId: 'drawings' });
    expect(useCanvasStore.getState().activeDocId).toBe('drawings');
    expect(result.assistantMessage).toMatch(/26 27 26/);
    expect(result.assistantMessage).toMatch(/E-100/);
    expect(result.assistantMessage).toMatch(/ProjectManual|p\.40/i);
  });
});
