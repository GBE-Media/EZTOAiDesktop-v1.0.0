import { describe, expect, it } from 'vitest';
import { applyFieldAnswers, sanitizeClarificationFields } from '../agent/askUser';
import { useDrawingPickStore } from '@/store/drawingPickStore';
import { panelNamesFromSchedules } from './circuitTags';
import { viewIndexOf } from './planRuns';
import { buildRunInputQuestion, type RunInputNeeded } from './suggestRunsTool';

const base: RunInputNeeded = {
  needs: 'input', message: '', documentId: 'doc', page: 93, missing: ['panel_label', 'panel_location'],
  panels: [], panelArgs: [], candidates: [], panelNames: ['B', 'A', 'C'],
};

describe('several panels on one sheet', () => {
  it('asks a multi-select of every tagged panel and resumes with all of them', () => {
    const ask = buildRunInputQuestion({ ...base, panelMulti: true, panelRecommended: ['B', 'A', 'C'] }, { page: 93 });
    const field = ask.fields.find(f => f.id === 'panel_label')!;
    expect(field.multi).toBe(true);
    expect(field.options?.map(o => o.value)).toEqual(['B', 'A', 'C']);
    expect(field.recommended).toBe('B,A,C');
    // Locations are asked per chosen panel on the next card, not one "where is the panel".
    expect(ask.fields.some(f => f.id === 'panel_location')).toBe(false);
    const merged = applyFieldAnswers(ask.resume!.args, ask.resume!.apply, { panel_label: { value: 'A,C' } });
    expect(merged.panelLabels).toEqual(['A', 'C']);
    const typed = applyFieldAnswers(ask.resume!.args, ask.resume!.apply, { panel_label: { value: 'A, B and C' } });
    expect(typed.panelLabels).toEqual(['A', 'B', 'C']);
  });

  it('keeps the single choice when only one panel is known', () => {
    const ask = buildRunInputQuestion({ ...base, panelNames: ['B'] }, { page: 93 });
    const field = ask.fields.find(f => f.id === 'panel_label')!;
    expect(field.multi).toBeUndefined();
    expect(ask.resume!.apply.panel_label).toBe('panel.label');
  });

  it('keeps multi on model-built cards', () => {
    const fields = sanitizeClarificationFields([{ id: 'p', kind: 'choice', prompt: 'Panels', multi: true, options: [{ label: 'A', value: 'A' }, { label: 'C', value: 'C' }] }]);
    expect(fields[0].multi).toBe(true);
  });

  it('reads panel C and quoted panel A from the schedules, not "panel a minimum"', () => {
    const names = panelNamesFromSchedules([
      'PANELBOARD C',
      'BUS AMPS: 100A LOCATION: UTILITY ROOM 340',
      "PANELBOARD 'A'",
      'PROVIDE PANEL A MINIMUM OF 36" CLEAR',
    ]);
    expect(names).toContain('C');
    expect(names).toContain('A');
  });
});

describe('floor views', () => {
  it('puts a point in the white space between floors into the nearest view', () => {
    const views = [{ x: 0, y: 0, width: 100, height: 40 }, { x: 0, y: 60, width: 100, height: 40 }];
    expect(viewIndexOf({ x: 50, y: 20 }, views)).toBe(0);
    expect(viewIndexOf({ x: 50, y: 45 }, views)).toBe(0);
    expect(viewIndexOf({ x: 50, y: 56 }, views)).toBe(1);
  });
});

describe('keep-clear boxes', () => {
  it('adds every dragged box to the session that started it', () => {
    const store = useDrawingPickStore.getState();
    store.start({ key: 'card:keep_clear', label: 'Drag', mode: 'area', page: 93 });
    const box = (x: number) => ({ page: 93, xPct: x, yPct: 10, wPct: 5, hPct: 5 });
    store.addArea(box(10), 'card:keep_clear');
    // Something else replaced / cleared the request mid-session: the next boxes still land.
    useDrawingPickStore.getState().cancel();
    useDrawingPickStore.getState().addArea(box(20), 'card:keep_clear');
    useDrawingPickStore.getState().addArea(box(30), 'card:keep_clear');
    expect(useDrawingPickStore.getState().areas['card:keep_clear']).toHaveLength(3);
  });
});
