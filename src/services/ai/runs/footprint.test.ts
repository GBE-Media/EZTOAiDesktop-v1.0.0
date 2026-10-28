import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildFootprint, dashedChains, footprintContains, outsideShare, snapInside } from './footprint';
import { OrthoRouter } from './spatial';
import { auditRuns } from './runAudit';
import { buildSymbolComponents } from '../detection/vectorSymbols';
import { findAnnotationBubbles } from '../detection/annotationBubbles';
import { zoneFromSignals, type ZonePageInput } from '../detection/pageZones';
import { tightenToDrawing } from './viewRegistration';

const W = 1000;
const H = 800;
/** A 200×160 building with a door gap, a leader out into the margin and a long grid line. */
function sheet(): number[] {
  const s: number[] = [];
  const line = (x1: number, y1: number, x2: number, y2: number) => s.push(x1, y1, x2, y2);
  line(300, 300, 500, 300); line(500, 300, 500, 460); line(500, 460, 410, 460); line(400, 460, 300, 460); line(300, 460, 300, 300);
  // Interior walls / furniture so the sheet has real line work.
  for (let i = 0; i < 40; i += 1) line(310 + i * 4, 320, 310 + i * 4, 330);
  for (let i = 0; i < 60; i += 1) line(320, 340 + (i % 10), 330, 340 + (i % 10));
  line(400, 300, 400, 380);
  line(500, 380, 700, 200); // leader out into the white space
  line(100, 380, 900, 380); // grid line through the building
  return s;
}

describe('building footprint', () => {
  const view = { x: 150, y: 150, width: 700, height: 500 };
  const fp = buildFootprint(sheet(), W, H, [view])!;

  it('fills the building, not the white space around it', () => {
    expect(fp).toBeTruthy();
    expect(footprintContains(fp, { x: 350, y: 350 })).toBe(true);
    expect(footprintContains(fp, { x: 450, y: 420 })).toBe(true);
    expect(footprintContains(fp, { x: 200, y: 200 })).toBe(false);
    expect(footprintContains(fp, { x: 650, y: 300 })).toBe(false); // beside the leader
    expect(footprintContains(fp, { x: 700, y: 380 })).toBe(false); // along the grid line
    expect(footprintContains(fp, { x: 350, y: 520 })).toBe(false); // just below the exterior wall
  });

  it('snaps riser points in the margin onto the building', () => {
    const p = snapInside(fp, { x: 560, y: 400 });
    expect(footprintContains(fp, p)).toBe(true);
    expect(Math.abs(p.x - 500)).toBeLessThan(fp.cell * 3);
  });

  it('routes inside the building even when the white space is shorter', () => {
    const router = new OrthoRouter({ width: W, height: H, segments: sheet(), obstacles: [], allowed: [view], footprint: fp });
    // Both ends inside near the top wall: the cheapest path would hop over the wall into the margin.
    const r = router.route({ x: 310, y: 310 }, { x: 490, y: 310 });
    expect(r.ok).toBe(true);
    expect(outsideShare(fp, r.path)).toBe(0);
  });

  it('flags a run that crosses white space', () => {
    const audit = auditRuns(
      [{ id: 'HR1', kind: 'homerun', path: [{ x: 350, y: 350 }, { x: 350, y: 200 }, { x: 480, y: 200 }, { x: 480, y: 350 }], lengthFt: 0 }],
      { ftPerPt: 0, pageMax: W, footprint: fp },
    );
    expect(audit.flagged.some(f => /outside the building/.test(f))).toBe(false); // 0 ft/pt → under the 3 ft floor
    const audit2 = auditRuns(
      [{ id: 'HR1', kind: 'homerun', path: [{ x: 350, y: 350 }, { x: 350, y: 200 }, { x: 480, y: 200 }, { x: 480, y: 350 }], lengthFt: 0 }],
      { ftPerPt: 0.5, pageMax: W, footprint: fp },
    );
    expect(audit2.flagged.some(f => /outside the building/.test(f))).toBe(true);
  });

  it('closes on real sheets, leaving the margins and schedules out', () => {
    for (const name of ['library_EL201', 'msu_E100', 'otsego_E210']) {
      const page: ZonePageInput = JSON.parse(gunzipSync(readFileSync(path.resolve(__dirname, `../../../test/fixtures/zones/${name}.json.gz`))).toString());
      const zones = zoneFromSignals(page);
      const pct = (z: { bounds: { x: number; y: number; width: number; height: number } }) => ({ x: (z.bounds.x / 100) * page.pageWidth, y: (z.bounds.y / 100) * page.pageHeight, width: (z.bounds.width / 100) * page.pageWidth, height: (z.bounds.height / 100) * page.pageHeight });
      const views = zones.filter(z => z.kind === 'plan' && z.source === 'view').map(z => tightenToDrawing(pct(z), page.segments));
      const blocked = zones.filter(z => ['schedule', 'notes', 'title_block', 'legend'].includes(z.kind)).map(pct);
      const bubbles = findAnnotationBubbles(buildSymbolComponents(page.segments), page.textItems);
      const t = Date.now();
      const out = buildFootprint(page.segments, page.pageWidth, page.pageHeight, views, bubbles, blocked);
      expect(Date.now() - t).toBeLessThan(1500);
      expect(out, name).toBeTruthy();
      let inside = 0; let total = 0;
      for (const v of out!.maskedViews) {
        for (let y = v.y; y < v.y + v.height; y += out!.cell) for (let x = v.x; x < v.x + v.width; x += out!.cell) {
          total += 1;
          if (footprintContains(out, { x, y })) inside += 1;
        }
      }
      // A real share of the view, never the whole box.
      expect(inside / total, name).toBeGreaterThan(0.2);
      expect(inside / total, name).toBeLessThan(0.92);
    }
  });

  it('leaves dashed grid lines out of the outline even without a recognised bubble', () => {
    const s: number[] = [];
    // Dash-dot grid line down the sheet: 9 pt dashes, 4 pt gaps.
    for (let y = 100; y < 700; y += 13) s.push(600, y, 600, y + 9);
    // A wall with one door gap: two long pieces, not a dashed chain.
    s.push(300, 100, 300, 380, 300, 410, 300, 700);
    const dashed = dashedChains(s, s.length / 4);
    const dashCount = Math.ceil(600 / 13);
    expect(dashed.size).toBe(dashCount);
    expect(dashed.has(dashCount)).toBe(false);
    expect(dashed.has(dashCount + 1)).toBe(false);
  });

  it('keeps runs off the white space where the outline will not close (line-work fallback)', () => {
    const s: number[] = [];
    // An open plan: no exterior wall, just fixtures (small squares) spread over one area.
    for (let x = 300; x <= 430; x += 26) for (let y = 300; y <= 420; y += 24) {
      s.push(x, y, x + 6, y, x + 6, y, x + 6, y + 6, x + 6, y + 6, x, y + 6, x, y + 6, x, y);
    }
    const open = buildFootprint(s, W, H, [view])!;
    expect(open).toBeTruthy();
    expect(open.approxViews?.length).toBe(1);
    expect(footprintContains(open, { x: 365, y: 360 })).toBe(true);
    expect(footprintContains(open, { x: 700, y: 600 })).toBe(false);
  });

  it('a view outline drawn right at the box edge still closes (box tightened to the walls)', () => {
    const tight = { x: 299, y: 299, width: 202, height: 162 };
    const out = buildFootprint(sheet(), W, H, [tight])!;
    expect(out?.maskedViews.length).toBe(1);
    expect(out.approxViews).toBeUndefined();
    expect(footprintContains(out, { x: 350, y: 350 })).toBe(true);
  });
});
