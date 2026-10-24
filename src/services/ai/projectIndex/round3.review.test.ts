/**
 * Round-3 final-check probes (review of feat/project-index-cross-doc-ai @5b6af3d).
 * Place at: src/services/ai/projectIndex/round3.review.test.ts
 */
import '../agent/testGlobals';
import { beforeEach, describe, expect, it } from 'vitest';
import { indexPdfDocument } from './indexPages';
import { allIndexedPages, clearIndexMemory, projectIndexDb, saveIndexedPages } from './store';
import { buildSearchPassages, searchIndexedPages } from './searchIndex';
import { readSpecSection } from './readSpec';
import type { IndexedPageRecord } from './types';

type Item = { str: string; transform: number[]; width: number; height: number };
function fakePdf(fp: string, numPages: number, itemsFor: (n: number) => Item[], onGetPage?: (n: number) => void) {
  return {
    numPages, fingerprints: [fp], getPageLabels: async () => null,
    getPage: async (n: number) => {
      onGetPage?.(n);
      return { getViewport: () => ({ width: 612, height: 792 }), getTextContent: async () => ({ items: itemsFor(n) }) };
    },
  };
}
const line = (str: string, y: number, size = 10): Item => ({ str, transform: [size, 0, 0, size, 72, y], width: str.length * 5, height: size });

// 60-page manual: 26 05 19 p1-24 (END on p24), 26 27 26 p25-50 (END on p50), 26 28 13 p51-60.
const START: Record<number, string> = { 1: '260519', 25: '262726', 51: '262813' };
const END = new Set([24, 50, 60]);
function manualItems(n: number): Item[] {
  const items: Item[] = [];
  if (START[n]) items.push(line(`SECTION ${START[n]}`, 760, 9));
  for (let k = 0; k < 30; k++) items.push(line(`A. requirement ${k} page ${n} for receptacles and conductors.`, 700 - k * 15));
  if (END.has(n)) items.push(line(`END OF SECTION ${START[n <= 24 ? 1 : n <= 50 ? 25 : 51]}`, 200));
  items.push(line(`WIRING DEVICES ${n <= 24 ? '26 05 19' : n <= 50 ? '26 27 26' : '26 28 13'} - ${n}`, 40, 9));
  return items;
}

beforeEach(async () => {
  clearIndexMemory();
  await projectIndexDb.pages.clear();
});

describe('R3 persisted section ranges after incremental flushes', () => {
  it('rows reloaded from Dexie equal the in-memory ranged rows', async () => {
    const pdf = fakePdf('fpMAN60', 60, manualItems);
    const mem = await indexPdfDocument({ docId: 'm', documentName: 'M.pdf', pdfDoc: pdf as never });
    const rows = await projectIndexDb.pages.toArray();
    expect(rows.length).toBe(60);
    const key = (p: IndexedPageRecord) => `${p.page}|${p.kind}|${p.specSection ?? '-'}`;
    const persisted = rows.sort((a, b) => a.page - b.page).map(key);
    const inMemory = [...mem].sort((a, b) => a.page - b.page).map(key);
    const served = [...allIndexedPages()].sort((a, b) => a.page - b.page).map(key);
    expect(persisted).toEqual(inMemory);
    expect(served).toEqual(inMemory);
    expect(mem.filter(p => p.specSection === '26 27 26').length).toBe(26);
  });

  it('abort then resume (same fp) still persists FULL rows (not the slim memory copy)', async () => {
    const ctrl = new AbortController();
    const pdf = fakePdf('fpABORT', 60, manualItems, n => { if (n === 30) ctrl.abort(); });
    await indexPdfDocument({ docId: 'a1', documentName: 'A.pdf', pdfDoc: pdf as never, signal: ctrl.signal });
    const resumed = await indexPdfDocument({ docId: 'a2', documentName: 'A.pdf', pdfDoc: fakePdf('fpABORT', 60, manualItems) as never });
    expect(resumed.length).toBe(60);
    const rows = (await projectIndexDb.pages.toArray()).sort((a, b) => a.page - b.page);
    const short = rows.filter(r => r.lines.length < 30).map(r => `${r.page}:${r.lines.length}`);
    console.log('[R3] rows persisted with truncated lines after abort+resume:', short.length, short.slice(0, 6));
    expect(short).toEqual([]);
  });
});

describe('R3 mid-page section start keeps the previous section tail', () => {
  it('END OF SECTION 260519 + SECTION 262726 on one page: neither half is lost', async () => {
    const items = (n: number): Item[] => {
      if (n === 1) return [line('SECTION 260519', 760, 9), line('PART 3 - EXECUTION', 700), line('3.2 INSTALLATION', 680), line('A. install conductors.', 660), line('WIRING 26 05 19 - 1', 40, 9)];
      return [
        line('3.3 FIELD QUALITY CONTROL', 700), line('A. Perform insulation-resistance tests on each conductor.', 685),
        line('END OF SECTION 260519', 660), line('SECTION 262726 - WIRING DEVICES', 620, 12),
        line('PART 1 - GENERAL', 600), line('A. WIRING DEVICES SCOPE MARKER.', 585), line('WIRING DEVICES 26 27 26 - 1', 40, 9),
      ];
    };
    const pages = await indexPdfDocument({ docId: 'mp', documentName: 'MP.pdf', pdfDoc: fakePdf('fpMID', 2, items) as never });
    const s19 = readSpecSection(pages, { section: '26 05 19' }).text;
    const s26 = readSpecSection(pages, { section: '26 27 26' }).text;
    const hits = searchIndexedPages(pages, { query: 'insulation-resistance tests', limit: 5 });
    console.log('[R3] mid-page: 26 05 19 has 3.3?', s19.includes('3.3 FIELD QUALITY'), '| 26 27 26 has scope?', s26.includes('SCOPE MARKER'), '| search hits', hits.length);
    expect(s26).toContain('SCOPE MARKER');
    expect(s26).not.toContain('insulation-resistance');
    expect(s19).toContain('3.3 FIELD QUALITY CONTROL');
    expect(hits.length).toBeGreaterThan(0);
  });
});

function rec(page: number, texts: string[], extra: Partial<IndexedPageRecord> = {}): IndexedPageRecord {
  const lines = texts.map((t, i) => ({ text: t, bbox: { x: 0, y: i * 12, width: 100, height: 10 } }));
  return { docId: 'd', docFp: 'd:v3', documentName: 'D.pdf', page, lines, text: texts.join('\n'), kind: 'spec', needsOcr: false, passages: buildSearchPassages(lines), ...extra } as IndexedPageRecord;
}

describe('R3 search', () => {
  const pages = [
    rec(1, ['2.2 RECEPTACLES', 'A. Duplex receptacles.'], { specSection: '26 27 26' }),
    rec(2, ['2.3 SWITCHES', 'A. Single pole.'], { specSection: '26 27 26' }),
    rec(3, ['D. See Section 26 05 19, Article 2.3 for sizing.'], { specSection: '26 27 26' }),
    rec(4, ['PANEL LP-20 FEEDER'], { kind: 'drawing', sheetNumber: 'E1.01' }),
    rec(5, ['PANEL LP-2 FEEDER'], { kind: 'drawing', sheetNumber: 'E1.02' }),
    rec(6, ['Provide tamper-resistant receptacles.'], { specSection: '26 05 19' }),
    rec(7, ['Connect to panel LP-2.'], { kind: 'drawing', sheetNumber: 'E1.03' }),
  ];
  it('dotted numbers hit', () => {
    const a = searchIndexedPages(pages, { query: '2.2', limit: 5 });
    const b = searchIndexedPages(pages, { query: 'article 2.3', limit: 5 });
    expect(a[0]?.page).toBe(1);
    expect(b.map(h => h.page)).toEqual(expect.arrayContaining([2, 3]));
    expect(a.some(h => h.page === 2)).toBe(false);
  });
  it('LP-2 outranks LP-20, LP-20 is not an exact hit', () => {
    const r = searchIndexedPages(pages, { query: 'LP-2', limit: 5 });
    const s = (p: number) => r.find(h => h.page === p)?.score ?? 0;
    console.log('[R3] LP-2 scores', r.map(h => `${h.page}:${h.score}`));
    expect(s(5)).toBeGreaterThan(s(4));
  });
  it('sentence-final words / codes (trailing period) still match', () => {
    const w = searchIndexedPages(pages, { query: 'receptacles', limit: 10 }).map(h => h.page);
    const c = searchIndexedPages(pages, { query: 'LP-2', limit: 10 });
    console.log('[R3] "receptacles" pages', w, '| LP-2 pages', c.map(h => `${h.page}:${h.score}`));
    expect(w).toEqual(expect.arrayContaining([1, 6]));
    expect((c.find(h => h.page === 7)?.score ?? 0)).toBeGreaterThanOrEqual(10);
  });
  it('singular query still finds plural text (substring behaviour of round 2)', () => {
    const w = searchIndexedPages(pages, { query: 'receptacle', limit: 10 }).map(h => h.page);
    console.log('[R3] "receptacle" pages', w);
    expect(w).toEqual(expect.arrayContaining([1, 6]));
  });
});

describe('R3 read_spec_section part+article', () => {
  it('article inside part 2 when a later page repeats PART 1 header text', async () => {
    const pages = [
      rec(1, ['SECTION 262726 - WIRING DEVICES', 'PART 1 - GENERAL', '1.1 SUMMARY', 'PART 2 - PRODUCTS', '2.1 MANUFACTURERS', 'A. Hubbell.'], { specSection: '26 27 26' }),
      rec(2, ['2.2 RECEPTACLES', 'A. Duplex receptacles.', 'B. Install per Part 3.'], { specSection: '26 27 26' }),
      rec(3, ['C. Weather-resistant receptacles.', '2.3 SWITCHES'], { specSection: '26 27 26' }),
    ];
    await saveIndexedPages('d:v3', pages, 'd');
    const t = readSpecSection(pages, { section: '26 27 26', part: 2, article: '2.2' }).text;
    console.log('[R3] part 2 / 2.2 with in-body "Part 3" mention ->', JSON.stringify(t.slice(0, 120)));
    expect(t).toContain('Weather-resistant');
    expect(t).not.toContain('2.3 SWITCHES');
  });
});
