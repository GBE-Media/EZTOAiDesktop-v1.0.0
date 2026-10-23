import { describe, expect, it, vi } from 'vitest';
import * as pdfjsLib from 'pdfjs-dist';
import { loadPDF } from './pdfLoader';

vi.mock('pdfjs-dist', async () => {
  const actual = await vi.importActual<typeof import('pdfjs-dist')>('pdfjs-dist');
  return {
    ...actual,
    getDocument: (source: unknown) => {
      if (source instanceof Uint8Array && source.byteLength) {
        source.fill(0);
      }
      return { promise: Promise.resolve({ numPages: 1 }) };
    },
  };
});

describe('loadPDF buffer ownership', () => {
  it('leaves the caller ArrayBuffer intact after getDocument', async () => {
    const ab = new ArrayBuffer(64);
    new Uint8Array(ab).fill(9);
    await loadPDF(ab);
    expect(ab.byteLength).toBeGreaterThan(0);
    expect(new Uint8Array(ab)[0]).toBe(9);
  });
});
