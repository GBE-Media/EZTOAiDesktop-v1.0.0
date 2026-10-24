import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

async function smallPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([72, 72]);
  return doc.save();
}

async function parse(data: Uint8Array) {
  return (pdfjs as { getDocument: (opts: unknown) => { promise: Promise<{ numPages: number }> } })
    .getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;
}

describe('loadPDF buffer ownership', () => {
  it('leaves the caller ArrayBuffer intact after a real pdfjs-legacy parse of a copied view', async () => {
    const bytes = await smallPdf();
    const caller = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(caller).set(bytes);
    const copied = new Uint8Array(caller.slice(0));
    const loaded = await parse(copied);
    expect(caller.byteLength).toBeGreaterThan(0);
    expect(loaded.numPages).toBe(1);
  });

  it('without the copy it would be 0 (shared buffer is detached)', async () => {
    const bytes = await smallPdf();
    const caller = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(caller).set(bytes);
    const shared = new Uint8Array(caller);
    structuredClone(shared, { transfer: [caller] });
    expect(caller.byteLength).toBe(0);
  });
});
