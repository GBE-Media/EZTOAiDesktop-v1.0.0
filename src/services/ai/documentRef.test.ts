import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { Document } from '@/types/editor';
import { rememberIndexedPages, clearIndexMemory } from './projectIndex/store';
import { resolveDocumentRef } from './documentRef';

function seedDoc(id: string, name: string, pages = 1) {
  useCanvasStore.getState().setPdfDocument(id, { id }, pages, 612, 792);
  const doc: Document = {
    id,
    name,
    path: name,
    pages,
    currentPage: 1,
    zoom: 100,
    modified: false,
    markups: [],
    measurements: [],
  };
  useEditorStore.getState().addDocument(doc);
}

describe('resolveDocumentRef', () => {
  beforeEach(() => {
    useCanvasStore.getState().clearAllDocuments();
    useEditorStore.setState({ documents: [], activeDocument: null });
    clearIndexMemory();
  });

  it('resolves [030] E-100_pages_1.pdf via 030, stem, sheet number, and real id', () => {
    seedDoc('doc-real-id', '[030] E-100_pages_1.pdf');
    rememberIndexedPages('doc-real-id', '[030] E-100_pages_1.pdf', 'fp-e100', [{
      docId: 'doc-real-id',
      docFp: 'fp-e100',
      documentName: '[030] E-100_pages_1.pdf',
      page: 1,
      lines: [],
      kind: 'drawing',
      sheetNumber: 'E-100',
      needsOcr: false,
    }]);

    expect(resolveDocumentRef('doc-real-id')).toEqual({ docId: 'doc-real-id', how: 'id' });
    expect(resolveDocumentRef('030')).toEqual({ docId: 'doc-real-id', how: 'code' });
    expect(resolveDocumentRef('E-100_pages_1')).toEqual({ docId: 'doc-real-id', how: 'name' });
    expect(resolveDocumentRef('E-100')).toEqual({ docId: 'doc-real-id', how: 'index' });
  });

  it('returns the valid id — name list for an ambiguous substring', () => {
    seedDoc('a', 'Lighting Plan A.pdf');
    seedDoc('b', 'Lighting Plan B.pdf');
    const result = resolveDocumentRef('Lighting');
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toMatch(/a — Lighting Plan A\.pdf/);
      expect(result.error).toMatch(/b — Lighting Plan B\.pdf/);
    }
  });

  it('uses the active document when no ref is given, but never guesses for an explicit unknown ref', () => {
    seedDoc('only', 'Sheet.pdf');
    expect(resolveDocumentRef(undefined)).toEqual({ docId: 'only', how: 'active' });
    expect('error' in resolveDocumentRef('no-such')).toBe(true);
  });

  it('uses the resolver at each of the seven document lookup call sites', () => {
    const root = resolve(__dirname, '../..');
    const sites: Array<[string, string]> = [
      ['services/ai/agent/createToolContext.ts', 'resolveToolDocument'],
      ['services/ai/agent/createToolContext.ts', 'resolveDocumentRef'],
      ['services/ai/projectIndex/unknownDoc.ts', 'resolveDocumentRef'],
      ['services/ai/projectIndex/projectTools.ts', 'unknownDocumentResult'],
      ['services/ai/tools/registry.ts', 'unknownDocumentResult'],
      ['services/ai/placement/approvalTarget.ts', 'resolveDocumentRef'],
      ['services/ai/placement/handleApprovalDecision.ts', 'resolveApprovalTarget'],
    ];
    for (const [rel, token] of sites) {
      const text = readFileSync(resolve(root, rel.replace(/\//g, '\\').includes('\\') ? rel : rel), 'utf8');
      expect(text, rel).toContain(token);
    }
    const ctx = readFileSync(resolve(root, 'services/ai/agent/createToolContext.ts'), 'utf8');
    expect(ctx.split('resolveToolDocument(').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('resolves "1" to the first open tab when no bracket code matches', () => {
    seedDoc('doc-a', 'E-201.pdf');
    seedDoc('doc-b', 'E-301.pdf');
    const resolved = resolveDocumentRef('1');
    expect('error' in resolved).toBe(false);
    if (!('error' in resolved)) expect(resolved.docId).toBe('doc-a');
  });

  it('fails an unknown explicit ref with the valid list instead of guessing the only doc', () => {
    seedDoc('doc-a', 'E-201.pdf');
    const resolved = resolveDocumentRef('doc-ghost');
    expect('error' in resolved).toBe(true);
    if ('error' in resolved) expect(resolved.error).toMatch(/E-201\.pdf/);
  });
});
