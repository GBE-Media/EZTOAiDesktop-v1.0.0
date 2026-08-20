import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runAssistantOperation } from './assistantOrchestrator';
import { executeAssistantTool } from './tools/registry';
import type { AssistantToolContext } from './tools/types';
import { useAIChatStore } from '@/store/aiChatStore';

describe('deterministic assistant workflow', () => {
  beforeEach(() => {
    useAIChatStore.setState({
      messages: [],
      runs: {},
      approvals: {},
      conversation: null,
      conversationContextId: null,
      conversationHydrated: false,
    });
  });

  it('observes evidence, proposes callouts, and waits for approval without editing', async () => {
    const messageId = useAIChatStore.getState().addMessage({ role: 'assistant', content: '' });
    const placeMarkups = vi.fn();
    let activeRunId = '';

    await runAssistantOperation({
      messageId,
      summary: 'Inspect page 2 and propose green callouts',
      operation: async operation => {
        activeRunId = operation.runId;
        const context: AssistantToolContext = {
          runId: operation.runId,
          messageId,
          signal: operation.signal,
          getDocumentContext: () => ({ document: 'E-201.pdf', page: 2 }),
          analyzePage: async () => ({ detections: 2, confidence: 0.96 }),
          extractPageText: async () => ({ status: 'completed', context: '', source: 'none', items: [] }),
          searchDocument: async () => [],
          inspectCatalog: () => [],
          inspectMarkups: () => [],
          navigateToPage: vi.fn(),
          activateEditorTool: vi.fn(),
          placeMarkups,
          updateMarkups: vi.fn(),
          deleteMarkups: vi.fn(),
          linkCatalog: vi.fn(),
          addApproval: approval => useAIChatStore.getState().addApproval(approval),
        };
        operation.report({
          id: 'evidence',
          label: 'Verified two receptacles on page 2',
          status: 'completed',
          citations: [{ id: 'p2', documentName: 'E-201.pdf', page: 2, label: 'Page 2', confidence: 0.96 }],
        });
        await executeAssistantTool('get_document_context', {}, context);
        const proposal = await executeAssistantTool('place_markups', {
          payload: [{ id: 'green-1' }, { id: 'green-2' }],
          description: 'Place two verified green callouts',
        }, context);
        expect(proposal.status).toBe('approval-required');
      },
    });

    expect(placeMarkups).not.toHaveBeenCalled();
    expect(Object.values(useAIChatStore.getState().approvals)).toHaveLength(1);
    expect(useAIChatStore.getState().runs[activeRunId].steps).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'evidence', status: 'completed' })])
    );
  });
});
