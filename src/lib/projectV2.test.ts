import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { decodeBase64Chunked, encodeBase64Chunked } from './base64Chunks';
import { useCanvasStore } from '@/store/canvasStore';
import { cacheSet, cacheGet, cacheClearAll } from './pageCache';

async function tinyPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText('E-100', { x: 50, y: 50, size: 12, font });
  return pdf.save();
}

describe('project v1/v2 pdf bytes', () => {
  it('opens a v1 base64 document and preserves markups through a v2 fileRef shape', async () => {
    const bytes = await tinyPdf();
    const pdfData = encodeBase64Chunked(bytes);
    const v1 = {
      version: '1.1.0',
      name: 'Legacy',
      documents: [{
        id: 'doc-1',
        name: 'sheet.pdf',
        pdfData,
        pages: 1,
        currentPage: 1,
        zoom: 100,
        markups: [{ id: 'm1', type: 'count', page: 1, x: 10, y: 10 }],
        measurements: [],
      }],
    };
    const decoded = decodeBase64Chunked(v1.documents[0].pdfData);
    expect(decoded.length).toBe(bytes.length);
    expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);

    const v2 = {
      version: '2',
      name: 'Legacy',
      documents: [{
        ...v1.documents[0],
        pdfData: undefined,
        fileRef: { relPath: 'Legacy.bidveraai.files/abc.pdf', sha256: 'a'.repeat(64), byteLength: decoded.length },
        markups: v1.documents[0].markups,
      }],
    };
    expect(v2.documents[0].markups).toEqual(v1.documents[0].markups);
    expect(v2.documents[0].pdfData).toBeUndefined();
    expect(v2.documents[0].fileRef.byteLength).toBe(decoded.length);
  });
});

describe('canvas LRU getters', () => {
  it('re-extracts on miss after eviction', () => {
    cacheClearAll();
    useCanvasStore.getState().setPdfDocument('doc-lru', { _fake: true }, 60, 612, 792);
    useCanvasStore.getState().setActiveDocId('doc-lru');
    for (let page = 1; page <= 55; page++) {
      useCanvasStore.getState().setTextContent(page, [{ str: `p${page}` } as never]);
    }
    expect(useCanvasStore.getState().getTextContent(1)).toEqual([]);
    useCanvasStore.getState().setTextContent(1, [{ str: 'restored' } as never]);
    expect(useCanvasStore.getState().getTextContent(1)[0]).toMatchObject({ str: 'restored' });
    expect(cacheGet('text', 'doc-lru', 1)).toBeTruthy();
  });
});
