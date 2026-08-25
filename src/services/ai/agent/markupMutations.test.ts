import './testGlobals';
import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { useHistoryStore } from '@/store/historyStore';
import { createAgentToolContext } from './createToolContext';
import {
  activateEditorToolOnCanvas,
  executeDeleteMarkups,
  executeUpdateMarkups,
} from './markupMutations';
import { executeAssistantTool, executeApprovedAssistantAction } from '../tools/registry';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from './tools/registerAll';
import { BASE_RENDER_SCALE } from '../placement/coords';
import type { CanvasMarkup } from '@/types/markup';

function baseMarkup(overrides: Partial<CanvasMarkup> & Pick<CanvasMarkup, 'id' | 'type'>): CanvasMarkup {
  return {
    page: 1,
    style: {
      strokeColor: '#111',
      fillColor: 'transparent',
      strokeWidth: 1,
      opacity: 1,
      fontSize: 12,
      fontFamily: 'Arial',
    },
    locked: false,
    author: 'test',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as CanvasMarkup;
}

describe('activate_editor_tool + update/delete markups', () => {
  beforeEach(() => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    useHistoryStore.getState().clearHistory();
    useEditorStore.setState({ activeTool: 'select' });
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.getState().setPdfDocument('doc-mut', { _fake: true }, 2, 612, 792);
  });

  it('activate_editor_tool runs immediately and updates editorStore.activeTool', async () => {
    const context = createAgentToolContext({
      runId: 'run-activate',
      messageId: 'msg-activate',
      trade: 'electrical',
      placeMarkups: async () => ({ placed: 0 }),
    });

    const result = await executeAssistantTool(
      'activate_editor_tool',
      { tool: 'measure-length', description: 'Switch to measure' },
      context,
    );

    expect(result.status).toBe('completed');
    expect(result.summary).toMatch(/measure-length/i);
    expect(useEditorStore.getState().activeTool).toBe('measure-length');

    const direct = activateEditorToolOnCanvas('count');
    expect(direct.activated).toBe(true);
    expect(useEditorStore.getState().activeTool).toBe('count');
  });

  it('activate_editor_tool rejects unknown tools without approval', async () => {
    const context = createAgentToolContext({
      runId: 'run-activate-bad',
      messageId: 'msg-activate-bad',
      trade: 'electrical',
      placeMarkups: async () => ({ placed: 0 }),
    });
    const result = await executeAssistantTool(
      'activate_editor_tool',
      { tool: 'not-a-real-tool' },
      context,
    );
    expect(result.status).toBe('failed');
    expect(useEditorStore.getState().activeTool).toBe('select');
  });

  it('delete_markups requires approval then removes stored markups with per-id results and undo', async () => {
    const keep = baseMarkup({
      id: 'keep-1',
      type: 'rectangle',
      x: 10,
      y: 10,
      width: 40,
      height: 20,
    });
    const removeA = baseMarkup({
      id: 'del-a',
      type: 'text',
      x: 50,
      y: 50,
      width: 80,
      height: 24,
      content: 'A',
    });
    const removeB = baseMarkup({
      id: 'del-b',
      type: 'count-marker',
      x: 100,
      y: 120,
      number: 1,
      groupId: 'g1',
    });
    useCanvasStore.getState().setMarkupsForPage(1, [keep, removeA, removeB]);

    const context = createAgentToolContext({
      runId: 'run-del',
      messageId: 'msg-del',
      trade: 'electrical',
      placeMarkups: async () => ({ placed: 0 }),
    });

    const proposal = await executeAssistantTool('delete_markups', {
      description: 'Remove two markups',
      markupIds: ['del-a', 'del-b', 'missing-id'],
      page: 1,
    }, context);
    expect(proposal.status).toBe('approval-required');
    expect(useCanvasStore.getState().getMarkupsByPage()[1]).toHaveLength(3);

    const executed = await executeApprovedAssistantAction(proposal.approval!, context) as {
      deleted: number;
      notFound: number;
      results: Array<{ id: string; status: string }>;
    };
    expect(executed.deleted).toBe(2);
    expect(executed.notFound).toBe(1);
    expect(executed.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'del-a', status: 'deleted' }),
      expect.objectContaining({ id: 'del-b', status: 'deleted' }),
      expect.objectContaining({ id: 'missing-id', status: 'not-found' }),
    ]));

    const after = useCanvasStore.getState().getMarkupsByPage()[1];
    expect(after.map(m => m.id)).toEqual(['keep-1']);

    useCanvasStore.getState().undo();
    const restored = useCanvasStore.getState().getMarkupsByPage()[1];
    expect(restored.map(m => m.id).sort()).toEqual(['del-a', 'del-b', 'keep-1']);
  });

  it('update_markups requires approval, patches real stored fields, rejects wrong-type fields, supports undo', async () => {
    const text = baseMarkup({
      id: 'txt-1',
      type: 'text',
      x: 15 * BASE_RENDER_SCALE,
      y: 20 * BASE_RENDER_SCALE,
      width: 60 * BASE_RENDER_SCALE,
      height: 18 * BASE_RENDER_SCALE,
      content: 'Before',
      label: 'old',
    });
    const rect = baseMarkup({
      id: 'rect-1',
      type: 'rectangle',
      x: 100,
      y: 200,
      width: 50,
      height: 40,
    });
    useCanvasStore.getState().setMarkupsForPage(1, [text, rect]);

    const context = createAgentToolContext({
      runId: 'run-upd',
      messageId: 'msg-upd',
      trade: 'electrical',
      placeMarkups: async () => ({ placed: 0 }),
    });

    const proposal = await executeAssistantTool('update_markups', {
      description: 'Relabel and move text; invalid content on rectangle',
      updates: [
        {
          id: 'txt-1',
          page: 1,
          patch: {
            content: 'After',
            label: 'new',
            x: 30,
            y: 40,
            style: { strokeColor: '#ff0000' },
          },
        },
        {
          id: 'rect-1',
          patch: { content: 'nope' },
        },
        {
          id: 'ghost',
          patch: { label: 'x' },
        },
      ],
    }, context);
    expect(proposal.status).toBe('approval-required');

    const executed = await executeApprovedAssistantAction(proposal.approval!, context) as {
      updated: number;
      rejected: number;
      notFound: number;
      results: Array<{ id: string; status: string; reason?: string }>;
    };
    expect(executed.updated).toBe(1);
    expect(executed.rejected).toBe(1);
    expect(executed.notFound).toBe(1);

    const pageMarkups = useCanvasStore.getState().getMarkupsByPage()[1];
    const updatedText = pageMarkups.find(m => m.id === 'txt-1');
    expect(updatedText?.type).toBe('text');
    if (!updatedText || updatedText.type !== 'text') throw new Error('expected text markup');
    expect(updatedText.content).toBe('After');
    expect(updatedText.label).toBe('new');
    expect(updatedText.style.strokeColor).toBe('#ff0000');
    expect(updatedText.x).toBeCloseTo(30 * BASE_RENDER_SCALE, 5);
    expect(updatedText.y).toBeCloseTo(40 * BASE_RENDER_SCALE, 5);

    const unchangedRect = pageMarkups.find(m => m.id === 'rect-1');
    expect(unchangedRect?.type).toBe('rectangle');
    if (!unchangedRect || unchangedRect.type !== 'rectangle') throw new Error('expected rectangle');
    expect(unchangedRect.x).toBe(100);
    expect('content' in unchangedRect).toBe(false);

    useCanvasStore.getState().undo();
    const undone = useCanvasStore.getState().getMarkupsByPage()[1]
      .find(m => m.id === 'txt-1');
    expect(undone?.type).toBe('text');
    if (!undone || undone.type !== 'text') throw new Error('expected text after undo');
    expect(undone.content).toBe('Before');
    expect(undone.label).toBe('old');
  });

  it('executeUpdateMarkups / executeDeleteMarkups return completed status instead of unsupported', () => {
    useCanvasStore.getState().setMarkupsForPage(1, [
      baseMarkup({
        id: 'm1',
        type: 'callout',
        x: 1,
        y: 2,
        width: 10,
        height: 10,
        content: 'c',
      }),
    ]);
    const updated = executeUpdateMarkups({
      updates: [{ id: 'm1', patch: { content: 'updated' } }],
    });
    expect(updated.status).toBe('completed');
    expect(updated.updated).toBe(1);
    expect((updated as { message?: string }).message).not.toMatch(/unsupported/i);

    const deleted = executeDeleteMarkups({ markupIds: ['m1'] });
    expect(deleted.status).toBe('completed');
    expect(deleted.deleted).toBe(1);
    expect(deleted.message).not.toMatch(/unsupported/i);
  });
});
