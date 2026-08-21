import { beforeEach, describe, expect, it } from 'vitest';
import { useCanvasStore } from '@/store/canvasStore';
import { createPageGeometry } from './coords';
import { resolvePageAnchors } from './resolvePageAnchors';
import { DEFAULT_RENDER_SCALE } from './types';

describe('resolvePageAnchors', () => {
  beforeEach(() => {
    useCanvasStore.getState().clearAllDocuments();
    useCanvasStore.getState().clearDocumentSnapData();
  });

  it('returns text/corner anchors from canvas text cache and vector anchors from snap data', () => {
    useCanvasStore.getState().setPdfDocument('doc-1', { _fake: true }, 1, 1000, 800);
    // Canvas text is stored at BASE_RENDER_SCALE (1.5).
    useCanvasStore.getState().setTextContent(1, [
      {
        str: 'PANEL',
        x: 150 * DEFAULT_RENDER_SCALE,
        y: 200 * DEFAULT_RENDER_SCALE,
        width: 40 * DEFAULT_RENDER_SCALE,
        height: 12 * DEFAULT_RENDER_SCALE,
      },
    ]);
    useCanvasStore.setState(state => ({
      documentSnapDataByPage: {
        'doc-1': {
          1: {
            endpoints: [{ x: 50, y: 60 }],
            intersections: [{ x: 70, y: 80 }],
            lines: [],
          },
        },
      },
      // preserve active doc from setPdfDocument
      activeDocId: state.activeDocId || 'doc-1',
    }));

    const page = createPageGeometry({
      pageNumber: 1,
      docWidth: 1000,
      docHeight: 800,
    });
    const anchors = resolvePageAnchors({ page, pageNumber: 1 });

    expect(anchors.some(anchor => anchor.type === 'text')).toBe(true);
    expect(anchors.some(anchor => anchor.type === 'corner')).toBe(true);
    expect(anchors.some(anchor => anchor.type === 'endpoint' && anchor.point?.x === 50)).toBe(true);
    expect(anchors.some(anchor => anchor.type === 'intersection' && anchor.point?.x === 70)).toBe(true);
  });

  it('returns an empty list when the page has no text or snap data (snap stays a no-op)', () => {
    useCanvasStore.getState().setPdfDocument('doc-empty', { _fake: true }, 1, 1000, 800);
    const page = createPageGeometry({ pageNumber: 1, docWidth: 1000, docHeight: 800 });
    expect(resolvePageAnchors({ page, pageNumber: 1 })).toEqual([]);
  });
});
