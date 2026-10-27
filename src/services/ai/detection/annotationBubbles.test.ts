import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { bubbleAt, findAnnotationBubbles } from './annotationBubbles';
import { buildSymbolComponents } from './vectorSymbols';
import type { ZonePageInput } from './pageZones';

const load = (name: string): ZonePageInput => JSON.parse(gunzipSync(readFileSync(path.resolve(__dirname, `../../../test/fixtures/zones/${name}.json.gz`))).toString());

describe('annotation bubbles (never fixtures)', () => {
  it('finds the column / row grid bubbles on a real plan', () => {
    const page = load('library_EL201');
    const bubbles = findAnnotationBubbles(buildSymbolComponents(page.segments), page.textItems);
    const grid = bubbles.filter(b => b.kind === 'grid').map(b => b.label);
    for (const label of ['1', '2', '3', 'A', 'B', 'C', 'D']) expect(grid).toContain(label);
    // A detection sitting on a bubble is matched; a point in the room is not.
    const one = bubbles.find(b => b.kind === 'grid' && b.label === 'A')!;
    expect(bubbleAt(bubbles, one.cx + one.r * 0.3, one.cy)).toBeTruthy();
    expect(bubbleAt(bubbles, one.cx + one.r * 6, one.cy + one.r * 6)).toBeUndefined();
  });

  it('does not invent a grid on a sheet without one', () => {
    const page = load('otsego_E210');
    const bubbles = findAnnotationBubbles(buildSymbolComponents(page.segments), page.textItems);
    expect(bubbles.filter(b => b.kind === 'grid')).toHaveLength(0);
  });
});
