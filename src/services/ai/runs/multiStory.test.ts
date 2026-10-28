import { describe, expect, it } from 'vitest';
import { floorLevel, floorViewsFromTitles, mapBetweenViews, riserBetween, riserGroups, riserText } from './suggestRunsTool';
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
    // Two views of the same floor: a horizontal continuation, never a 12 ft riser.
    const same = riserBetween(level1, level2, { x: 100, y: 150 }, floorLevel('FIRST FLOOR DEMOLITION PLAN'), floorLevel('FIRST FLOOR LIGHTING PLAN'), 12);
    expect(same.levels).toBe(0);
    expect(same.ft).toBe(0);
    expect(riserText('A', same)).toMatch(/same floor/);
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

describe('panel from circuit tags and schedules', async () => {
  const { readCircuitTags, panelNamesFromSchedules, panelsTaggedOnSheet } = await import('./circuitTags');
  it('joins tags split into pieces by the PDF text layer', () => {
    const items = [
      { str: 'B', x: 100, y: 50, width: 6, height: 8 },
      { str: '-', x: 106.5, y: 50, width: 3, height: 8 },
      { str: '4', x: 110, y: 50, width: 6, height: 8 },
      { str: 'B-', x: 300, y: 80, width: 9, height: 8 },
      { str: '6', x: 309.5, y: 80, width: 5, height: 8 },
      { str: 'A B-8', x: 500, y: 90, width: 22, height: 8 },
    ];
    expect(readCircuitTags(items).map(t => t.id).sort()).toEqual(['B-4', 'B-6', 'B-8']);
    expect(panelsTaggedOnSheet(items)[0]).toMatchObject({ panel: 'B', tags: 3 });
  });
  it('keeps a scheduled panel with a single tag on the sheet (Panel C), drops a stray unscheduled one', () => {
    const items = [
      { str: 'A-1', x: 100, y: 50, width: 14, height: 8 },
      { str: 'A-3', x: 200, y: 50, width: 14, height: 8 },
      { str: 'C-2', x: 300, y: 50, width: 14, height: 8 },
      { str: 'Q-7', x: 400, y: 50, width: 14, height: 8 },
    ];
    const panels = panelsTaggedOnSheet(items, ['A', 'B', 'C']).map(r => r.panel);
    expect(panels).toContain('A');
    expect(panels).toContain('C');
    expect(panelsTaggedOnSheet(items).map(r => r.panel)).not.toContain('Q');
  });
  it('does not read spec words as panel names', () => {
    expect(panelNamesFromSchedules(['PANEL LABEL SHALL BE ENGRAVED', 'PANEL DOOR IN DOOR', 'PANEL: B', 'PANELBOARD H1', 'PNL LP-1'])).toEqual(['B', 'H1', 'LP-1']);
  });
});

describe('floor plan views from their titles', () => {
  it('splits a stacked first / second floor sheet at the titles', () => {
    const area = { x: 0, y: 0, width: 3000, height: 2000 };
    const items = [
      { str: '2', x: 1200, y: 900, width: 20, height: 24 },
      { str: 'SECOND FLOOR', x: 1240, y: 900, width: 200, height: 24 },
      { str: 'ELECTRICAL PLAN', x: 1450, y: 900, width: 240, height: 24 },
      { str: '1 FIRST FLOOR ELECTRICAL PLAN', x: 1200, y: 1900, width: 460, height: 24 },
      { str: 'SEE FIRST FLOOR PLAN FOR CONTINUATION', x: 100, y: 500, width: 500, height: 10 },
    ];
    const views = floorViewsFromTitles(items, area);
    expect(views.map(v => v.level.n)).toEqual([2, 1]);
    expect(views[0].box.y).toBe(0);
    expect(views[0].box.y + views[0].box.height).toBeCloseTo(972);
    expect(views[1].box.y).toBeCloseTo(972);
    expect(views[1].box.y + views[1].box.height).toBe(2000);
  });

  it('breaks a spread-out floor into up to 3 risers', () => {
    const view = { x: 0, y: 0, width: 1000, height: 300 };
    const c = (x: number) => ({ devices: [{ x, y: 100 }, { x: x + 20, y: 120 }] });
    expect(riserGroups([c(50), c(90), c(480), c(900), c(940)], view).map(g => g.length)).toEqual([2, 1, 2]);
    expect(riserGroups([c(50), c(150), c(250)], view)).toHaveLength(1);
    expect(mapBetweenViews({ x: 100, y: 50 }, { x: 0, y: 0, width: 1000, height: 300 }, { x: 0, y: 400, width: 1000, height: 300 })).toEqual({ x: 100, y: 450 });
  });
});
