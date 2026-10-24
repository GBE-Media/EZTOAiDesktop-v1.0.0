import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getDocument = vi.fn();

vi.mock('pdfjs-dist', async () => {
  const actual = await vi.importActual<typeof import('pdfjs-dist')>('pdfjs-dist');
  return {
    ...actual,
    getDocument: (...args: unknown[]) => getDocument(...args),
  };
});

import { loadPDFFromUrl, retargetPdfDocument } from './pdfLoader';
import { snapshotAndRetargetOpenDocument } from '@/hooks/useSave';
import { useCanvasStore } from '@/store/canvasStore';

describe('N1 retarget after save snapshot', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    getDocument.mockReset();
  });

  it('serves late page reads from the snapshot URL after retarget', async () => {
    const urls: string[] = [];
    const bodies = new Map<string, Uint8Array>([
      ['http://orig', new Uint8Array(16).fill(1)],
      ['http://snap', new Uint8Array(16).fill(9)],
    ]);
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      const range = new Headers(init?.headers).get('Range');
      if (range === 'bytes=0-0') {
        return new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/4096' } });
      }
      const body = bodies.get(String(url)) || new Uint8Array(16);
      return new Response(body, { status: 206, headers: { 'Content-Range': `bytes 0-15/4096` } });
    }) as typeof fetch;

    const proxy = { numPages: 3 };
    let transport: { requestDataRange: (a: number, b: number) => void } | undefined;
    getDocument.mockImplementation((opts: unknown) => {
      transport = (opts as { range: typeof transport }).range;
      return { promise: Promise.resolve(proxy), destroy: vi.fn() };
    });

    const loaded = await loadPDFFromUrl('http://orig');
    transport?.requestDataRange(0, 16);
    await new Promise(r => setTimeout(r, 20));
    const before = urls.filter(u => u === 'http://orig').length;
    expect(retargetPdfDocument(loaded.document, 'http://snap')).toBe(true);
    transport?.requestDataRange(0, 16);
    await new Promise(r => setTimeout(r, 20));
    expect(urls.filter(u => u === 'http://snap').length).toBeGreaterThan(0);
    expect(urls.filter(u => u === 'http://orig').length).toBe(before);
  });

  it('aborts save when snapshotOriginal fails', async () => {
    const proxy = { numPages: 1 };
    useCanvasStore.getState().setPdfDocument('doc-1', proxy, 1, 612, 792, undefined, { source: 'file', path: 'C:\\orig.pdf' });
    vi.stubGlobal('window', {
      electronAPI: {
        snapshotOriginal: async () => ({ success: false }),
      },
    });
    const result = await snapshotAndRetargetOpenDocument('doc-1', 'C:\\orig.pdf');
    expect(result).toBe('snapshot-failed');
    vi.unstubAllGlobals();
  });
});

describe('N2 range read failures', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    getDocument.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function headOkThen(rangeResponse: () => Promise<Response> | Response) {
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range');
      if (range === 'bytes=0-0') {
        return new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/4096' } });
      }
      return rangeResponse();
    }) as typeof fetch;
  }

  it('rejects the open within 2s when fetch rejects (one retry)', async () => {
    headOkThen(async () => { throw new Error('network'); });
    getDocument.mockImplementation((opts: unknown) => {
      (opts as { range: { requestDataRange: (a: number, b: number) => void } }).range.requestDataRange(0, 16);
      return { promise: new Promise(() => {}), destroy: vi.fn() };
    });
    const started = Date.now();
    await expect(loadPDFFromUrl('http://orig')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('rejects the open when the range status is 500', async () => {
    headOkThen(() => new Response('error html', { status: 500 }));
    getDocument.mockImplementation((opts: unknown) => {
      (opts as { range: { requestDataRange: (a: number, b: number) => void } }).range.requestDataRange(0, 16);
      return { promise: new Promise(() => {}), destroy: vi.fn() };
    });
    await expect(loadPDFFromUrl('http://orig')).rejects.toThrow(/500/);
  });

  it('rejects the open on a short range body', async () => {
    headOkThen(() => new Response(new Uint8Array(2), { status: 206 }));
    getDocument.mockImplementation((opts: unknown) => {
      (opts as { range: { requestDataRange: (a: number, b: number) => void } }).range.requestDataRange(0, 16);
      return { promise: new Promise(() => {}), destroy: vi.fn() };
    });
    await expect(loadPDFFromUrl('http://orig')).rejects.toThrow(/Short range/);
  });

  it('calls onReadError after a successful open', async () => {
    const onReadError = vi.fn();
    let transport: { requestDataRange: (a: number, b: number) => void } | undefined;
    let opened = false;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range');
      if (!opened && range === 'bytes=0-0') {
        return new Response('x', { status: 206, headers: { 'Content-Range': 'bytes 0-0/4096' } });
      }
      if (opened) return new Response('nope', { status: 500 });
      return new Response(new Uint8Array(16), { status: 206 });
    }) as typeof fetch;
    getDocument.mockImplementation((opts: unknown) => {
      transport = (opts as { range: typeof transport }).range;
      return { promise: Promise.resolve({ numPages: 1 }), destroy: vi.fn() };
    });
    await loadPDFFromUrl('http://orig', { onReadError });
    opened = true;
    transport?.requestDataRange(0, 16);
    await new Promise(r => setTimeout(r, 80));
    expect(onReadError).toHaveBeenCalled();
  });
});
