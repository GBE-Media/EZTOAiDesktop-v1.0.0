import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { filterDetectionsByZones, zoneAtPoint, zoneFromSignals, type PageZone, type PageZoneKind } from './pageZones';

/**
 * Real bid-set sheets (text + vectors extracted with scripts/extract-zone-fixtures.ts).
 * Points are display percent of the viewport (what vision returns).
 */
function loadZones(name: string): PageZone[] {
  const file = path.resolve(__dirname, '../../../test/fixtures/zones', `${name}.json.gz`);
  const input = JSON.parse(gunzipSync(readFileSync(file)).toString());
  return zoneFromSignals(input);
}

function kindAt(zones: PageZone[], x: number, y: number): PageZoneKind | undefined {
  return zoneAtPoint(zones, x, y)?.kind;
}

function countedShare(zones: PageZone[]): number {
  let counted = 0;
  let total = 0;
  for (let x = 1; x < 100; x += 2.5) {
    for (let y = 1; y < 100; y += 2.5) {
      total += 1;
      if (kindAt(zones, x, y) === 'plan') counted += 1;
    }
  }
  return counted / total;
}

describe('page zones on real sheets', () => {
  it('Library EL-201: floor plan counted; schedule, notes, detail, title block excluded', () => {
    const zones = loadZones('library_EL201');
    for (const [x, y] of [[20, 30], [35, 40], [55, 45], [25, 50]]) {
      expect(kindAt(zones, x, y), `(${x},${y})`).toBe('plan');
    }
    expect(kindAt(zones, 40, 88)).toBe('schedule');
    expect(kindAt(zones, 70, 12)).toBe('notes');
    expect(kindAt(zones, 70, 25)).toBe('notes');
    expect(kindAt(zones, 68, 48)).toBe('detail');
    expect(kindAt(zones, 95, 50)).toBe('title_block');
    expect(countedShare(zones)).toBeGreaterThanOrEqual(0.5);
  });

  it('Otsego E210 (rotated 90°): lighting plans counted, demolition plans and schedule excluded', () => {
    const zones = loadZones('otsego_E210');
    expect(kindAt(zones, 60, 60)).toBe('plan');
    expect(kindAt(zones, 70, 80)).toBe('plan');
    expect(kindAt(zones, 65, 41)).toBe('plan');
    expect(kindAt(zones, 25, 70)).toBe('demo_plan');
    expect(kindAt(zones, 28, 41)).toBe('demo_plan');
    expect(kindAt(zones, 60, 10)).toBe('schedule');
    expect(kindAt(zones, 83, 30)).toBe('notes');
    expect(kindAt(zones, 20, 10)).toBe('diagram');
    expect(kindAt(zones, 95, 60)).toBe('title_block');
  });

  it('MSU E100: renovation plan counted, demolition plan excluded', () => {
    const zones = loadZones('msu_E100');
    for (const [x, y] of [[55, 40], [65, 60], [75, 75]]) {
      expect(kindAt(zones, x, y), `(${x},${y})`).toBe('plan');
    }
    expect(kindAt(zones, 25, 50)).toBe('demo_plan');
    expect(kindAt(zones, 96, 50)).toBe('title_block');
    const items = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `new${i}`, location: { x: 52 + (i % 4) * 6, y: 38 + Math.floor(i / 4) * 12 } })),
      ...Array.from({ length: 6 }, (_, i) => ({ id: `demo${i}`, location: { x: 18 + (i % 3) * 8, y: 40 + Math.floor(i / 3) * 15 } })),
    ];
    const filtered = filterDetectionsByZones(items, zones);
    expect(filtered.kept.map(item => item.id).sort()).toEqual(items.slice(0, 12).map(item => item.id).sort());
  });

  it('keeps everything with a low-confidence warning when no plan view is identified', () => {
    const zones: PageZone[] = [
      { id: 'sheet', kind: 'plan', bounds: { x: 0, y: 0, width: 100, height: 100 }, label: 'Sheet', confidence: 0.5, source: 'sheet' },
      { id: 'n', kind: 'notes', bounds: { x: 0, y: 0, width: 80, height: 80 }, label: 'Notes', confidence: 0.6, source: 'text' },
    ];
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `i${i}`, location: { x: 10 + i * 5, y: 40 } }));
    const filtered = filterDetectionsByZones(items, zones);
    expect(filtered.kept).toHaveLength(10);
    expect(filtered.lowConfidence).toBe(true);
  });
});
