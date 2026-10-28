import { beforeEach, describe, expect, it } from 'vitest';
import { pickMatchesPage, useDrawingPickStore } from './drawingPickStore';

beforeEach(() => { useDrawingPickStore.setState({ request: null, pins: {}, areas: {} }); });
const request = { key: 'card:panel', label: 'Panel A', documentId: 'drawing', page: 4 };
const point = { documentId: 'drawing', page: 4, xPct: 40.123, yPct: 60.456 };

describe('drawing-card pick lifecycle', () => {
  it('rejects a different sheet or document without consuming the request', () => {
    const store = useDrawingPickStore.getState();
    store.start(request);
    store.complete({ ...point, page: 5 });
    store.complete({ ...point, documentId: 'specs' });
    expect(useDrawingPickStore.getState().pins).toEqual({});
    expect(useDrawingPickStore.getState().request).toEqual(request);
    expect(pickMatchesPage(request, 'drawing', 5)).toBe(false);
    store.complete(point);
    expect(useDrawingPickStore.getState().pins[request.key]).toMatchObject(point);
    expect(useDrawingPickStore.getState().request).toBeNull();
  });

  it('redo clears the stale point; cancel does not restore it', () => {
    const store = useDrawingPickStore.getState();
    store.start(request);
    store.complete(point);
    store.start(request);
    store.cancel();
    expect(useDrawingPickStore.getState().pins[request.key]).toBeUndefined();
  });

  it('changing a point option clears only that field, not another panel', () => {
    const store = useDrawingPickStore.getState();
    store.start(request); store.complete(point);
    store.start({ ...request, key: 'card:panelB' }); store.complete(point);
    store.clearPin(request.key);
    expect(Object.keys(useDrawingPickStore.getState().pins)).toEqual(['card:panelB']);
  });

  it('submitting a card clears its active area session and leaves other cards alone', () => {
    const store = useDrawingPickStore.getState();
    store.start({ ...request, key: 'card:zones', mode: 'area' });
    store.addArea({ ...point, wPct: 4, hPct: 3 });
    store.seedAreas('other:zones', [{ ...point, wPct: 1, hPct: 1 }]);
    store.clearPins('card:');
    expect(useDrawingPickStore.getState().request).toBeNull();
    expect(Object.keys(useDrawingPickStore.getState().areas)).toEqual(['other:zones']);
  });
});
