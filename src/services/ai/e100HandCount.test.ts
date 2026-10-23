import './agent/testGlobals';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const state: { fail: Set<string>; delays: Record<string, number>; tileItems: Record<string, unknown[]>; overviewItems: unknown[]; text: unknown[] } = {
  fail: new Set(), delays: {}, tileItems: {}, overviewItems: [], text: [],
};

vi.mock('./aiService', () => ({
  getAIService: () => ({
    analyzeBlueprint: async (img: string) => {
      const id = img === 'overview' ? undefined : img;
      if (id) {
        await new Promise(r => setTimeout(r, state.delays[id] ?? 0));
        if (state.fail.has(id)) throw new Error(`boom ${id}`);
      }
      const items = id ? (state.tileItems[id] || []) : state.overviewItems;
      return { content: JSON.stringify({ items, dimensions: [], text: [], symbols: [] }) };
    },
    complete: async () => ({ content: '{"questions":[],"evidence":[]}' }),
  }),
}));
vi.mock('./imageCapture', async (orig) => {
  const actual = await orig<typeof import('./imageCapture')>();
  return {
    ...actual,
    capturePageVisionBundle: async (_d: unknown, _p: number, w: number, h: number) => {
      const regions = actual.generateOverlappingTileRegions(w, h, 2, 2);
      return { overview: { base64: 'overview' }, tiles: regions.map(region => ({ region, base64: region.id })) };
    },
  };
});

vi.mock('@/lib/ocrEngine', () => ({ isScannedDocument: () => false, performOcr: async () => ({ words: [], text: '', confidence: 0 }) }));
import { analyzePageMaximumAccuracy } from './pipeline';
import { generateOverlappingTileRegions } from "./imageCapture";
import { countItemsFromAnalysis } from './agent/pageAnalysisCache';
import type { TextItemWithBounds } from '@/lib/pdfLoader';
import { parseLegendFromPageItems } from './detection/legendAwareCounting';

import { parseLegendFromTextLines } from './detection/legendAwareCounting';
import { typeKeyMatchesQuery, parseMatchedLegendCodes } from './agent/pageAnalysisCache';

const log = (...a: unknown[]) => console.log('[GT]', ...a);
const W = 36 * 72; const H = 24 * 72;
const HAND: Record<string, number> = { A: 10, B: 5, B1: 4, 'A/EM/NL': 1, 'B-NL': 1, EX1: 4, ER1: 2 };
const ROWS: Array<[string, string]> = [
  ['A', '2X4 RECESSED LED TROFFER'],
  ['A/EM/NL', '2X4 RECESSED LED TROFFER WITH EMERGENCY BATTERY AND NIGHT LIGHT'],
  ['B', '6IN RECESSED LED DOWNLIGHT'],
  ['B-NL', '6IN RECESSED LED DOWNLIGHT NIGHT LIGHT CIRCUIT'],
  ['B1', '4IN RECESSED LED DOWNLIGHT'],
  ['EX1', 'LED EXIT SIGN WITH BATTERY'],
  ['ER1', 'EMERGENCY REMOTE HEAD'],
];
const w = (str: string, x: number, y: number): TextItemWithBounds => ({ str, x, y, width: str.length * 5, height: 7 });
function legend(wordLevel: boolean, order = ROWS, lx = 40, header = 'CODE'): TextItemWithBounds[] {
  const items = [w('LIGHTING', lx, 100), w('FIXTURE', lx + 45, 100), w('SCHEDULE', lx + 85, 100), w(header, lx + 8, 112), w('DESCRIPTION', lx + 80, 112)];
  order.forEach(([c, d], i) => {
    const y = 124 + i * 12;
    items.push(w(c, lx + 8, y));
    if (wordLevel) { let x = lx + 80; for (const t of d.split(' ')) { items.push(w(t, x, y)); x += t.length * 5 + 4; } }
    else items.push(w(d, lx + 80, y));
  });
  // plan text far away on same rows
  order.forEach((_, i) => items.push(w(`RM${101 + i}`, 1400, 124 + i * 12), w('OFFICE', 1440, 124 + i * 12)));
  return items;
}
const regions = generateOverlappingTileRegions(W, H, 2, 2);
const local = (id: string, px: number, py: number) => { const r = regions.find(x => x.id === id)!; return { x: ((px - r.x) / r.width) * 100, y: ((py - r.y) / r.height) * 100 }; };
const owner = (px: number, py: number) => regions.find(r => px >= r.ownership.x && px < r.ownership.x + r.ownership.width && py >= r.ownership.y && py < r.ownership.y + r.ownership.height)!;
const det = (id: string, code: string, loc: { x: number; y: number }) => ({ id, type: code, name: `Type ${code}`, confidence: 0.9, legendTypeCode: code, matchConfidence: 'high', location: loc });
const run = () => analyzePageMaximumAccuracy({ pdfDoc: {} as never, page: 1, pageWidth: W, pageHeight: H, trade: 'electrical', getCachedText: () => state.text as TextItemWithBounds[] });
beforeEach(() => { state.fail = new Set(); state.delays = {}; state.tileItems = {}; state.overviewItems = []; state.text = []; });

describe('GT E-100 legend parse', () => {
  for (const wl of [false, true]) for (const [oname, order] of [['schedule order', ROWS], ['reversed', [...ROWS].reverse()]] as const) for (const hdr of ['CODE', 'TYPE', 'MARK']) {
    it(`7 rows parsed, wordLevel=${wl} ${oname} header=${hdr}`, () => {
      const e = parseLegendFromPageItems(legend(wl, order as never, 40, hdr));
      const got = Object.fromEntries(e.map(x => [x.typeCode, x.description]));
      log(`parse wl=${wl} ${oname} ${hdr}`, JSON.stringify(got));
      for (const [c, d] of ROWS) { expect(got[c], c).toBeTruthy(); expect(d.startsWith(got[c]), `${c} desc prefix`).toBe(true); }
      expect(Object.keys(got).sort()).toEqual(ROWS.map(r => r[0]).sort());
    });
  }
  it('plain lines', () => {
    const e = parseLegendFromTextLines(['LIGHTING FIXTURE SCHEDULE', 'CODE  DESCRIPTION', ...ROWS.map(([c, d]) => `${c}  ${d}`)]);
    const got = Object.fromEntries(e.map(x => [x.typeCode, x.description]));
    log('lines', JSON.stringify(got));
    for (const [c, d] of ROWS) expect(got[c], c).toBe(d);
  });
});

describe('GT E-100 chain', () => {
  for (const wl of [false, true]) it(`hand count through analyzePageMaximumAccuracy wordLevel=${wl}`, async () => {
    state.text = legend(wl, ROWS, 2000);
    let k = 0;
    const add = (tile: string, code: string, px: number, py: number) => { (state.tileItems[tile] ||= []).push(det(`${tile}-${code}-${k++}`, code, local(tile, px, py))); };
    const seamX = regions[0].ownership.x + regions[0].ownership.width;
    const seamY = regions[0].ownership.y + regions[0].ownership.height;
    let n = 0;
    for (const [code, cnt] of Object.entries(HAND)) for (let i = 0; i < cnt - (['A','B1','EX1','A/EM/NL'].includes(code) ? 1 : 0); i += 1) {
      const px = 200 + ((n * 173) % 2100); const py = 300 + ((n * 97) % 1200); n += 1;
      const o = owner(px, py); add(o.id, code, px, py);
    }
    // seam duplicates: fixtures sitting on seams, each reported by both adjacent tiles (counted once)
    const seamFx: Array<[string, number, number]> = [['A', seamX - 4, 500], ['B1', seamX + 5, 1300], ['EX1', 900, seamY - 3], ['A/EM/NL', 1800, seamY + 4]];
    for (const [code, px, py] of seamFx) {
      HAND[code] += 0; // placeholder
      for (const r of regions) if (px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height) add(r.id, code, px + (r === owner(px, py) ? 0 : 3), py + (r === owner(px, py) ? 0 : -2));
    }
    const expected = { ...HAND };
    const res = await run();
    const a = res.analysis;
    const unresolved = countItemsFromAnalysis(a, "").unresolvedItems ?? [];
    log(`chain wl=${wl} legendTypeCodes`, JSON.stringify(a.legendTypeCodes), 'counts', JSON.stringify(a.legendTypeCounts), 'reliability', a.countReliability, 'unresolvedish', unresolved.length, 'items', a.items.length);
    expect(a.legendTypeCounts).toEqual(expected);
    expect(unresolved.length).toBe(0);
    const q = (s: string) => { const r = countItemsFromAnalysis(a, s); log(`query "${s}" ->`, r.total, JSON.stringify((r as { matchedCodes?: string[] }).matchedCodes), 'unres', r.unresolvedItems?.length ?? 0); return r.total; };
    expect(q('Type B')).toBe(expected.B);
    expect(q('Type B1')).toBe(expected.B1);
    expect(q('B-NL')).toBe(expected['B-NL']);
    expect(q('A/EM/NL')).toBe(expected['A/EM/NL']);
    expect(q('Type A')).toBe(expected.A);
    q('how many B-NL fixtures'); q('count Type A/EM/NL'); q('type b-nl');
  });
});

describe('GT whole-token query matching', () => {
  it('codes', () => {
    const known = ROWS.map(r => r[0]);
    const m = (q: string) => parseMatchedLegendCodes(q, known);
    log('matched', JSON.stringify({ A: m('Type A'), B: m('Type B'), B1: m('Type B1'), BNL: m('B-NL'), AEM: m('A/EM/NL'), typeBNL: m('Type B-NL') }));
    expect(m('Type A')).toEqual(['A']); expect(m('Type B')).toEqual(['B']); expect(m('Type B1')).toEqual(['B1']);
    expect(m('B-NL')).toEqual(['B-NL']); expect(m('A/EM/NL')).toEqual(['A/EM/NL']); expect(m('Type B-NL')).toEqual(['B-NL']);
    expect(typeKeyMatchesQuery('A/EM/NL', 'Type A', known)).toBe(false);
    expect(typeKeyMatchesQuery('B1', 'Type B', known)).toBe(false);
    expect(typeKeyMatchesQuery('B-NL', 'Type B', known)).toBe(false);
    expect(typeKeyMatchesQuery('A/EM/NL', 'A/EM/NL', known)).toBe(true);
    expect(typeKeyMatchesQuery('B-NL', 'B-NL', known)).toBe(true);
  });
});
describe('GT dbg', () => { it('bnl item', async () => {
  state.text = legend(false, ROWS, 2000);
  const r = regions[0]; state.tileItems[r.id] = [det('bnl', 'B-NL', local(r.id, 300, 300)), det('b', 'B', local(r.id, 500, 300))];
  const res = await run();
  log('dbg items', JSON.stringify(res.analysis.items.map(i => ({ id: i.id, t: i.type, c: i.legendTypeCode, m: (i as never as { matchConfidence?: string }).matchConfidence, conf: i.confidence }))), JSON.stringify(res.analysis.legendTypeCounts));
  const q = countItemsFromAnalysis(res.analysis, 'B-NL'); log('dbg q B-NL', q.total, JSON.stringify(q.unresolvedItems), JSON.stringify((q as never as {notes?: unknown}).notes ?? null));
}); });
