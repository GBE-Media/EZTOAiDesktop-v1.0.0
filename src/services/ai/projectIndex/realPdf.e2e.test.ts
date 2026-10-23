/**
 * Real-PDF end-to-end test for the project index (review of feat/project-index-cross-doc-ai).
 */
import '../agent/testGlobals';
import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { indexPdfDocument } from './indexPages';
import { clearIndexMemory, projectIndexDb, loadCachedPages } from './store';
import { createProjectIndexTools } from './projectTools';
import { formatToolResultForPrompt } from '../agent/safety';
import { formatProjectDocumentsSummary, compactProjectDocuments } from './summaries';
import type { IndexedPageRecord } from './types';
import type { AssistantToolContext } from '../tools/types';

const REPORT = !!process.env.REPORT;
const log = (...a: unknown[]) => { if (REPORT) console.log(...a); };

const SHEETS: Array<[string, string]> = [
  ['E-001', 'ELECTRICAL LEGEND AND GENERAL NOTES'],
  ['E-100', 'LIGHTING PLAN - LEVEL 1'],
  ['E-101', 'POWER PLAN - LEVEL 1'],
  ['E-102', 'LIGHTING PLAN - LEVEL 2'],
  ['E-103', 'POWER PLAN - LEVEL 2'],
  ['E-104', 'LIGHTING PLAN - LEVEL 3'],
  ['E-105', 'POWER PLAN - LEVEL 3'],
  ['E-106', 'ROOF POWER PLAN'],
  ['E-201', 'ENLARGED ELECTRICAL ROOM PLAN'],
  ['E-301', 'SITE ELECTRICAL PLAN'],
  ['E-401', 'LIGHTING CONTROLS DIAGRAMS'],
  ['E-501', 'ELECTRICAL DETAILS'],
  ['E-502', 'ELECTRICAL DETAILS'],
  ['E-601', 'PANEL SCHEDULES'],
  ['E-602', 'PANEL SCHEDULES'],
  ['E-603', 'LIGHT FIXTURE SCHEDULE'],
  ['E-701', 'ONE-LINE DIAGRAM'],
  ['FA-001', 'FIRE ALARM LEGEND AND NOTES'],
  ['FA-101', 'FIRE ALARM PLAN - LEVEL 1'],
  ['FA-102', 'FIRE ALARM PLAN - LEVEL 2'],
  ['FA-103', 'FIRE ALARM PLAN - LEVEL 3'],
  ['FA-501', 'FIRE ALARM RISER DIAGRAM'],
  ['T-101', 'TECHNOLOGY PLAN - LEVEL 1'],
  ['T-102', 'TECHNOLOGY PLAN - LEVEL 2'],
  ['M-101', 'MECHANICAL PLAN - LEVEL 1'],
  ['P-101', 'PLUMBING PLAN - LEVEL 1'],
  ['A-101', 'FLOOR PLAN - LEVEL 1'],
  ['E-104A', 'PARTIAL LIGHTING PLAN - AREA A'],
  ['E-900', 'ROTATED TITLE BLOCK SHEET'],
  ['', ''],
];

async function buildDrawingSet(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 36 * 72; const H = 24 * 72;
  SHEETS.forEach(([num, title], i) => {
    const p = doc.addPage([W, H]);
    const t = (s: string, x: number, y: number, size = 10, f = font, rot = 0) =>
      p.drawText(s, { x, y, size, font: f, rotate: degrees(rot) });
    t('GENERAL NOTES:', 120, H - 120, 14, bold);
    t('1. ALL RECEPTACLES SHALL BE SPECIFICATION GRADE. REFER TO SECTION 26 27 26.', 120, H - 145);
    t('2. BRANCH CIRCUITS FROM PANEL LP-2 UNLESS NOTED OTHERWISE.', 120, H - 165);
    if (i % 3 === 1) t('PANEL LP-2', 900, 800, 12, bold);
    if (num === 'E-101') t('LP-2', 1400, 900, 10, bold);
    if (num === 'E-102') t('E-501', 1200, 700, 9, font);
    if (num === 'E-603') {
      t('LIGHT FIXTURE SCHEDULE', 1500, H - 120, 14, bold);
      ['TYPE A  2X4 LED TROPHER 4000K 40W  LITHONIA 2BLT4', 'TYPE B  6" LED DOWNLIGHT 3500K 15W', 'TYPE X  LED EXIT SIGN  BATTERY BACKUP']
        .forEach((r, k) => t(r, 1500, H - 150 - k * 18));
    }
    if (i >= 4 && i <= 8) t('SCALE: 1/8" = 1\'-0"   KEYNOTE 4: PROVIDE GFCI', 300, 70);
    if (!num) {
      t('REFER TO SECTION 26 27 26 - WIRING DEVICES FOR DEVICE REQUIREMENTS.', 120, 300);
      return;
    }
    p.drawRectangle({ x: W - 430, y: 20, width: 410, height: 340, borderWidth: 2 });
    const rot = num === 'E-900' ? 90 : 0;
    if (rot) {
      t(num, W - 60, 60, 36, bold, 90);
      t(title, W - 120, 60, 12, bold, 90);
    } else {
      t('ACME ENGINEERING, LLC', W - 410, 330, 10);
      t('MIDDLE SCHOOL ADDITION', W - 410, 300, 12, bold);
      t('PROJECT NO. 2026-114', W - 410, 280, 9);
      t('DATE: 10/01/2026', W - 410, 262, 9);
      t('SHEET TITLE', W - 410, 200, 8);
      t(title, W - 410, 180, 14, bold);
      t('SHEET NUMBER', W - 410, 120, 8);
      t(num, W - 410, 70, 36, bold);
    }
  });
  return doc.save();
}

type SecDef = { num: string; title: string; start: number; end: number };
const SECTIONS: SecDef[] = [
  { num: '26 05 19', title: 'LOW-VOLTAGE ELECTRICAL POWER CONDUCTORS AND CABLES', start: 4, end: 40 },
  { num: '26 27 26', title: 'WIRING DEVICES', start: 41, end: 90 },
  { num: '28 31 00', title: 'FIRE DETECTION AND ALARM', start: 91, end: 150 },
];

async function buildProjectManual(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const W = 612; const H = 792;
  for (let pageNo = 1; pageNo <= 150; pageNo++) {
    const p = doc.addPage([W, H]);
    let y = H - 72;
    const t = (s: string, x = 72, f = font, size = 10) => { p.drawText(s, { x, y, size, font: f }); y -= 14; };
    if (pageNo === 1) { y = 500; t('PROJECT MANUAL', 200, bold, 20); t('MIDDLE SCHOOL ADDITION', 200, bold, 14); continue; }
    if (pageNo === 2 || pageNo === 3) {
      t('TABLE OF CONTENTS', 220, bold, 12);
      t('DIVISION 26 - ELECTRICAL', 72, bold);
      const toc = ['26 05 00 COMMON WORK RESULTS FOR ELECTRICAL', '26 05 19 LOW-VOLTAGE ELECTRICAL POWER CONDUCTORS AND CABLES',
        '26 05 26 GROUNDING AND BONDING FOR ELECTRICAL SYSTEMS', '26 05 33 RACEWAYS AND BOXES FOR ELECTRICAL SYSTEMS',
        '26 24 16 PANELBOARDS', '26 27 26 WIRING DEVICES', '26 28 16 ENCLOSED SWITCHES AND CIRCUIT BREAKERS',
        '26 51 19 LED INTERIOR LIGHTING', 'DIVISION 28 - ELECTRONIC SAFETY AND SECURITY', '28 31 00 FIRE DETECTION AND ALARM'];
      for (const row of toc) t(row);
      t('PART 1 through PART 3 format per CSI SectionFormat.');
      continue;
    }
    const sec = SECTIONS.find(s => pageNo >= s.start && pageNo <= s.end)!;
    const local = pageNo - sec.start + 1;
    t('MIDDLE SCHOOL ADDITION                                   PROJECT NO. 2026-114', 72, font, 8);
    if (local === 1) {
      t(`SECTION ${sec.num} - ${sec.title}`, 150, bold, 12);
      t('PART 1 - GENERAL', 72, bold);
      t('1.1 RELATED DOCUMENTS');
      t('A. Drawings and general provisions of the Contract apply to this Section.');
      t('1.2 SUMMARY');
      t(`A. Related Requirements: Section ${sec.num === '26 05 19' ? '26 05 33' : '26 05 19'} for conductors and raceways.`);
    } else if (local === 3 && sec.num !== '26 27 26') {
      t('PART 2 - PRODUCTS', 72, bold);
      t('2.1 MANUFACTURERS');
      t(sec.num === '28 31 00' ? 'A. Notifier; Simplex; Edwards.' : 'A. Southwire; Encore Wire; General Cable.');
      t(sec.num === '28 31 00' ? '2.2 SYSTEMS OPERATIONAL DESCRIPTION' : '2.2 CONDUCTORS AND CABLES');
      t('A. Copper, THHN/THWN-2, 600 V.');
    } else if (local === 3) {
      t('PART 2 - PRODUCTS', 72, bold);
      t('2.1 MANUFACTURERS');
      t('A. Basis-of-Design: Hubbell Incorporated; Leviton; Pass & Seymour.');
      t('2.2 RECEPTACLES');
      t('A. Duplex receptacles: NEMA 5-20R, 20 A, 125 V, specification grade, UL 498.');
      t('B. GFCI receptacles: feed-through type, self-test, UL 943 Class A.');
      for (let k = 0; k < 30; k++) t(`C.${k + 1} Additional receptacle requirement line ${k + 1} for article 2.2 continuing.`);
    } else if (local === 4) {
      t('D. Tamper-resistant receptacles where required by NFPA 70 Article 406.12 (continued from 2.2).');
      t('2.3 SWITCHES');
      t('A. Single-pole switches: 20 A, 120/277 V, UL 20.');
    } else if (local === 6) {
      t('PART 3 - EXECUTION', 72, bold);
      t('3.1 INSTALLATION');
      t('A. Coordinate with Section 26 05 33 Raceways and Boxes.');
    } else {
      for (let k = 0; k < 40; k++) t(`${k % 2 ? 'B' : 'A'}. Body text line ${k} for ${sec.title.toLowerCase()} requirements page ${local}.`);
    }
    if (pageNo === sec.end) t('END OF SECTION ' + sec.num, 220, bold);
    p.drawText(`${sec.title}`, { x: 72, y: 40, size: 9, font });
    p.drawText(`${sec.num} - ${local}`, { x: 480, y: 40, size: 9, font });
  }
  return doc.save();
}

async function loadPdf(bytes: Uint8Array) {
  return (pdfjs as { getDocument: (opts: unknown) => { promise: Promise<{ fingerprints?: string[]; numPages: number; getPage: (n: number) => Promise<unknown> }> } }).getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
}

let drawingPages: IndexedPageRecord[] = [];
let specPages: IndexedPageRecord[] = [];
let indexMsDrawings = 0; let indexMsSpecs = 0;
let maxBlockMs = 0;

const ctx = { extractPageText: async () => ({ text: '' }) } as unknown as AssistantToolContext;
const tool = (id: string) => createProjectIndexTools().find(t => t.id === id)!;
async function run(id: string, input: Record<string, unknown>) {
  const def = tool(id);
  const parsed = def.schema.parse(input);
  const result = await def.execute(ctx, parsed as never);
  return { raw: result, prompt: formatToolResultForPrompt(result as never) };
}

describe('project index on REAL PDFs (pdf-lib -> pdfjs-dist)', () => {
  beforeAll(async () => {
    clearIndexMemory();
    await projectIndexDb.pages.clear();
    const dBytes = await buildDrawingSet();
    const sBytes = await buildProjectManual();
    const dPdf = await loadPdf(dBytes);
    const sPdf = await loadPdf(sBytes);
    let last = performance.now(); let running = true;
    const probe = () => { const now = performance.now(); maxBlockMs = Math.max(maxBlockMs, now - last); last = now; if (running) setTimeout(probe, 0); };
    setTimeout(probe, 0);
    let t0 = performance.now();
    drawingPages = await indexPdfDocument({ docId: 'drawings', documentName: 'Drawings.pdf', pdfDoc: dPdf, yieldEveryPage: true });
    indexMsDrawings = performance.now() - t0;
    t0 = performance.now();
    specPages = await indexPdfDocument({ docId: 'specs', documentName: 'ProjectManual.pdf', pdfDoc: sPdf, yieldEveryPage: true });
    indexMsSpecs = performance.now() - t0;
    running = false;
    log(`index ms: drawings(30p)=${indexMsDrawings.toFixed(0)} specs(150p)=${indexMsSpecs.toFixed(0)} maxBlock=${maxBlockMs.toFixed(1)}ms`);
    log('fingerprints', dPdf.fingerprints, sPdf.fingerprints);
  }, 120_000);

  it('drawing sheets: numbers + titles from 24x36 title block', () => {
    const rows = drawingPages.map((p, i) => ({ page: p.page, expect: SHEETS[i][0], got: p.sheetNumber ?? '', title: p.sheetTitle ?? '', kind: p.kind, spec: p.specSection ?? '' }));
    const correct = rows.filter(r => r.expect && r.got === r.expect).length;
    const titlesOk = rows.filter((r, i) => r.expect && r.title === SHEETS[i][1]).length;
    log(`sheet numbers correct ${correct}/29, titles exact ${titlesOk}/29`);
    log('sheet rows (page expect->got | title):\n' + rows.map(r => `${r.page} ${r.expect}->${r.got} | ${r.title} | ${r.kind}`).join('\n'));
    expect(correct).toBeGreaterThanOrEqual(26);
    expect(titlesOk).toBeGreaterThanOrEqual(24);
  });

  it('drawing page with no title block but "Refer to Section 26 27 26" is NOT a spec page', () => {
    const p30 = drawingPages[29];
    log('page30', p30.kind, p30.specSection, p30.sheetNumber);
    expect(p30.kind).not.toBe('spec');
  });

  it('spec section ranges, TOC false positives, cross-reference false positives', async () => {
    const kinds = specPages.map(p => `${p.page}:${p.kind}:${p.specSection ?? '-'}`);
    const wrong = specPages.filter(p => {
      const sec = SECTIONS.find(s => p.page >= s.start && p.page <= s.end);
      return sec ? p.specSection !== sec.num || p.kind !== 'spec' : p.kind === 'spec';
    }).map(p => `${p.page}:${p.kind}:${p.specSection ?? '-'}`);
    log(`spec pages wrong: ${wrong.length}/150`, wrong.slice(0, 40).join(' '));
    const idx = await run('get_spec_index', {});
    log('get_spec_index', JSON.stringify((idx.raw as { output: unknown }).output));
    expect(kinds.length).toBe(150);
    expect(wrong.length).toBe(0);
  });

  it('read_spec_section article 2.2 + cursor + what the model actually sees', async () => {
    const art = await run('read_spec_section', { section: '262726', part: 2, article: '2.2' });
    const raw = (art.raw as { output: { text: string } }).output;
    log('article 2.2 len', raw.text.length, 'includes continuation D.', raw.text.includes('Tamper-resistant'), 'leaks 2.3', raw.text.includes('2.3 SWITCHES'));
    expect(raw.text).toContain('2.2 RECEPTACLES');
    expect(raw.text).not.toContain('2.3 SWITCHES');
    const full = await run('read_spec_section', { section: '26 27 26' });
    const fullRaw = (full.raw as { output: { text: string; nextCursor?: string } }).output;
    log('full section chunk', fullRaw.text.length, 'nextCursor', fullRaw.nextCursor, 'prompt chars', full.prompt.length, 'prompt truncated', /…\[truncated\]/.test(full.prompt));
    expect(full.prompt).not.toMatch(/…\[truncated\]/);
  });

  it('search_project: LP-2 across drawings and receptacles in spec', async () => {
    const s = await run('search_project', { query: 'panel LP-2', kind: 'drawing', limit: 40 });
    const hits = (s.raw as { output: { results: Array<{ page: number; sheetNumber?: string; snippet: string }> } }).output.results;
    const lp2Pages = drawingPages.filter(p => p.lines.some(l => /LP-2/.test(l.text)) || p.passages?.some(x => /lp-2/.test(x.lower))).map(p => p.page);
    log('LP-2 pages', lp2Pages.length, 'hits', hits.length, 'top5', hits.slice(0, 5).map(h => `${h.page}/${h.sheetNumber}:${h.snippet.slice(0, 60)}`));
    for (const h of hits) expect(h.snippet.length).toBeLessThanOrEqual(300);
    const r = await run('search_project', { query: 'duplex receptacles specification grade', kind: 'spec' });
    const rh = (r.raw as { output: { results: Array<{ specSection?: string; snippet: string; page: number }> } }).output.results;
    log('receptacle top3', rh.slice(0, 3).map(h => `${h.page}/${h.specSection}:${h.snippet.slice(0, 60)}`));
    expect(rh[0]?.specSection).toBe('26 27 26');
  });

  it('get_sheet_index lists sheets with titles', async () => {
    const r = await run('get_sheet_index', {});
    const out = (r.raw as { output: { count: number } }).output;
    log('sheet index count', out.count, 'prompt chars', r.prompt.length);
    expect(out.count).toBeGreaterThanOrEqual(26);
  });

  it('persistence: rows written to IndexedDB and readable after memory clear; fingerprint stable', async () => {
    const fp = drawingPages[0].docFp;
    const rows = await projectIndexDb.pages.where('docFp').equals(fp).count();
    clearIndexMemory();
    const back = await loadCachedPages(fp);
    log('idb rows', rows, 'reloaded', back.length, 'fp', fp);
    expect(rows).toBe(30);
    expect(back.length).toBe(30);
  });

  it('memory estimate for line storage', () => {
    const all = [...drawingPages, ...specPages];
    const bytes = JSON.stringify(all.map(p => p.lines)).length;
    const lines = all.reduce((s, p) => s + p.lines.length, 0);
    log(`lines=${lines} jsonBytes=${bytes} perPage=${(bytes / all.length).toFixed(0)}B -> 3000 pages ~ ${((bytes / all.length) * 3000 / 1e6).toFixed(1)} MB JSON (heap ~2-3x)`);
    expect(lines).toBeGreaterThan(0);
  });

  it('search latency at 3000 pages (spec <150ms target)', async () => {
    const { searchIndexedPages } = await import('./searchIndex');
    const big: IndexedPageRecord[] = [];
    for (let k = 0; k < 20; k++) for (const p of specPages) big.push({ ...p, docId: `specs${k}`, page: p.page });
    const t0 = performance.now();
    searchIndexedPages(big, { query: 'duplex receptacles specification grade', limit: 10 });
    const specMs = performance.now() - t0;
    const dense: IndexedPageRecord[] = Array.from({ length: 3000 }, (_, i) => ({
      ...drawingPages[i % 29],
      page: i + 1,
      lines: Array.from({ length: 400 }, (_, k) => ({ text: `LP-2-${k} 20A 1P ${k % 7 ? 'RECEPT' : 'LIGHTING'} ROOM ${100 + k}`, bbox: { x: k, y: k, width: 50, height: 10 } })),
    }));
    const t1 = performance.now();
    searchIndexedPages(dense, { query: 'panel LP-2', limit: 10 });
    const denseMs = performance.now() - t1;
    const denseBytes = JSON.stringify(dense.map(p => p.lines)).length;
    log(`search 3000 spec-like pages ${specMs.toFixed(0)}ms; 3000 dense drawing pages (400 lines) ${denseMs.toFixed(0)}ms; dense line JSON ${(denseBytes / 1e6).toFixed(0)} MB`);
    expect(specMs).toBeLessThan(150);
    expect(denseMs).toBeLessThan(150);
  }, 60_000);

  it('system-prompt project summary with 40 docs', () => {
    const docs = Array.from({ length: 40 }, (_, i) => ({ id: `d${i}`, name: `Bid Package ${i} - Electrical Drawings and Specifications Volume ${i}.pdf`, pages: 75 }));
    const s = formatProjectDocumentsSummary(compactProjectDocuments(docs, []), 0, 3000);
    log('summary chars', s.length, '~tokens', Math.round(s.length / 4), 'docs listed', s.split('\n').length - 1);
    expect(s.length / 4).toBeLessThanOrEqual(600);
  });
});
