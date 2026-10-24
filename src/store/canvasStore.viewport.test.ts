import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from './canvasStore';
import { visualPageCenter } from '@/lib/computeFitTransform';

const PAGE_PT_W = 612;
const PAGE_PT_H = 792;
const BASE_RENDER_SCALE = 1.5;

function seedDocument(docId: string) {
  useCanvasStore.getState().setPdfDocument(
    docId,
    { id: docId },
    3,
    PAGE_PT_W,
    PAGE_PT_H,
  );
}

describe('canvas viewport fit and reset', () => {
  beforeEach(() => {
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.setState({ containerWidth: 0, containerHeight: 0, zoom: 100 });
  });

  it('does not fit when the container size is 0, then fits once a real size arrives', () => {
    seedDocument('doc-a');
    const missed = useCanvasStore.getState().fitToCanvas(0, 800);
    expect(missed).toBe(false);
    const before = useCanvasStore.getState().pdfDocuments['doc-a'];
    expect(before.hasViewState).toBe(false);
    expect(before.zoom).toBe(100);

    const applied = useCanvasStore.getState().fitToCanvas(1200, 800);
    expect(applied).toBe(true);
    const after = useCanvasStore.getState().pdfDocuments['doc-a'];
    expect(after.hasViewState).toBe(true);
    expect(after.viewUserAdjusted).toBe(false);
    const pageW = PAGE_PT_W * BASE_RENDER_SCALE;
    const pageH = PAGE_PT_H * BASE_RENDER_SCALE;
    const center = visualPageCenter(pageW, pageH, after.panOffset.x, after.panOffset.y);
    expect(Math.abs(center.x - 600)).toBeLessThanOrEqual(1);
    expect(Math.abs(center.y - 400)).toBeLessThanOrEqual(1);
  });

  it('resets pan/zoom when a new document opens', () => {
    seedDocument('doc-a');
    expect(useCanvasStore.getState().fitToCanvas(1200, 800)).toBe(true);
    useCanvasStore.getState().setZoom(250);
    useCanvasStore.getState().setPanOffset(40, 80);

    seedDocument('doc-b');
    const next = useCanvasStore.getState().pdfDocuments['doc-b'];
    expect(next.zoom).toBe(100);
    expect(next.panOffset).toEqual({ x: 0, y: 0 });
    expect(next.hasViewState).toBe(false);
    expect(next.viewUserAdjusted).toBe(false);
    expect(useCanvasStore.getState().zoom).toBe(100);
  });

  it('marks the view as user-adjusted after pan or zoom, and Fit Page clears that', () => {
    seedDocument('doc-a');
    expect(useCanvasStore.getState().fitToCanvas(1200, 800)).toBe(true);
    useCanvasStore.getState().setPanOffset(10, 20);
    expect(useCanvasStore.getState().pdfDocuments['doc-a'].viewUserAdjusted).toBe(true);
    expect(useCanvasStore.getState().fitToCanvas(1200, 800)).toBe(true);
    expect(useCanvasStore.getState().pdfDocuments['doc-a'].viewUserAdjusted).toBe(false);
  });
});
