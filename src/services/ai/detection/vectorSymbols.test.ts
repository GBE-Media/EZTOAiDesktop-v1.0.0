import { describe, expect, it } from 'vitest';
import type { DetectedItem } from '../providers/types';
import { buildSymbolComponents, refineDetectionsWithSymbols } from './vectorSymbols';

const W = 2000;
const H = 1000;

/** A 2×4 troffer: 36×18 pt box with an X. */
function troffer(cx: number, cy: number): number[] {
  const x0 = cx - 18; const y0 = cy - 9; const x1 = cx + 18; const y1 = cy + 9;
  return [x0, y0, x1, y0, x1, y0, x1, y1, x1, y1, x0, y1, x0, y1, x0, y0, x0, y0, x1, y1, x1, y0, x0, y1];
}
/** A door: leaf + swing chord. */
function door(x: number, y: number): number[] {
  return [x, y, x + 30, y, x, y, x, y - 30, x + 30, y, x, y - 30];
}

const item = (id: string, x: number, y: number, code = 'A'): DetectedItem => ({
  id, type: code, trade: 'electrical', name: `Type ${code}`, quantity: 1,
  location: { x: (x / W) * 100, y: (y / H) * 100 }, confidence: 0.9, legendTypeCode: code, matchConfidence: 'high',
} as DetectedItem);

const fixtures = [[200, 200], [400, 200], [600, 200], [800, 200], [1000, 200], [1200, 200]];

describe('drawn-symbol check for counts', () => {
  const segments = [
    ...fixtures.flatMap(([x, y]) => troffer(x, y)),
    ...door(420, 240),
    100, 500, 1900, 500, // a wall: too long to be a symbol stroke
  ];
  const components = buildSymbolComponents(segments);

  it('finds each fixture block as one symbol and ignores walls', () => {
    const boxes = components.filter(c => Math.round(c.w) === 36 && Math.round(c.h) === 18);
    expect(boxes).toHaveLength(6);
    expect(new Set(boxes.map(c => c.sig)).size).toBe(1);
    expect(components.some(c => c.w > 100)).toBe(false);
  });

  it('centres markers on the symbol, drops a duplicate and adds a missed identical symbol', () => {
    const items = [
      item('a1', 207, 204), // 8 pt off
      item('a2', 395, 196),
      item('a2dup', 402, 203), // the same fixture seen twice
      item('a3', 604, 201),
      item('a4', 810, 206),
      item('a5', 1000, 200),
      // 1200,200 missed by vision
    ];
    const out = refineDetectionsWithSymbols(items, components, W, H);
    expect(out.duplicates).toBe(1);
    expect(out.added).toBe(1);
    expect(out.items).toHaveLength(6);
    const pts = out.items.map(i => [Math.round((i.location.x / 100) * W), Math.round((i.location.y / 100) * H)]);
    expect(pts.sort((a, b) => a[0] - b[0])).toEqual(fixtures);
    expect(out.shapeAgreement.A).toEqual({ matched: 5, total: 5 });
    // How close the model itself got (used to compare vision models): a4 was ~11 pt off.
    expect(out.checked).toBe(6);
    expect(out.onSymbol).toBe(4);
    expect(out.moves).toHaveLength(5);
  });

  it('never snaps a fixture onto a door or another shape', () => {
    const items = [item('a1', 200, 200), item('a2', 400, 200), item('a3', 600, 200), item('a4', 430, 228)];
    const out = refineDetectionsWithSymbols(items, components, W, H);
    const moved = out.items.find(i => i.id === 'a4')!;
    // a4 is near the door and near troffer 400,200 (taken by a2): it stays where vision put it.
    expect(Math.round((moved.location.x / 100) * W)).toBe(430);
  });

  it('adds nothing when a shape is shared by two types', () => {
    const items = [item('a1', 200, 200), item('a2', 400, 200), item('a3', 600, 200), item('b1', 800, 200, 'B'), item('b2', 1000, 200, 'B'), item('b3', 1200, 200, 'B')];
    const extra = [...segments, ...troffer(1400, 200)];
    const out = refineDetectionsWithSymbols(items, buildSymbolComponents(extra), W, H);
    expect(out.added).toBe(0);
  });

  it('changes nothing without line work', () => {
    const items = [item('a1', 207, 204)];
    expect(refineDetectionsWithSymbols(items, [], W, H).items).toBe(items);
  });
});

describe('drawn-symbol additions stay stable', () => {
  // 81 identical troffers in a grid; the vision pass confirmed only some of them.
  const spots: Array<[number, number]> = [];
  for (let r = 0; r < 9; r += 1) for (let c = 0; c < 9; c += 1) spots.push([100 + c * 120, 100 + r * 90]);
  const comps = buildSymbolComponents(spots.flatMap(([x, y]) => troffer(x, y)));
  const run = (seeds: number) => refineDetectionsWithSymbols(
    spots.slice(0, seeds).map(([x, y], i) => item(`v${i}`, x, y)), comps, W, H,
  ).items.length;

  it('one more confirmed fixture never jumps the total', () => {
    expect(run(47)).toBe(81);
    expect(run(48)).toBe(81);
    expect(run(30)).toBe(81);
  });

  it('adds nothing when look-alikes far outnumber confirmed fixtures', () => {
    expect(run(5)).toBe(5);
  });
});
