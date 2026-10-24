import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceConversationContextId } from '@/lib/workspaceConversation';
import { parseAssistantFocus, validateModelClarificationOptions } from './clarificationTemplates';
import { parseAgentDecision } from './decisionParser';
import { rebindCachedPages } from '../projectIndex/store';
import { executeAssistantTool, findSheet } from '../tools/registry';
import { useCanvasStore } from '@/store/canvasStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { createFlagDiscrepanciesTool, conversationDiscrepancies } from '../discrepancies/discrepancyTool';
import { discrepancyAsRfi } from '@/lib/discrepancyText';
import type { IndexedPageRecord } from '../projectIndex/types';

describe('workspace-wide chat', () => {
  it('uses one conversation for every document in the workspace', () => {
    const a = workspaceConversationContextId([{ path: 'C:/plans/E.pdf' }], 'u1');
    const b = workspaceConversationContextId([{ path: 'C:/plans/E.pdf' }, { path: 'C:/specs/Manual.pdf' }], 'u1');
    expect(a).toBe('user:u1:workspace');
    expect(b).toBe(a);
  });

  it('a saved project gets its own stable thread', () => {
    const id = workspaceConversationContextId([{ path: 'C:\\Jobs\\Library.bidveraai' }, { path: 'x.pdf' }], 'u1');
    expect(id).toBe('project:c:/jobs/library.bidveraai');
  });
});

describe('clarification focus', () => {
  it('parses focus on the question and on options', () => {
    const decision = parseAgentDecision(JSON.stringify({
      type: 'clarify',
      message: 'Which panel feeds these fixtures?',
      questions: ['Which panel feeds these fixtures?'],
      focus: { documentId: 'd1', page: 4, bounds: { x: 10, y: 20, width: 30, height: 40 }, label: 'panel LP' },
      options: [
        { id: 'a', label: 'LP-1', value: 'LP-1', focus: { page: 4, bounds: { x: 1, y: 2, width: 3, height: 4 } } },
        { id: 'b', label: 'LP-2', value: 'LP-2' },
      ],
    }));
    expect(decision.type).toBe('clarify');
    if (decision.type !== 'clarify') return;
    expect(decision.focus).toEqual({ documentId: 'd1', page: 4, bounds: { x: 10, y: 20, width: 30, height: 40 }, label: 'panel LP' });
    const options = validateModelClarificationOptions(decision.options)!;
    expect(options[0].focus?.page).toBe(4);
    expect(options[1].focus).toBeUndefined();
  });

  it('drops malformed focus', () => {
    expect(parseAssistantFocus({ page: 0 })).toBeUndefined();
    expect(parseAssistantFocus({ page: 2, bounds: { x: 1, y: 1, width: 0, height: 5 } })).toEqual({ page: 2 });
  });
});

describe('navigate_page by sheet number', () => {
  beforeEach(() => {
    rebindCachedPages('fp1', 'doc_e', 'Electrical.pdf', [
      { docId: 'doc_e', page: 7, sheetNumber: 'E-201', lines: [], text: '' } as unknown as IndexedPageRecord,
    ]);
    useCanvasStore.setState(state => ({ ...state, activeDocId: 'doc_e', pdfDocuments: { doc_e: { totalPages: 20 } } as never }));
  });

  it('resolves the sheet through the project index', async () => {
    expect(findSheet('e201')).toEqual({ docId: 'doc_e', page: 7 });
    const navigateToPage = vi.fn();
    const result = await executeAssistantTool('navigate_page', { sheetNumber: 'E-201' }, { navigateToPage } as never);
    expect(result.status).toBe('completed');
    expect(navigateToPage).toHaveBeenCalledWith(7, undefined, 'doc_e');
  });

  it('reports unknown sheets', async () => {
    const navigateToPage = vi.fn();
    const result = await executeAssistantTool('navigate_page', { sheetNumber: 'E-999' }, { navigateToPage } as never);
    expect(result.status).toBe('failed');
    expect(navigateToPage).not.toHaveBeenCalled();
  });
});

describe('discrepancy cards', () => {
  beforeEach(() => {
    useCanvasStore.setState(state => ({
      ...state,
      activeDocId: 'doc_e',
      pdfDocuments: { doc_e: { totalPages: 20 }, doc_s: { totalPages: 900 } } as never,
    }));
    useAIChatStore.setState({
      messages: [{ id: 'm1', role: 'assistant', content: '', timestamp: new Date(), blocks: [] }] as never,
    });
  });

  const row = {
    title: 'Fixture type A: 4000K on schedule vs 3500K in spec',
    severity: 'medium' as const,
    drawing: { documentId: 'doc_e', page: 7, excerpt: 'TYPE A ... 4000K' },
    spec: { documentId: 'doc_s', page: 686, section: '26 51 19 2.3', excerpt: 'CCT: 3500K' },
    recommendation: 'Price 3500K per spec; submit RFI.',
  };

  it('adds a card with both sides and skips repeats', async () => {
    const tool = createFlagDiscrepanciesTool();
    const first = await tool.execute({ messageId: 'm1' } as never, { discrepancies: [row] } as never);
    expect(first.status).toBe('completed');
    const again = await tool.execute({ messageId: 'm1' } as never, { discrepancies: [row] } as never);
    expect((again.output as { flagged: number }).flagged).toBe(0);
    const all = conversationDiscrepancies();
    expect(all).toHaveLength(1);
    expect(all[0].drawing.sheetNumber).toBe('E-201');
    const rfi = discrepancyAsRfi(all[0]);
    expect(rfi).toMatch(/^RFI: Fixture type A/);
    expect(rfi).toContain('"CCT: 3500K"');
  });

  it('rejects unknown documents instead of inventing citations', async () => {
    const tool = createFlagDiscrepanciesTool();
    const out = await tool.execute({ messageId: 'm1' } as never, {
      discrepancies: [{ ...row, spec: { ...row.spec, documentId: 'nope' } }],
    } as never);
    expect(out.status).toBe('failed');
    expect(conversationDiscrepancies()).toHaveLength(0);
  });
});
