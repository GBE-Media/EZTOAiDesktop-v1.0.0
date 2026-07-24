import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
});
import { generateOverlappingTileRegions } from './imageCapture';
import { buildVerifiedCalloutPointers, reconcileTileDetections } from './pipeline';
import type { BlueprintAnalysisResult, DetectedItem } from './providers/types';

const createItem = (id: string, type: string, x: number, y: number, confidence = 0.9): DetectedItem => ({
  id,
  type,
  trade: 'electrical',
  name: type,
  quantity: 1,
  location: { x, y },
  confidence,
});

const createResult = (items: DetectedItem[]): BlueprintAnalysisResult => ({
  page: 1,
  items,
  dimensions: [],
  text: [],
  symbols: [],
});

describe('reconcileTileDetections', () => {
  it('maps tile-local coordinates into page percentage coordinates', () => {
    const region = generateOverlappingTileRegions(900, 600)[4];
    const items = reconcileTileDetections([
      { region, result: createResult([createItem('center', 'receptacle', 50, 50)]) },
    ], 900, 600);

    expect(items).toHaveLength(1);
    expect(items[0].location.x).toBeCloseTo(50, 1);
    expect(items[0].location.y).toBeCloseTo(50, 1);
  });

  it('keeps only the owning tile copy of a detection in an overlap', () => {
    const [left, middle] = generateOverlappingTileRegions(900, 600).slice(0, 2);
    const pageX = 300;
    const pageY = 100;
    const local = (region: typeof left) => ({
      x: ((pageX - region.x) / region.width) * 100,
      y: ((pageY - region.y) / region.height) * 100,
    });

    const leftLocal = local(left);
    const middleLocal = local(middle);
    const items = reconcileTileDetections([
      {
        region: left,
        result: createResult([createItem('left-copy', 'duplex receptacle', leftLocal.x, leftLocal.y, 0.8)]),
      },
      {
        region: middle,
        result: createResult([createItem('middle-copy', 'duplex receptacle', middleLocal.x, middleLocal.y, 0.95)]),
      },
    ], 900, 600);

    expect(items).toHaveLength(1);
    expect(items[0].location.x).toBeCloseTo(33.33, 1);
  });

  it('does not merge different symbol types at the same location', () => {
    const region = generateOverlappingTileRegions(900, 600)[0];
    const items = reconcileTileDetections([
      {
        region,
        result: createResult([
          createItem('a', 'receptacle', 50, 50),
          createItem('b', 'data outlet', 50, 50),
        ]),
      },
    ], 900, 600);

    expect(items).toHaveLength(2);
  });
});

describe('buildVerifiedCalloutPointers', () => {
  it('uses reconciled bounding boxes instead of model-guessed coordinates', () => {
    const item = createItem('panel-1', 'electrical panel', 52, 38, 0.97);
    item.name = 'Panel LP1';
    item.boundingBox = { x: 48, y: 32, width: 8, height: 12 };
    item.evidence = 'Panel outline labeled LP1';

    const pointers = buildVerifiedCalloutPointers(
      createResult([item]),
      'The electrical panel LP1 is shown near the center of the sheet.'
    );

    expect(pointers).toEqual([{
      type: 'rectangle',
      xPct: 52,
      yPct: 38,
      boundsPct: { x: 48, y: 32, width: 8, height: 12 },
      label: 'Panel LP1',
      note: 'Panel outline labeled LP1',
      confidence: 0.97,
    }]);
  });
});
