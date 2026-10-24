import { perfBudget } from '@/test/perfBudget';
import { describe, expect, it, vi } from 'vitest';
import { classifyPage, fillSpecSectionRanges } from './classify';
import { indexPdfDocument } from './indexPages';
import { readSpecSection } from './readSpec';
import { searchIndexedPages } from './searchIndex';
import { clearIndexMemory, documentFingerprint, saveIndexedPages, loadCachedPages } from './store';
import type { IndexedLine, IndexedPageRecord } from './types';
import { formatToolResultForPrompt } from '../agent/safety';
import { executeAssistantTool } from '../tools/registry';
import { registerAllAgentTools, resetAgentToolRegistrationForTests } from '../agent/tools/registerAll';
import type { AssistantToolContext } from '../tools/types';

function line(text: string, x: number, y: number): IndexedLine {
  return { text, bbox: { x, y, width: Math.max(40, text.length * 6), height: 12 } };
}

function drawingPage(page: number, sheet: string, extra: string, docId = 'drawings'): IndexedPageRecord {
  const width = 1728;
  const height = 2592;
  const lines = [
    line('LIGHTING PLAN', 80, 80),
    line(extra, 200, 400),
    line('SHEET TITLE', 1200, 2480),
    line(sheet, 1500, 2500),
  ];
  const classified = classifyPage(lines, width, height);
  return {
    docId,
    docFp: `${docId}:30`,
    documentName: 'Drawings.pdf',
    page,
    label: sheet,
    lines,
    kind: classified.kind,
    sheetNumber: classified.sheetNumber,
    sheetTitle: classified.sheetTitle,
    discipline: classified.discipline,
    specSection: classified.specSection,
    articles: classified.articles,
    needsOcr: false,
  };
}

function specPage(page: number, section: string, title: string, body: string[], docId = 'specs'): IndexedPageRecord {
  const lines = [
    line(`SECTION ${section} - ${title}`, 72, 36),
    line('PART 1 GENERAL', 72, 80),
    line('PART 2 PRODUCTS', 72, 120),
    ...body.map((text, i) => line(text, 72, 160 + i * 16)),
    line('PART 3 EXECUTION', 72, 700),
  ];
  const classified = classifyPage(lines, 612, 792);
  return {
    docId,
    docFp: `${docId}:120`,
    documentName: 'ProjectManual.pdf',
    page,
    lines,
    kind: classified.kind,
    sheetTitle: classified.sheetTitle,
    specSection: classified.specSection,
    articles: classified.articles,
    needsOcr: false,
  };
}

function fixturePages(): IndexedPageRecord[] {
  const drawings = [
    drawingPage(1, 'E-100', 'Panel LP-2 feeds receptacles'),
    drawingPage(2, 'E-101', 'Lighting plan'),
    drawingPage(3, 'E-601', 'FIXTURE SCHEDULE Type A LED'),
    drawingPage(4, 'FA-101', 'Fire alarm riser'),
  ];
  const specs = [
    specPage(10, '26 05 19', 'LOW-VOLTAGE ELECTRICAL POWER CONDUCTORS', ['1.1 SCOPE']),
    specPage(40, '26 27 26', 'WIRING DEVICES', [
      '2.1 SWITCHES',
      '2.2 RECEPTACLES Specification Grade 20A 125V duplex, ivory.',
      '2.3 COVER PLATES',
    ]),
    specPage(80, '28 31 00', 'FIRE DETECTION AND ALARM', ['2.1 MANUFACTURERS Notifier, Siemens']),
  ];
  const scanned: IndexedPageRecord = {
    docId: 'scan',
    docFp: 'scan:1',
    documentName: 'Scan.pdf',
    page: 1,
    lines: [],
    kind: 'other',
    needsOcr: true,
  };
  return fillSpecSectionRanges([...drawings, ...specs, scanned]);
}

function toolContext(overrides: Partial<AssistantToolContext> = {}): AssistantToolContext {
  return {
    runId: 'run-index',
    messageId: 'msg-index',
    getDocumentContext: vi.fn(() => ({ page: 1 })),
    analyzePage: vi.fn(async () => ({ status: 'completed' })),
    extractPageText: vi.fn(async () => ({ text: 'native text', source: 'native' })),
    searchDocument: vi.fn(async () => []),
    inspectCatalog: vi.fn(() => []),
    searchCatalog: vi.fn(() => ({ matches: [], noConfidentMatch: true, confidentMatches: [], message: '' })),
    inspectMarkups: vi.fn(() => []),
    navigateToPage: vi.fn(),
    activateEditorTool: vi.fn(),
    placeMarkups: vi.fn(),
    updateMarkups: vi.fn(),
    deleteMarkups: vi.fn(),
    linkCatalog: vi.fn(),
    addApproval: vi.fn(),
    ...overrides,
  };
}

describe('project index classification + search', () => {
  it('classifies sheet numbers, disciplines, spec ranges, articles, and scanned OCR flag', () => {
    const pages = fixturePages();
    expect(pages.find(p => p.sheetNumber === 'E-100')?.discipline).toBe('E');
    expect(pages.find(p => p.sheetNumber === 'FA-101')?.discipline).toBe('FA');
    expect(pages.find(p => p.specSection === '26 27 26')?.articles?.some(a => a.id.startsWith('2.2'))).toBe(true);
    expect(pages.find(p => p.specSection === '28 31 00')?.kind).toBe('spec');
    expect(pages.find(p => p.needsOcr)?.docId).toBe('scan');
  });

  it('search_project finds LP-2 and CSI number variants with filters', async () => {
    clearIndexMemory();
    const pages = fixturePages();
    await saveIndexedPages('drawings:30', pages.filter(p => p.docId === 'drawings'));
    await saveIndexedPages('specs:120', pages.filter(p => p.docId === 'specs'));

    const lp = searchIndexedPages(pages, { query: 'LP-2' });
    expect(lp.some(hit => hit.sheetNumber === 'E-100')).toBe(true);

    for (const query of ['26 27 26', '262726', 'Section 26-27-26']) {
      const hits = searchIndexedPages(pages, { query });
      expect(hits.some(hit => hit.specSection === '26 27 26'), query).toBe(true);
    }

    const electrical = searchIndexedPages(pages, { query: 'plan', kind: 'drawing', discipline: 'E' });
    expect(electrical.every(hit => hit.documentId === 'drawings')).toBe(true);
    expect(electrical.some(hit => hit.sheetNumber === 'FA-101')).toBe(false);
  });

  it('read_spec_section returns article 2.2 and honors cursors', () => {
    const pages = fixturePages();
    const article = readSpecSection(pages, { section: '262726', part: 2, article: '2.2' });
    expect(article.text).toMatch(/RECEPTACLES/i);
    expect(article.text).not.toMatch(/COVER PLATES/);
    const first = readSpecSection(pages, { section: '26 27 26', cursor: '0' });
    expect(first.section).toBe('26 27 26');
  });

  it('reopening uses the cache without re-extraction', async () => {
    clearIndexMemory();
    const extractPage = vi.fn(async (page: number) => ({
      lines: [line(`page ${page} SECTION 26 05 19 - CONDUCTORS`, 72, 36), line('PART 1 GENERAL', 72, 80)],
      width: 612,
      height: 792,
      needsOcr: false,
    }));
    const pdfDoc = {
      numPages: 3,
      fingerprints: ['abc'],
      getPageLabels: async () => ['i', 'ii', 'iii'],
      getPage: async () => ({}),
    };
    const first = await indexPdfDocument({
      docId: 'specs',
      documentName: 'ProjectManual.pdf',
      pdfDoc,
      extractPage,
    });
    expect(extractPage).toHaveBeenCalledTimes(3);
    extractPage.mockClear();
    const second = await indexPdfDocument({
      docId: 'specs',
      documentName: 'ProjectManual.pdf',
      pdfDoc,
      extractPage,
    });
    expect(extractPage).not.toHaveBeenCalled();
    expect(second).toHaveLength(first.length);
    const cached = await loadCachedPages(documentFingerprint(pdfDoc));
    expect(cached.length).toBe(3);
  });

  it('search of 1000 synthetic pages stays under 150ms', () => {
    const pages: IndexedPageRecord[] = [];
    for (let i = 1; i <= 1000; i++) {
      pages.push({
        docId: 'big',
        docFp: 'big:1000',
        documentName: 'Big.pdf',
        page: i,
        lines: [line(i === 417 ? 'Panel LP-2 in electrical room' : `General note ${i}`, 40, 40)],
        kind: i % 2 ? 'drawing' : 'other',
        needsOcr: false,
      });
    }
    const started = performance.now();
    const hits = searchIndexedPages(pages, { query: 'LP-2', limit: 10 });
    const elapsed = performance.now() - started;
    expect(hits[0]?.page).toBe(417);
    expect(elapsed).toBeLessThan(perfBudget(150));
  });

  it('project tools are registered read-only', async () => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    clearIndexMemory();
    await saveIndexedPages('drawings:30', fixturePages().filter(p => p.docId === 'drawings'));
    const listed = await executeAssistantTool('list_project_documents', {}, toolContext());
    expect(listed.status).toBe('completed');
    const searched = await executeAssistantTool('search_project', { query: 'LP-2' }, toolContext());
    expect(searched.status).toBe('completed');
    const output = searched.output as { results: Array<{ sheetNumber?: string }> };
    expect(output.results.some(hit => hit.sheetNumber === 'E-100')).toBe(true);
    expect(searched.citations?.length).toBeGreaterThan(0);
  });

  it('formatToolResultForPrompt delivers the full read_spec_section cursor window', async () => {
    resetAgentToolRegistrationForTests();
    registerAllAgentTools();
    clearIndexMemory();
    const pages: IndexedPageRecord[] = [];
    const body = 'W'.repeat(2500);
    for (let page = 1; page <= 4; page++) {
      pages.push({
        docId: 'specs',
        docFp: 'specs:4',
        documentName: 'Manual.pdf',
        page,
        lines: [line('SECTION 26 27 26 - WIRING DEVICES', 72, 36), line(body, 72, 80)],
        text: `SECTION 26 27 26 - WIRING DEVICES\n${body}`,
        kind: 'spec',
        specSection: '26 27 26',
        needsOcr: false,
      });
    }
    await saveIndexedPages('specs:4', pages);
    const first = await executeAssistantTool('read_spec_section', { section: '26 27 26' }, toolContext());
    const prompt = formatToolResultForPrompt(first);
    expect(prompt).not.toMatch(/…\[truncated\]/);
    const raw = (first.output as { text: string; nextCursor?: string });
    expect(raw.text.length).toBe(6000);
    expect(raw.nextCursor).toBe('6000');
    const second = await executeAssistantTool('read_spec_section', { section: '26 27 26', cursor: raw.nextCursor }, toolContext());
    const combined = raw.text + (second.output as { text: string }).text;
    expect(combined).toBe(pages.map(p => p.text).join('\n\n'));
  });
});
