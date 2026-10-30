import './testGlobals';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import type { CanvasMarkup } from '@/types/markup';
import { executeAssistantTool } from '../tools/registry';
import { createAgentToolContext } from './createToolContext';
import { normalizeViewRegion } from '../imageCapture';
import { markersInRegion, viewPage, type RegionRenderer } from './viewPage';
import { attachViewImages, MAX_VIEW_IMAGES_IN_CONTEXT } from './runnerCore';
import type { AgentModelMessage } from './types';

const fakePdf = { _fake: true };

function marker(id: string, number: number, xPt: number, yPt: number, review = false): CanvasMarkup {
  return {
    id, type: 'count-marker', page: 1, number, groupId: 'g', x: xPt * 1.5, y: yPt * 1.5,
    style: {} as never, locked: false, author: 'AI', createdAt: '', label: 'A',
    ...(review ? { reviewMarker: true } : {}),
  } as unknown as CanvasMarkup;
}

function renderStub() {
  const calls: Array<{ page: number; region: unknown; marks: Array<[number, number]> }> = [];
  const render: RegionRenderer = async (_pdf, page, region, opts) => {
    const marks: Array<[number, number]> = [];
    if (opts?.overlay) {
      const ctx = {
        canvas: { width: 2048, height: 1600 },
        beginPath() {}, arc() {}, stroke() {}, fillText() {},
      } as unknown as CanvasRenderingContext2D;
      opts.overlay(ctx, (x, y) => { marks.push([x, y]); return [x, y]; });
    }
    calls.push({ page, region, marks });
    return { base64: 'data:image/jpeg;base64,AAA', width: 2048, height: 1600, scale: 2, dpi: 144 };
  };
  return { render, calls };
}

describe('view_page', () => {
  beforeEach(() => {
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.getState().setPdfDocument('doc-1', fakePdf, 5, 612, 792);
  });

  it('normalizes regions into the page', () => {
    expect(normalizeViewRegion(undefined)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(normalizeViewRegion({ x: 90, y: -5, width: 30, height: 0 })).toEqual({ x: 70, y: 0, width: 30, height: 2 });
  });

  it('renders the requested page and region and returns the image separately from text', async () => {
    const { render, calls } = renderStub();
    const result = await viewPage({ page: 3, region: { x: 10, y: 20, width: 25, height: 25 } }, { render });
    expect(result.status).toBe('completed');
    expect(calls[0]).toMatchObject({ page: 3, region: { x: 10, y: 20, width: 25, height: 25 } });
    expect(result.image?.base64).toMatch(/^data:image/);
    expect(result.image?.caption).toMatch(/page 3, region x 10\.0–35\.0%/);
  });

  it('turns a DocPoint centre into a close-up box', async () => {
    const { render, calls } = renderStub();
    await viewPage({ page: 1, center: { x: 306, y: 396 }, sizePt: 72 }, { render });
    const region = calls[0].region as { x: number; width: number };
    expect(region.x).toBeCloseTo(((306 - 36) / 612) * 100);
    expect(region.width).toBeCloseTo((72 / 612) * 100);
  });

  it('draws count markers in the view and lists their ids for corrections', async () => {
    const store = useCanvasStore.getState();
    store.addMarkup(1, marker('m1', 1, 61.2, 79.2));
    store.addMarkup(1, marker('m2', 2, 550, 700, true));
    const { render, calls } = renderStub();
    const result = await viewPage({ page: 1, region: { x: 0, y: 0, width: 50, height: 50 } }, { render });
    expect(result.markersShown).toEqual([{ id: 'm1', number: 1, label: 'A', x: 10, y: 10 }]);
    expect(calls[0].marks).toEqual([[10, 10]]);
    const all = markersInRegion(store.getMarkupsByPage('doc-1')[1], 612, 792, { x: 0, y: 0, width: 100, height: 100 });
    expect(all.find(m => m.id === 'm2')?.review).toBe(true);
  });

  it('rejects pages out of range and reports no document', async () => {
    const { render } = renderStub();
    expect((await viewPage({ page: 9 }, { render })).status).toBe('failed');
    useCanvasStore.getState().clearAllDocuments();
    expect((await viewPage({ page: 1 }, { render })).status).toBe('unavailable');
  });

  it('keeps the image out of the registry text output', async () => {
    const context = createAgentToolContext({ runId: 'r', messageId: 'm', trade: 'electrical', placeMarkups: () => ({}) });
    const spy = vi.spyOn(context, 'viewPage' as never).mockResolvedValue({
      status: 'completed', page: 2, image: { base64: 'data:image/jpeg;base64,BBB', caption: 'cap' },
    } as never);
    const result = await executeAssistantTool('view_page', { page: 2 }, context);
    expect(spy).toHaveBeenCalled();
    expect(result.status).toBe('completed');
    expect(result.image?.base64).toBe('data:image/jpeg;base64,BBB');
    expect(JSON.stringify(result.output)).not.toContain('BBB');
  });
});

describe('attachViewImages', () => {
  it('adds the renders as a user message for the next model step', () => {
    const messages: AgentModelMessage[] = [{ role: 'user', content: 'check page 2' }];
    attachViewImages(messages, [{ base64: 'img1', caption: 'page 2' }]);
    expect(messages[1].role).toBe('user');
    expect(messages[1].images).toEqual(['img1']);
    expect(messages[1].content).toMatch(/not typed by the user/);
  });

  it('keeps only the most recent renders attached', () => {
    const messages: AgentModelMessage[] = [];
    for (let i = 0; i < 5; i += 1) attachViewImages(messages, [{ base64: `img${i}`, caption: `v${i}` }]);
    const attached = messages.flatMap(m => m.images || []);
    expect(attached).toEqual(['img2', 'img3', 'img4']);
    expect(attached.length).toBe(MAX_VIEW_IMAGES_IN_CONTEXT);
    expect(messages[0].content).toMatch(/no longer attached/);
  });

  it('does nothing without images', () => {
    const messages: AgentModelMessage[] = [];
    attachViewImages(messages, []);
    expect(messages).toHaveLength(0);
  });
});
