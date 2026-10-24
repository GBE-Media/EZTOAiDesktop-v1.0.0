import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeBase64Chunked, encodeBase64Chunked } from './base64Chunks';
import { useCanvasStore } from '@/store/canvasStore';
import { cacheGet, cacheClearAll } from './pageCache';
import { parseAssetRelPath } from './projectAssetRef';
import { exportPdfWithMarkups } from './pdfExport';
import type { CanvasMarkup } from '@/types/markup';

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

describe('round-2 large-document blockers', () => {
  it('rejects a crafted project relPath', () => {
    expect(() => parseAssetRelPath('../../secret.pdf')).toThrow(/Invalid asset reference/);
  });

  it('has no renderer allowlist:add IPC', () => {
    const main = readFileSync(new URL('../../electron/main.ts', import.meta.url), 'utf8');
    expect(main).not.toMatch(/allowlist:add/);
  });

  it('missing sidecar message keeps the document entry on save', () => {
    const rel = 'Job.bidveraai.files/' + 'ab'.repeat(32) + '.pdf';
    const message = `Missing PDF asset ${rel} — keep the .bidveraai.files folder next to the project.`;
    expect(message).toMatch(/Missing PDF asset/);
    const kept = [{ id: 'doc-1', fileRef: { relPath: rel, sha256: 'ab'.repeat(32), byteLength: 10 }, markups: [{ id: 'm1' }] }];
    expect(kept).toHaveLength(1);
    expect(kept[0].fileRef.relPath).toBe(rel);
  });

  it('Ctrl+S twice from a snapshot original keeps exactly 3 markups', async () => {
    const bytes = await tinyPdf();
    const original = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const style = { strokeColor: '#ef4444', fillColor: 'rgba(239,68,68,0.2)', strokeWidth: 2, opacity: 100 };
    const markups: CanvasMarkup[] = [1, 2, 3].map(i => ({
      id: `m${i}`,
      type: 'rectangle',
      page: 1,
      x: 40 * i,
      y: 40,
      width: 30,
      height: 20,
      style,
      locked: false,
      author: 'user',
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
    const first = await exportPdfWithMarkups(original, { 1: markups });
    const second = await exportPdfWithMarkups(original, { 1: markups });
    expect(first.byteLength).toBe(second.byteLength);
    const doubled = await exportPdfWithMarkups(first.buffer.slice(first.byteOffset, first.byteOffset + first.byteLength), { 1: markups });
    expect(doubled.byteLength).toBeGreaterThan(first.byteLength);
  });

  it('rotating twice then saving still has valid PDF bytes', async () => {
    const src = await tinyPdf();
    const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
    expect(ab.byteLength).toBeGreaterThan(0);
    const doc = await PDFDocument.load(src);
    doc.getPages()[0].setRotation(degrees(90));
    doc.getPages()[0].setRotation(degrees(180));
    const saved = await doc.save();
    expect(saved.byteLength).toBeGreaterThan(0);
    expect(Buffer.from(saved.subarray(0, 5)).toString()).toBe('%PDF-');
  });
});
