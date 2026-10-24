/**
 * Round-2 overfitting probe (review of feat/project-index-cross-doc-ai @53078b8).
 * A NEW real-PDF fixture the author never saw:
 *  - 30x42 drawing set, title block = RIGHT-EDGE VERTICAL STRIP, label "DWG NO.", title ABOVE label,
 *    sheet numbers E1.01 / E-1.01 / ES-101, a few two-line titles, a few strip-rotated (90deg) sheets,
 *    plan tags (LP-2, LP-20, E-501, TYPE A/B) in the body.
 *  - Project manual with: running header "SECTION 262726" (no spaces), footer "WIRING DEVICES 26 27 26 - 3"
 *    (title first), Division 01 sections with footer-only convention, a 4-page TOC (last TOC page lists
 *    only 2 sections), a section that starts MID-PAGE after "END OF SECTION 260519", "RELATED REQUIREMENTS"
 *    lists that cite 3 other sections on a section's first page, and a body ref "See Section 26 05 19, Article 2.3".
 * Place at: src/services/ai/projectIndex/realPdf2.e2e.test.ts ; REPORT=1 prints the report.
 * Thresholds are report-first: they only hard-fail on "clearly broken" (<85%).
 */
import { perfBudget } from '@/test/perfBudget';
import '../agent/testGlobals';
import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees, type PDFFont, type PDFPage } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { indexPdfDocument } from './indexPages';
import { allIndexedPages, clearIndexMemory, dropIndexedDocument, projectIndexDb } from './store';
import { createProjectIndexTools } from './projectTools';
import { searchIndexedPages, buildSearchPassages } from './searchIndex';
import { formatToolResultForPrompt } from '../agent/safety';
import type { IndexedPageRecord, SearchHit } from './types';
import type { AssistantToolContext } from '../tools/types';

const REPORT = !!process.env.REPORT;
const log = (...a: unknown[]) => { if (REPORT) console.log('[R2]', ...a); };

// ---------------- drawing set ----------------
type Sheet = { num: string; title: string[]; rot?: boolean; body?: string[] };
const SHEETS: Sheet[] = [
  { num: 'E0.01', title: ['ELECTRICAL SYMBOLS AND ABBREVIATIONS'] },
  { num: 'E0.02', title: ['ELECTRICAL GENERAL NOTES'] },
  { num: 'E1.01', title: ['LIGHTING PLAN -', 'FIRST FLOOR'], body: ['PANEL LP-2', 'TYPE A'] },
  { num: 'E1.02', title: ['LIGHTING PLAN -', 'SECOND FLOOR'], body: ['TYPE B'] },
  { num: 'E2.01', title: ['POWER PLAN - FIRST FLOOR'], body: ['LP-2', 'E-501'] },
  { num: 'E2.02', title: ['POWER PLAN - SECOND FLOOR'], body: ['LP-20'] },
  { num: 'E-1.01', title: ['ENLARGED ELECTRICAL ROOM'], body: ['PANEL LP-2 AND LP-1'] },
  { num: 'E-1.02', title: ['ENLARGED KITCHEN POWER PLAN'], body: ['LP-20 CKT 3'] },
  { num: 'E-2.01', title: ['ROOF ELECTRICAL PLAN'] },
  { num: 'E-3.01', title: ['SITE LIGHTING PLAN'], body: ['TYPE A'] },
  { num: 'ES-101', title: ['ELECTRICAL SITE PLAN'] },
  { num: 'ES-102', title: ['ELECTRICAL SITE DETAILS'] },
  { num: 'E5.01', title: ['ELECTRICAL DETAILS'] },
  { num: 'E6.01', title: ['PANEL SCHEDULES'], body: ['PANEL LP-2 SCHEDULE', 'PANEL LP-1 SCHEDULE'] },
  { num: 'E6.02', title: ['LUMINAIRE SCHEDULE'], body: ['TYPE A 2X4 LED TROFFER', 'TYPE B 6IN LED DOWNLIGHT', 'TYPE C LED STRIP'] },
  { num: 'E7.01', title: ['ONE-LINE DIAGRAM'] },
  { num: 'E7.02', title: ['RISER DIAGRAMS'] },
  { num: 'FA1.01', title: ['FIRE ALARM PLAN -', 'FIRST FLOOR'] },
  { num: 'FA1.02', title: ['FIRE ALARM PLAN -', 'SECOND FLOOR'] },
  { num: 'T1.01', title: ['TECHNOLOGY PLAN'] },
  { num: 'E8.01', title: ['LIGHTING CONTROL DIAGRAMS'], rot: true },
  { num: 'E8.02', title: ['LIGHTING CONTROL DETAILS'], rot: true },
  { num: 'E-9.01', title: ['ELECTRICAL SPECIFICATIONS SHEET'], rot: true },
  { num: 'E-100', title: ['LEGACY PLAN SHEET'] },
];

function txt(p: PDFPage, s: string, x: number, y: number, size: number, f: PDFFont, rot = 0) {
  p.drawText(s, { x, y, size, font: f, rotate: degrees(rot) });
}

async function buildDrawingSet(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 42 * 72; const H = 30 * 72; // 3024 x 2160 landscape, PDF y is bottom-up
  const SX = W - 270; // right-edge vertical strip, 270pt wide
  for (const s of SHEETS) {
    const p = doc.addPage([W, H]);
    // plan body
    txt(p, 'KEYED NOTES:', 150, H - 150, 14, bold);
    txt(p, '1. PROVIDE DEVICES PER SECTION 26 27 26. CIRCUIT TO NEAREST PANEL UNLESS NOTED.', 150, H - 175, 10, font);
    (s.body || []).forEach((b, k) => txt(p, b, 900 + k * 260, 1000 - k * 40, 11, bold));
    txt(p, 'SCALE: 1/8" = 1\'-0"', 150, 120, 10, font);
    // vertical strip border
    p.drawRectangle({ x: SX, y: 20, width: 250, height: H - 40, borderWidth: 2 });
    if (s.rot) {
      // whole strip text rotated 90deg (reads bottom-to-top)
      txt(p, 'BRIGHTLINE ENGINEERING GROUP', SX + 60, 200, 14, bold, 90);
      txt(p, s.title.join(' '), SX + 120, 200, 16, bold, 90);
      txt(p, 'DWG NO.', SX + 170, 200, 8, font, 90);
      txt(p, s.num, SX + 220, 200, 30, bold, 90);
      continue;
    }
    // top of strip: firm + seal + revisions (outside the 0.45H title window)
    txt(p, 'BRIGHTLINE', SX + 20, H - 80, 22, bold);
    txt(p, 'ENGINEERING GROUP', SX + 20, H - 105, 12, font);
    txt(p, 'REVISIONS', SX + 20, H - 300, 9, bold);
    txt(p, '1  ADDENDUM 1  09/15/26', SX + 20, H - 320, 8, font);
    // middle: project info (labels + values)
    txt(p, 'PROJECT:', SX + 20, 900, 8, font);
    txt(p, 'RIVERSIDE ELEMENTARY RENOVATION', SX + 20, 880, 10, font);
    txt(p, 'JOB NO. 25-0412', SX + 20, 860, 8, font);
    txt(p, 'DRAWN BY: KLM   CHECKED BY: RJT', SX + 20, 840, 8, font);
    txt(p, 'ISSUE DATE: 10/01/2026', SX + 20, 820, 8, font);
    // title ABOVE the "DWG NO." label, number below it
    const ty = 600;
    s.title.forEach((line, k) => txt(p, line, SX + 20, ty - k * 20, 14, bold));
    txt(p, 'DWG NO.', SX + 20, 420, 8, font);
    txt(p, s.num, SX + 20, 360, 32, bold);
  }
  return doc.save();
}

// ---------------- project manual ----------------
type Sec = { num: string; packed: string; title: string; footerOnly?: boolean };
const SEC: Record<string, Sec> = {
  s011000: { num: '01 10 00', packed: '011000', title: 'SUMMARY', footerOnly: true },
  s012500: { num: '01 25 00', packed: '012500', title: 'SUBSTITUTION PROCEDURES', footerOnly: true },
  s260519: { num: '26 05 19', packed: '260519', title: 'LOW-VOLTAGE ELECTRICAL POWER CONDUCTORS AND CABLES' },
  s262726: { num: '26 27 26', packed: '262726', title: 'WIRING DEVICES' },
  s262813: { num: '26 28 13', packed: '262813', title: 'FUSES' },
  s265119: { num: '26 51 19', packed: '265119', title: 'LED INTERIOR LIGHTING' },
};
// page -> expected section (undefined = not a spec section page); page 14 is shared (mid-page start)
const PLAN: Array<{ page: number; sec?: Sec; local?: number; kind: 'cover' | 'toc' | 'body' }> = [];
{
  PLAN.push({ page: 1, kind: 'cover' });
  for (let p = 2; p <= 5; p++) PLAN.push({ page: p, kind: 'toc' });
  const runs: Array<[Sec, number, number]> = [
    [SEC.s011000, 6, 8], [SEC.s012500, 9, 10], [SEC.s260519, 11, 14], [SEC.s262726, 15, 20],
    [SEC.s262813, 21, 23], [SEC.s265119, 24, 30],
  ];
  for (const [sec, a, b] of runs) for (let p = a; p <= b; p++) PLAN.push({ page: p, sec, local: p - a + 1, kind: 'body' });
}
const MIDPAGE = 14; // END OF SECTION 260519 then SECTION 262726 begins mid-page

async function buildManual(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const W = 612; const H = 792;
  for (const row of PLAN) {
    const p = doc.addPage([W, H]);
    let y = H - 110;
    const t = (s: string, x = 72, f = font, size = 10) => { p.drawText(s, { x, y, size, font: f }); y -= 14; };
    if (row.kind === 'cover') {
      y = 520; t('RIVERSIDE ELEMENTARY RENOVATION', 140, bold, 18); t('PROJECT MANUAL - VOLUME 2', 180, bold, 14); t('ISSUED FOR BID 10/01/2026', 200); continue;
    }
    if (row.kind === 'toc') {
      p.drawText('TABLE OF CONTENTS', { x: 230, y: H - 60, size: 12, font: bold });
      const all = ['00 01 10 TABLE OF CONTENTS', '01 10 00 SUMMARY', '01 25 00 SUBSTITUTION PROCEDURES', '01 26 00 CONTRACT MODIFICATION PROCEDURES',
        '01 29 00 PAYMENT PROCEDURES', '01 31 00 PROJECT MANAGEMENT AND COORDINATION', '01 33 00 SUBMITTAL PROCEDURES', '01 40 00 QUALITY REQUIREMENTS',
        '01 50 00 TEMPORARY FACILITIES AND CONTROLS', '01 60 00 PRODUCT REQUIREMENTS', '01 73 00 EXECUTION', '01 77 00 CLOSEOUT PROCEDURES',
        '26 05 00 COMMON WORK RESULTS FOR ELECTRICAL', '26 05 19 LOW-VOLTAGE ELECTRICAL POWER CONDUCTORS AND CABLES', '26 05 26 GROUNDING AND BONDING',
        '26 05 33 RACEWAYS AND BOXES', '26 24 16 PANELBOARDS', '26 27 26 WIRING DEVICES', '26 28 13 FUSES', '26 51 19 LED INTERIOR LIGHTING',
        '27 10 00 STRUCTURED CABLING', '28 31 11 DIGITAL ADDRESSABLE FIRE ALARM'];
      const per = 6; const start = (row.page - 2) * per;
      const slice = row.page === 5 ? all.slice(20, 22) : all.slice(start, start + per);
      t(row.page === 2 ? 'DIVISION 01 - GENERAL REQUIREMENTS' : row.page === 4 ? 'DIVISION 26 - ELECTRICAL' : 'DIVISIONS (CONTINUED)', 72, bold);
      for (const e of slice) t(`${e}  ........  ${e.slice(0, 2)}`);
      p.drawText(`TABLE OF CONTENTS 00 01 10 - ${row.page - 1}`, { x: 220, y: 40, size: 9, font });
      continue;
    }
    const sec = row.sec!; const local = row.local!;
    // running header (top band): "SECTION 262726" no spaces; Division 01 uses footer-only
    if (!sec.footerOnly) p.drawText(`SECTION ${sec.packed}`, { x: 480, y: H - 50, size: 9, font });
    p.drawText('RIVERSIDE ELEMENTARY RENOVATION', { x: 72, y: H - 50, size: 9, font });
    if (local === 1) {
      if (sec.footerOnly) { y = H - 80; t(`SECTION ${sec.num}`, 250, bold, 12); t(sec.title, 250, bold, 12); y -= 10; }
      t('PART 1 - GENERAL', 72, bold);
      t('1.1 RELATED DOCUMENTS');
      t('A. Drawings and general provisions of the Contract apply to this Section.');
      if (sec === SEC.s262813) {
        t('1.2 RELATED REQUIREMENTS');
        t('A. Section 26 05 19 "Low-Voltage Electrical Power Conductors and Cables."');
        t('B. Section 26 05 26 "Grounding and Bonding for Electrical Systems."');
        t('C. Section 26 27 26 "Wiring Devices" for fused plugs.');
      }
      if (sec === SEC.s011000) { t('1.2 PROJECT INFORMATION'); t('A. Project Location: 400 River Road.'); }
      for (let k = 0; k < 25; k++) t(`${String.fromCharCode(66 + (k % 20))}. ${sec.title.toLowerCase()} general requirement ${k + 1}.`);
    } else if (sec === SEC.s262726 && local === 2) {
      t('2.2 RECEPTACLES');
      t('A. Duplex receptacles: NEMA 5-20R, 20 A, 125 V, heavy-duty specification grade, UL 498.');
      for (let k = 0; k < 30; k++) t(`B.${k + 1} Receptacle requirement ${k + 1}; mount 18 inches AFF unless noted.`);
    } else if (sec === SEC.s262726 && local === 3) {
      t('C. Weather-resistant receptacles at exterior locations (continued from 2.2 RECEPTACLES).');
      t('D. See Section 26 05 19, Article 2.3 for branch circuit conductor sizing.');
      t('2.3 SWITCHES');
      t('A. Single-pole switches: 20 A, 120/277 V, UL 20.');
      t('2.4 WALL PLATES');
      t('A. Smooth nylon, color to match device.');
    } else if (sec === SEC.s260519 && local === 3) {
      t('PART 2 - PRODUCTS');
      t('2.3 CONDUCTOR SIZING');
      t('A. Minimum branch circuit conductor size: No. 12 AWG copper.');
    } else if (row.page === MIDPAGE) {
      t('3.3 FIELD QUALITY CONTROL');
      t('A. Perform insulation-resistance tests on each conductor.');
      y -= 20; t(`END OF SECTION ${SEC.s260519.packed}`, 240, bold);
      y -= 30;
      t(`SECTION ${SEC.s262726.packed} - ${SEC.s262726.title}`, 200, bold, 12);
      t('PART 1 - GENERAL', 72, bold);
      t('1.1 SUMMARY');
      t('A. WIRING DEVICES SCOPE MARKER: receptacles, switches, wall plates, floor boxes.');
      t('1.2 RELATED REQUIREMENTS');
      t('A. Section 26 05 33 "Raceways and Boxes for Electrical Systems."');
      t('PART 2 - PRODUCTS');
      t('2.1 MANUFACTURERS');
      t('A. Hubbell; Leviton; Pass & Seymour.');
    } else {
      for (let k = 0; k < 38; k++) t(`${String.fromCharCode(65 + (k % 8))}. ${sec.title.toLowerCase()} text line ${k} on page ${local}.`);
    }
    const isEnd = PLAN.find(r => r.page === row.page + 1)?.sec !== sec && row.page !== MIDPAGE;
    if (isEnd) t(`END OF SECTION ${sec.packed}`, 240, bold);
    // footer: title first, then number - page (single text run)
    const footLocal = sec === SEC.s262726 ? local + 1 : local; // 262726 page 1 is on p14
    p.drawText(`${sec.title} ${sec.num} - ${footLocal}`, { x: 200, y: 40, size: 9, font });
  }
  return doc.save();
}

async function loadPdf(bytes: Uint8Array) {
  return (pdfjs as { getDocument: (opts: unknown) => { promise: Promise<{ fingerprints?: string[]; numPages: number; getPage: (n: number) => Promise<unknown> }> } })
    .getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false, disableFontFace: true }).promise;
}

const ctx = { extractPageText: async () => ({ text: '' }) } as unknown as AssistantToolContext;
const tool = (id: string) => createProjectIndexTools().find(t => t.id === id)!;
async function run(id: string, input: Record<string, unknown>) {
  const def = tool(id);
  const parsed = def.schema.parse(input);
  const result = await def.execute(ctx, parsed as never);
  return { raw: result as { output: Record<string, unknown>; citations?: unknown[] }, prompt: formatToolResultForPrompt(result as never) };
}

let dwg: IndexedPageRecord[] = [];
let man: IndexedPageRecord[] = [];
let dwgPdf: Awaited<ReturnType<typeof loadPdf>>;
let manPdf: Awaited<ReturnType<typeof loadPdf>>;
let maxBlockMs = 0;
const metrics: Record<string, unknown> = {};

describe('ROUND 2: unseen real-PDF conventions', () => {
  beforeAll(async () => {
    clearIndexMemory();
    await projectIndexDb.pages.clear();
    dwgPdf = await loadPdf(await buildDrawingSet());
    manPdf = await loadPdf(await buildManual());
    let last = performance.now(); let running = true;
    const probe = () => { const now = performance.now(); maxBlockMs = Math.max(maxBlockMs, now - last); last = now; if (running) setTimeout(probe, 0); };
    setTimeout(probe, 0);
    let t0 = performance.now();
    dwg = await indexPdfDocument({ docId: 'dwg', documentName: 'Riverside-E.pdf', pdfDoc: dwgPdf as never, yieldEveryPage: true });
    metrics.indexDwgMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    man = await indexPdfDocument({ docId: 'man', documentName: 'Riverside-Specs.pdf', pdfDoc: manPdf as never, yieldEveryPage: true });
    metrics.indexManMs = Math.round(performance.now() - t0);
    running = false;
    metrics.maxBlockMs = Math.round(maxBlockMs);
    log('index', metrics);
  }, 120_000);

  it('sheet numbers + titles (vertical strip, DWG NO., E1.01 / E-1.01 / ES-101)', () => {
    const rows = SHEETS.map((s, i) => ({ exp: s.num, got: dwg[i]?.sheetNumber ?? '', expT: s.title.join(' '), gotT: dwg[i]?.sheetTitle ?? '', rot: !!s.rot, kind: dwg[i]?.kind }));
    const flat = rows.filter(r => !r.rot);
    const numOk = flat.filter(r => r.got === r.exp).length;
    const titleOk = flat.filter(r => r.gotT === r.expT).length;
    const rotNum = rows.filter(r => r.rot && r.got === r.exp).length;
    const rotTitle = rows.filter(r => r.rot && r.gotT === r.expT).length;
    Object.assign(metrics, { sheetNum: `${numOk}/${flat.length}`, sheetTitle: `${titleOk}/${flat.length}`, rotNum: `${rotNum}/3`, rotTitle: `${rotTitle}/3` });
    log(`sheet numbers ${numOk}/${flat.length}, titles ${titleOk}/${flat.length}, rotated-strip num ${rotNum}/3 title ${rotTitle}/3`);
    log(rows.map(r => `${r.exp.padEnd(7)} -> ${r.got.padEnd(7)} | ${r.gotT} ${r.gotT === r.expT ? '' : `  (want "${r.expT}")`} ${r.kind}`).join('\n'));
    expect(numOk / flat.length).toBeGreaterThanOrEqual(0.85);
    expect(titleOk / flat.length).toBeGreaterThanOrEqual(0.85);
  });

  it('spec page accuracy (packed header, title-first footer, footer-only Div 01, 4-page TOC, mid-page start)', async () => {
    const wrong: string[] = [];
    let total = 0;
    for (const r of PLAN) {
      if (r.page === MIDPAGE) continue;
      total++;
      const got = man[r.page - 1];
      const ok = r.kind === 'body' ? got.kind === 'spec' && got.specSection === r.sec!.num
        : r.kind === 'toc' ? (got.kind !== 'spec' || got.specSection === '00 01 10') : got.kind !== 'spec';
      if (!ok) wrong.push(`p${r.page}(${r.kind}${r.sec ? ' ' + r.sec.num : ''}) got ${got.kind}:${got.specSection ?? '-'}`);
    }
    const mid = man[MIDPAGE - 1];
    metrics.specPages = `${total - wrong.length}/${total}`;
    metrics.midpage = `${mid.kind}:${mid.specSection}`;
    log(`spec pages correct ${total - wrong.length}/${total}; wrong: ${wrong.join('; ')}`);
    log(`mid-page start p14 classified ${mid.kind}:${mid.specSection}`);
    const idx = await run('get_spec_index', {});
    log('get_spec_index', JSON.stringify(idx.raw.output.sections));
    // 26 27 26 must include its PART 1 text that starts mid-page on p14
    const rs = await run('read_spec_section', { section: '26 27 26' });
    const txt = String((rs.raw.output as { text: string }).text);
    metrics.midpageScopeInSection = txt.includes('WIRING DEVICES SCOPE MARKER');
    metrics.midpageLeak260519 = txt.includes('insulation-resistance');
    log('read_spec_section 26 27 26 contains mid-page PART 1 start:', metrics.midpageScopeInSection, '| leaks 26 05 19 text:', metrics.midpageLeak260519);
    const s28 = await run('read_spec_section', { section: '26 28 13' });
    metrics.fusesFirstPage = String((s28.raw.output as { text: string }).text).includes('1.2 RELATED REQUIREMENTS');
    log('26 28 13 first page (cites 3 sections in 1.2) included in section:', metrics.fusesFirstPage);
    const art = await run('read_spec_section', { section: '26 27 26', part: 2, article: '2.2' });
    const at = String((art.raw.output as { text: string }).text);
    metrics.article22 = at.includes('Duplex receptacles') && at.includes('Weather-resistant') && !at.includes('2.3 SWITCHES');
    log('article 2.2 complete across page break & stops before 2.3:', metrics.article22, at.length, 'chars');
    expect((total - wrong.length) / total).toBeGreaterThanOrEqual(0.85);
  });

  it('body cross-ref "See Section 26 05 19, Article 2.3" does not reassign the page', () => {
    const p = man.find(r => (r.text || r.lines.map(l => l.text).join('\n')).includes('See Section 26 05 19, Article 2.3'))!;
    log('cross-ref page', p.page, p.kind, p.specSection);
    expect(p.specSection).toBe('26 27 26');
  });

  it('search correctness: panel LP-2, exact codes, Type A, 2.2', async () => {
    const hits = (q: string, extra: Record<string, unknown> = {}) => searchIndexedPages(allIndexedPages(), { query: q, limit: 40, ...extra } as never) as SearchHit[];
    const pageText = (h: SearchHit) => {
      const src = h.documentId === 'dwg' ? dwg : man;
      const r = src[h.page - 1];
      return (r.text || r.lines.map(l => l.text).join('\n'));
    };
    // panel LP-2: pages with exact token LP-2 must rank above those without (LP-20 is NOT LP-2)
    const lp = hits('panel LP-2', { kind: 'drawing' });
    const exact = (h: SearchHit) => /(^|[^A-Z0-9-])LP-2(?![0-9A-Z])/.test(pageText(h));
    const firstNon = lp.findIndex(h => !exact(h));
    const lastExact = lp.map(exact).lastIndexOf(true);
    const lpExpected = dwg.filter(r => /(^|[^A-Z0-9-])LP-2(?![0-9A-Z])/.test(r.text || '')).length;
    metrics.lp2 = { hits: lp.length, exactPages: lpExpected, exactFound: lp.filter(exact).length, exactAllAboveNon: firstNon === -1 || lastExact < firstNon, top: lp.slice(0, 8).map(h => `${h.sheetNumber}:${h.score}${exact(h) ? '' : '(no LP-2)'}`) };
    log('panel LP-2', metrics.lp2);
    // exact code hits
    const codeTop = (q: string, want: (h: SearchHit) => boolean, extra: Record<string, unknown> = {}) => {
      const r = hits(q, extra);
      return { q, n: r.length, top1ok: !!r[0] && want(r[0]), top: r.slice(0, 3).map(h => `${h.documentId}p${h.page}/${h.sheetNumber ?? h.specSection}:${h.score}`) };
    };
    const codes = [
      codeTop('E-100', h => h.sheetNumber === 'E-100'),
      codeTop('E1.01', h => h.sheetNumber === 'E1.01'),
      codeTop('E-1.01', h => h.sheetNumber === 'E-1.01'),
      codeTop('ES-101', h => h.sheetNumber === 'ES-101'),
      codeTop('26 27 26', h => h.specSection === '26 27 26', { kind: 'spec' }),
      codeTop('262726', h => h.specSection === '26 27 26', { kind: 'spec' }),
      codeTop('Type A', h => /TYPE A\b/.test(pageText(h)), { kind: 'drawing' }),
      codeTop('2.2', h => /2\.2 RECEPTACLES/.test(pageText(h)), { kind: 'spec' }),
      codeTop('article 2.3', h => /2\.3 /.test(pageText(h)), { kind: 'spec' }),
    ];
    metrics.codes = codes;
    log('code queries', JSON.stringify(codes, null, 1));
    const typeA = hits('Type A', { kind: 'drawing' });
    const typeAOnly = typeA.filter(h => /TYPE A\b/.test(pageText(h))).length;
    log(`Type A: ${typeA.length} hits, ${typeAOnly} actually contain TYPE A; top3 ${typeA.slice(0, 3).map(h => h.sheetNumber + ':' + h.score)}`);
    expect(lp.filter(exact).length).toBe(lpExpected);
    expect(codes.find(c => c.q === 'E-100')!.top1ok).toBe(true);
    expect(codes.find(c => c.q === '26 27 26')!.top1ok).toBe(true);
  });

  it('dense-drawing search latency with REAL passages (the committed benchmark reuses 29 small passage arrays)', () => {
    const denseLines = (i: number) => Array.from({ length: 400 }, (_, k) => ({ text: `LP-${(i + k) % 9}-${k} 20A 1P ${k % 7 ? 'RECEPT' : 'LIGHTING'} ROOM ${100 + k}`, bbox: { x: k, y: k, width: 50, height: 10 } }));
    const dense: IndexedPageRecord[] = Array.from({ length: 3000 }, (_, i) => {
      const lines = denseLines(i);
      return { ...dwg[i % dwg.length], docId: 'dense', page: i + 1, lines, text: lines.map(l => l.text).join('\n'), passages: buildSearchPassages(lines) };
    });
    const t1 = performance.now();
    const r1 = searchIndexedPages(dense, { query: 'panel LP-2', limit: 10 });
    const ms1 = performance.now() - t1;
    const t2 = performance.now();
    searchIndexedPages(dense, { query: 'duplex receptacles specification grade', limit: 10 });
    const ms2 = performance.now() - t2;
    metrics.denseRealPassagesMs = { lp2: Math.round(ms1), words: Math.round(ms2), hits: r1.length };
    log('3000 dense pages WITH real passages:', metrics.denseRealPassagesMs);
    expect(r1.length).toBeGreaterThan(0);
    expect(ms1).toBeLessThan(perfBudget(150));
    expect(ms2).toBeLessThan(perfBudget(150));
  }, 60_000);

  it('B3 rebind: same file reopened as a new docId; closed id never served', async () => {
    const again = await indexPdfDocument({ docId: 'man-reopened', documentName: 'Riverside-Specs.pdf', pdfDoc: manPdf as never });
    dropIndexedDocument('man');
    const ids = new Set(allIndexedPages().map(p => p.docId));
    const s = await run('search_project', { query: 'duplex receptacles', kind: 'spec' });
    const res = (s.raw.output as { results: SearchHit[] }).results;
    metrics.rebind = { returned: again.length, allBound: again.every(p => p.docId === 'man-reopened'), idsServed: [...ids], hitDocIds: [...new Set(res.map(h => h.documentId))], citations: s.raw.citations?.length };
    log('rebind', metrics.rebind);
    expect(again.every(p => p.docId === 'man-reopened')).toBe(true);
    expect(ids.has('man')).toBe(false);
    expect(res.every(h => h.documentId === 'man-reopened')).toBe(true);
  });

  it('B4 cursor walks the whole 26 27 26 section through the model-visible prompt', async () => {
    let cursor: string | undefined; let joined = ''; let truncated = false; let loops = 0;
    do {
      const r = await run('read_spec_section', { section: '26 27 26', ...(cursor ? { cursor } : {}) });
      const out = r.raw.output as { text: string; nextCursor?: string };
      if (/…\[truncated\]/.test(r.prompt)) truncated = true;
      joined += out.text; cursor = out.nextCursor; loops++;
    } while (cursor && loops < 50);
    const whole = man.filter(p => p.kind === 'spec' && p.specSection === '26 27 26').map(p => p.text).join('\n\n');
    metrics.cursor = { chunks: loops, joined: joined.length, whole: whole.length, truncated, equal: joined === whole };
    log('cursor', metrics.cursor);
    expect(truncated).toBe(false);
    expect(joined).toBe(whole);
  });

  it('summary', () => { log('METRICS', JSON.stringify(metrics, null, 1)); });
});
