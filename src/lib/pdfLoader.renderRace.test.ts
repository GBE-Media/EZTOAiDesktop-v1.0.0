import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from './pdfLoader';

describe('render race', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('two rapid flips paint only the last page', async () => {
    const painted: number[] = [];
    const canvas = {
      style: { width: '', height: '' },
      width: 0,
      height: 0,
      getContext: () => ({}),
    } as unknown as HTMLCanvasElement;

    const makePage = (n: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 100 * scale }),
      render: () => ({
        promise: Promise.resolve().then(() => { painted.push(n); }),
        cancel() {},
      }),
      cleanup() {},
    });

    const doc = {
      getPage: async (n: number) => {
        if (n === 1) await new Promise(r => setTimeout(r, 30));
        return makePage(n);
      },
    };

    const first = renderPage(doc as never, 1, canvas, 1).then(
      () => 'page-1',
      err => (err as Error).name,
    );
    const second = renderPage(doc as never, 2, canvas, 1).then(() => 'page-2');
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('RenderingCancelledException');
    expect(b).toBe('page-2');
    expect(painted).toEqual([2]);
  });
});
