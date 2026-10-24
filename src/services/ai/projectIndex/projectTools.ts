import { z } from 'zod';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { AssistantToolDefinition } from '../tools/types';
import { allIndexedPages, indexStatus } from './store';
import { searchIndexedPages } from './searchIndex';
import { readSpecSection } from './readSpec';
import { compactProjectDocuments, formatCitationLabel, sheetIndex, specIndex } from './summaries';
import { unknownDocumentResult } from './unknownDoc';
import type { EvidenceCitation } from '@/types/assistant';
import type { SearchHit } from './types';

function hitCitation(hit: SearchHit, index: number): EvidenceCitation {
  return {
    id: `search_${hit.documentId}_${hit.page}_${index}`,
    documentId: hit.documentId,
    documentName: hit.documentName,
    page: hit.page,
    pageLabel: hit.pageLabel,
    sheetNumber: hit.sheetNumber,
    specSection: hit.specSection,
    label: formatCitationLabel(hit),
    snippet: hit.snippet,
    bounds: hit.bounds,
  };
}

const documentIdSchema = z.string().min(1).optional()
  .describe('Open document id. Defaults to the active tab.');

export function createProjectIndexTools(): AssistantToolDefinition[] {
  return [
    {
      id: 'list_project_documents',
      title: 'List project documents',
      description: 'List every open project document with page counts, kind breakdown, index status, sheet and spec summaries.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
      execute: async (_context, input) => {
        const pages = allIndexedPages();
        const canvas = useCanvasStore.getState();
        const editor = useEditorStore.getState();
        const docs = editor.documents.map(doc => ({
          id: doc.id,
          name: doc.name,
          pages: canvas.pdfDocuments[doc.id]?.totalPages || 0,
        }));
        const listed = compactProjectDocuments(docs, pages);
        const status = indexStatus();
        const offset = input.offset ?? 0;
        const limit = Math.min(50, input.limit ?? 50);
        const allSheets = sheetIndex(pages);
        const allSpecs = specIndex(pages);
        const sheets = allSheets.slice(offset, offset + limit);
        const specs = allSpecs.slice(offset, offset + limit);
        return {
          status: 'completed',
          summary: `Listed ${listed.length} project document(s).`,
          output: {
            documents: listed,
            index: status,
            sheets: { items: sheets, count: allSheets.length, offset, nextOffset: offset + sheets.length < allSheets.length ? offset + sheets.length : undefined },
            specSections: { items: specs, count: allSpecs.length, offset, nextOffset: offset + specs.length < allSpecs.length ? offset + specs.length : undefined },
          },
        };
      },
    },
    {
      id: 'search_project',
      title: 'Search project documents',
      description: 'Full-text search across indexed specs and drawings. Returns clickable citations (doc/page/bbox).',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        query: z.string().min(1),
        kind: z.enum(['drawing', 'spec', 'other']).optional(),
        discipline: z.string().optional(),
        section: z.string().optional(),
        documentIds: z.array(z.string()).optional(),
        limit: z.number().int().positive().max(40).optional(),
      }),
      execute: async (_context, input) => {
        const hits = searchIndexedPages(allIndexedPages(), input);
        const citations = hits.map(hitCitation).slice(0, 8);
        return {
          status: 'completed',
          summary: `Found ${hits.length} passage(s) for “${input.query}”.`,
          output: { results: hits, count: hits.length },
          citations,
        };
      },
    },
    {
      id: 'get_sheet_index',
      title: 'Get drawing sheet index',
      description: 'List drawing sheets grouped by discipline.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        discipline: z.string().optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
      execute: async (_context, input) => {
        const items = sheetIndex(allIndexedPages(), input.discipline);
        const offset = input.offset ?? 0;
        const limit = Math.min(50, input.limit ?? 50);
        const slice = items.slice(offset, offset + limit);
        return {
          status: 'completed',
          summary: `Sheet index: ${items.length} sheet(s).`,
          output: {
            sheets: slice,
            count: items.length,
            offset,
            nextOffset: offset + slice.length < items.length ? offset + slice.length : undefined,
          },
          citations: slice.map((sheet, i) => ({
            id: `sheet_${sheet.documentId}_${sheet.page}_${i}`,
            documentId: sheet.documentId,
            documentName: sheet.documentName,
            page: sheet.page,
            pageLabel: sheet.pageLabel,
            sheetNumber: sheet.number,
            label: formatCitationLabel({
              documentName: sheet.documentName,
              sheetNumber: sheet.number,
              page: sheet.page,
              pageLabel: sheet.pageLabel,
            }),
          })),
        };
      },
    },
    {
      id: 'get_spec_index',
      title: 'Get spec section index',
      description: 'List CSI spec sections with document page ranges.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        division: z.string().optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(50).optional(),
      }),
      execute: async (_context, input) => {
        const items = specIndex(allIndexedPages(), input.division);
        const offset = input.offset ?? 0;
        const limit = Math.min(50, input.limit ?? 50);
        const slice = items.slice(offset, offset + limit);
        return {
          status: 'completed',
          summary: `Spec index: ${items.length} section(s).`,
          output: {
            sections: slice,
            count: items.length,
            offset,
            nextOffset: offset + slice.length < items.length ? offset + slice.length : undefined,
          },
        };
      },
    },
    {
      id: 'read_spec_section',
      title: 'Read spec section',
      description: 'Read a CSI spec section (normalize 262726 / 26 27 26 / 26-27-26). Optional part/article. Paged at ~6000 chars via nextCursor.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        section: z.string().min(1),
        part: z.union([z.string(), z.number()]).optional(),
        article: z.string().optional(),
        cursor: z.string().optional(),
      }),
      execute: async (_context, input) => {
        const pages = allIndexedPages();
        const result = readSpecSection(pages, input);
        const first = pages.find(p => p.kind === 'spec' && p.specSection === result.section);
        return {
          status: 'completed',
          summary: `Read spec ${result.section}${result.nextCursor ? ' (more available)' : ''}.`,
          output: result,
          citations: first ? [{
            id: `spec_${first.docId}_${first.page}`,
            documentId: first.docId,
            documentName: first.documentName,
            page: first.page,
            specSection: result.section,
            label: formatCitationLabel({
              documentName: first.documentName,
              specSection: result.section,
              page: first.page,
            }),
            snippet: result.text.slice(0, 300),
          }] : [],
        };
      },
    },
    {
      id: 'read_pages',
      title: 'Read document pages',
      description: 'Read native text (or OCR on demand) for up to 5 pages of a document.',
      risk: 'read',
      requiresConfirmation: false,
      undoable: false,
      schema: z.object({
        documentId: z.string().min(1),
        pages: z.array(z.number().int().positive()).min(1).max(5),
        maxChars: z.number().int().positive().optional(),
      }),
      execute: async (context, input) => {
        const unknown = unknownDocumentResult(input.documentId);
        if (unknown) return unknown;
        const maxChars = Math.min(input.maxChars ?? 6000, 6000);
        const pages = [];
        for (const page of input.pages) {
          const extracted = await context.extractPageText({ page, documentId: input.documentId }) as {
            text?: string;
            context?: string;
            source?: string;
            status?: string;
            message?: string;
          };
          const text = String(extracted?.text || extracted?.context || extracted?.message || '').slice(0, maxChars);
          pages.push({ documentId: input.documentId, page, source: extracted?.source, text });
        }
        return {
          status: 'completed',
          summary: `Read ${pages.length} page(s).`,
          output: { pages },
          citations: pages.map((row, i) => ({
            id: `read_${row.documentId}_${row.page}_${i}`,
            documentId: row.documentId,
            page: row.page,
            label: `p.${row.page}`,
            snippet: row.text.slice(0, 300),
          })),
        };
      },
    },
  ];
}

export { documentIdSchema };
