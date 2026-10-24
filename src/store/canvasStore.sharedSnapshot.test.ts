import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useCanvasStore } from './canvasStore';

describe('removeDocument snapshot release', () => {
  const releaseSnapshot = vi.fn(async () => ({ success: true }));
  beforeEach(() => {
    releaseSnapshot.mockClear();
    (globalThis as any).window = (globalThis as any).window || globalThis;
    (window as any).electronAPI = { releaseSnapshot };
  });

  it('keeps a content-addressed snapshot while another open doc still reads it', () => {
    const snap = '/u/pdf-cache/abc.pdf';
    const s = useCanvasStore.getState();
    const fake = { destroy: vi.fn() };
    s.setPdfDocument('d1', fake, 1, 612, 792, undefined, { source: 'file', path: snap } as any);
    s.setPdfDocument('d2', { destroy: vi.fn() }, 1, 612, 792, undefined, { source: 'file', path: snap } as any);
    useCanvasStore.getState().removeDocument('d1');
    expect(releaseSnapshot).not.toHaveBeenCalled();
    useCanvasStore.getState().removeDocument('d2');
    expect(releaseSnapshot).toHaveBeenCalledWith(snap);
  });
});
