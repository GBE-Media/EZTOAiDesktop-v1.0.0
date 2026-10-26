import { describe, expect, it } from 'vitest';
import { floorLevel, riserBetween, riserText } from './suggestRunsTool';
import { moveRunStart, rebendArc } from './anchors';
import { assemblyProductSpec, runProductFeet } from './runMaterials';
import { isElevationMark } from './spatial';
import { runLengthFt } from './overlay';

describe('multi-story risers', () => {
  it('reads the floor from the plan view title', () => {
    expect(floorLevel('SECOND FLOOR LIGHTING PLAN')?.n).toBe(2);
    expect(floorLevel('FIRST FLOOR ELECTRICAL PLAN')?.name).toBe('Level 1');
    expect(floorLevel('LEVEL 3 POWER PLAN')?.n).toBe(3);
    expect(floorLevel('2ND FLOOR PLAN')?.n).toBe(2);
    expect(floorLevel('BASEMENT LIGHTING')?.n).toBe(0);
    expect(floorLevel('ENLARGED PLAN')).toBeNull();
  });

  it('stacks the riser over the panel and adds floor-to-floor footage', () => {
    const level1 = { x: 0, y: 0, width: 400, height: 300 };
    const level2 = { x: 500, y: 0, width: 400, height: 300 };
    const riser = riserBetween(level1, level2, { x: 100, y: 150 }, floorLevel('FIRST FLOOR PLAN'), floorLevel('THIRD FLOOR PLAN'), 12);
    expect(riser.point).toEqual({ x: 600, y: 150 });
    expect(riser.direction).toBe('down');
    expect(riser.levels).toBe(2);
    expect(riser.ft).toBe(24);
    expect(riserText('B', riser)).toBe('↓ to Panel B (Level 1)');
    const up = riserBetween(level2, level1, { x: 600, y: 150 }, floorLevel('SECOND FLOOR'), floorLevel('FIRST FLOOR'), 12);
    expect(up.direction).toBe('up');
    // Riser footage survives a manual edit of the run.
    expect(runLengthFt([{ x: 0, y: 0 }, { x: 10, y: 0 }], { ftPerPt: 1, riserFt: 12 })).toBe(22);
  });
});

describe('anchored run geometry', () => {
  it('re-bends an arc onto new ends, same side', () => {
    const arc = rebendArc([{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 0 }], { x: 0, y: 0 }, { x: 200, y: 0 });
    expect(arc[2]).toEqual({ x: 200, y: 0 });
    expect(arc[1].x).toBeCloseTo(100);
    expect(arc[1].y).toBeCloseTo(20);
  });

  it('keeps the first leg of a home run square', () => {
    const pts = moveRunStart([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], { x: 5, y: 20 });
    expect(pts[0]).toEqual({ x: 5, y: 20 });
    expect(pts[1]).toEqual({ x: 100, y: 20 });
  });
});

describe('MC takeoff feet', () => {
  it('counts each cable in a single-type bundle', () => {
    const assembly = { key: 'run:3× MC Cable 12/2+G', name: '3× MC Cable 12/2+G', materials: [{ name: 'MC Cable 12/2+G', unit: 'ft' as const, perFt: 3 }] };
    expect(runProductFeet(assembly, 100)).toBe(300);
    expect(assemblyProductSpec(assembly, 'homerun').name).toBe('MC Cable 12/2+G');
    const emt = { key: 'run:x', name: '3/4" EMT', materials: [{ name: '3/4" EMT', unit: 'ft' as const, perFt: 1 }, { name: '#12 THHN Cu', unit: 'ft' as const, perFt: 4 }] };
    expect(runProductFeet(emt, 100)).toBe(100);
  });
});

describe('keep-clear detection', () => {
  it('ignores elevation marks', () => {
    expect(isElevationMark('T.O. ELEV 112\'-0"')).toBe(true);
    expect(isElevationMark('ELEV +10\'')).toBe(true);
    expect(isElevationMark('ELEV 2')).toBe(false);
    expect(isElevationMark('ELEVATOR')).toBe(false);
  });
});
