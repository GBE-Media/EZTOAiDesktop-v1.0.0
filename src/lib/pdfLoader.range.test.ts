import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

const getDocument = vi.fn();

vi.mock('pdfjs-dist', async () => {
  const actual = await vi.importActual<typeof import('pdfjs-dist')>('pdfjs-dist');
  return {
    ...actual,
    getDocument: (...args: unknown[]) => getDocument(...args),
  };
});

import { loadPDFFromUrl, renderPage } from './pdfLoader';

describe('loadPDFFromUrl range transport', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.stubGlobal('window', { devicePixelRatio: 1 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllGlobals();
    getDocument.mockReset();
  });

  it('uses PDFDataRangeTransport and never issues a non-Range GET', async () => {
    const ranges: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range');
      ranges.push(range || 'none');
      if (range === 'bytes=0-0') {
        return new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/4096' } });
      }
      return new Response(new Uint8Array(16), { status: 206, headers: { 'Content-Range': 'bytes 0-15/4096' } });
    }) as typeof fetch;

    getDocument.mockImplementation((opts: unknown) => {
      const rec = opts as { disableStream?: boolean; range?: { requestDataRange: (a: number, b: number) => void } };
      expect(rec.disableStream).toBe(true);
      expect(rec.range).toBeTruthy();
      rec.range?.requestDataRange(0, 16);
      return { promise: Promise.resolve({ numPages: 1 }) };
    });

    await loadPDFFromUrl('http://127.0.0.1/mock.pdf');
    expect(getDocument).toHaveBeenCalled();
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.every(r => r.startsWith('bytes='))).toBe(true);
  });

  it('sets CSS width from the uncapped scale when the backing store is capped', async () => {
    const canvas = {
      style: { width: '', height: '' },
      width: 0,
      height: 0,
      getContext: () => ({}),
    } as unknown as HTMLCanvasElement;
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 1728 * scale, height: 2592 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel() {} }),
      cleanup() {},
    };
    await renderPage({ getPage: async () => page } as never, 1, canvas, 8);
    expect(canvas.style.width).toBe(`${1728 * 8}px`);
    expect(canvas.width).toBeLessThan(1728 * 8 * 4);
  });
});
