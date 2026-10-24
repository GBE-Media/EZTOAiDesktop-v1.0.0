import { describe, expect, it } from 'vitest';
import { markupsForProjectSave } from './useProjectSave';

describe('project save markups when PDF failed to load', () => {
  it('keeps sidecar markups instead of an empty canvas map', () => {
    const sidecar = [{ id: 'm1', type: 'count-marker', page: 1 }];
    expect(markupsForProjectSave({ markups: sidecar }, false, [])).toEqual(sidecar);
    expect(markupsForProjectSave({}, false, [])).toEqual([]);
    expect(markupsForProjectSave({ markups: sidecar }, true, [{ id: 'canvas' }])).toEqual([{ id: 'canvas' }]);
  });
});
