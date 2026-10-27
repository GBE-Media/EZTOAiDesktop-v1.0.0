import { describe, expect, it } from 'vitest';
import { insideBox, tightenToDrawing, viewOffset } from './viewRegistration';
import { auditRuns } from './runAudit';
import { OrthoRouter } from './spatial';

/** Two stacked floor plans on one sheet; floor 1 drawn 40 pt right of floor 2. */
const upper = { x: 0, y: 0, width: 2000, height: 700 };
const lower = { x: 0, y: 700, width: 2000, height: 700 };
const cols = ['1', '2', '3', '4', '5', '9.8', '10'];
const colX = [300, 450, 600, 750, 900, 1150, 1300];
function bubbles(dx: number, top: number) {
  return [
    ...cols.map((label, i) => ({ str: label, x: colX[i] + dx - 4, y: top, width: 8, height: 8 })),
    ...['D', 'E', 'F'].map((label, i) => ({ str: label, x: 220 + dx, y: top + 120 + i * 140, width: 8, height: 8 })),
    // Fixture tags in the middle of the plan must not confuse it.
    { str: 'A', x: 700 + dx, y: top + 300, width: 6, height: 6 },
    { str: 'E', x: 820 + dx, y: top + 260, width: 6, height: 6 },
  ];
}
const texts = [...bubbles(0, 90), ...bubbles(40, 790)];

/** Dense plan line work in [x0..x1]×[y0..y1]. */
function linework(x0: number, y0: number, x1: number, y1: number): number[] {
  const out: number[] = [];
  for (let y = y0; y <= y1; y += 6) for (let x = x0; x < x1; x += 10) out.push(x, y, x + 8, y);
  return out;
}

describe('stacked floor plans', () => {
  it('trims a view box to the drawing, ignoring the sheet border', () => {
    const segs = [...linework(250, 80, 1400, 600), 0, 0, 2000, 0, 2000, 0, 2000, 700];
    const box = tightenToDrawing(upper, segs);
    expect(box.x).toBeGreaterThan(200);
    expect(box.y).toBeGreaterThan(50);
    expect(box.x + box.width).toBeLessThan(1450);
    expect(box.y + box.height).toBeLessThan(640);
  });

  it('lines the floors up on the grid bubbles (a riser lands on the plan, not white space)', () => {
    const shift = viewOffset(texts, upper, lower)!;
    expect(shift.x).toBeCloseTo(40, 0);
    expect(shift.y).toBeCloseTo(700, 0);
    // Panel in the floor-1 electrical room → same spot on floor 2.
    const back = viewOffset(texts, lower, upper)!;
    expect(back.x).toBeCloseTo(-40, 0);
    expect(viewOffset(texts.filter(t => t.y < 700), upper, lower)).toBeNull();
    expect(insideBox({ x: -50, y: 2000 }, upper)).toEqual({ x: 40, y: 686 });
  });
});

describe('layout self-check', () => {
  const base = { ftPerPt: 0.1, pageMax: 2000 };
  it('flags a run across the gap between floors, into a keep-clear zone, or with off footage', () => {
    const views = [{ x: 100, y: 100, width: 800, height: 400 }, { x: 100, y: 800, width: 800, height: 400 }];
    const runs = [
      { id: 'HR1', kind: 'homerun' as const, path: [{ x: 200, y: 300 }, { x: 200, y: 900 }], lengthFt: 60 },
      { id: 'HR2', kind: 'homerun' as const, path: [{ x: 200, y: 200 }, { x: 600, y: 200 }], lengthFt: 52 },
      { id: 'HR3', kind: 'homerun' as const, path: [{ x: 200, y: 950 }, { x: 400, y: 950 }], lengthFt: 20 },
    ];
    const out = auditRuns(runs, { ...base, floorViews: views, keepClear: [{ label: 'Keep clear 1', box: { x: 380, y: 180, width: 40, height: 40 } }] });
    expect(out.flagged.some(f => /HR1 leaves its floor plan/.test(f))).toBe(true);
    expect(out.flagged.some(f => /HR2 passes through keep-clear zone "Keep clear 1"/.test(f))).toBe(true);
    expect(out.flagged.some(f => /HR2 footage \(52 ft\) doesn't match its drawn path \(40 ft\)/.test(f))).toBe(true);
    expect(out.flagged.some(f => f.startsWith('HR3'))).toBe(false);
  });
  it('passes a clean layout', () => {
    const runs = [{ id: 'HR1', kind: 'homerun' as const, path: [{ x: 0, y: 0 }, { x: 100, y: 0 }], lengthFt: 10, riserFt: 0 }];
    expect(auditRuns(runs, base).flagged).toEqual([]);
  });
});

describe('router fallback', () => {
  it('takes the L-shape that avoids a keep-clear box instead of cutting through it', () => {
    // Box sits on the "across then down" leg; target walled in so no clean route exists.
    const router = new OrthoRouter({ width: 400, height: 400, segments: [], obstacles: [{ x: 250, y: 30, width: 100, height: 60 }, { x: 330, y: 280, width: 70, height: 10 }, { x: 330, y: 280, width: 10, height: 120 }, { x: 330, y: 390, width: 70, height: 10 }] });
    const route = router.route({ x: 20, y: 60 }, { x: 370, y: 340 });
    const viaCorner = route.path[1];
    expect(viaCorner.y > 200 || route.ok).toBe(true);
  });
});
