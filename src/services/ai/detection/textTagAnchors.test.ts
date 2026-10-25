import { describe, expect, it } from 'vitest';
import { anchorDetectionsToTextTags, findTypeTagAnchors } from './textTagAnchors';
import type { PageZone } from './pageZones';
import type { DetectedItem } from '../providers/types';

const W = 1000;
const H = 1000;
const plan: PageZone[] = [{ id: 'p', kind: 'plan', bounds: { x: 0, y: 0, width: 70, height: 100 }, label: 'Plan', confidence: 0.9, source: 'view' }];
const schedule: PageZone = { id: 's', kind: 'schedule', bounds: { x: 70, y: 0, width: 30, height: 100 }, label: 'Schedule', confidence: 0.9, source: 'text' };
const tag = (str: string, x: number, y: number, height = 6) => ({ str, x, y, width: str.length * 4, height });
const item = (id: string, x: number, y: number, code?: string, matchConfidence: DetectedItem['matchConfidence'] = 'high'): DetectedItem => ({
  id, type: code || 'light', trade: 'electrical', name: 'Fixture', quantity: 1,
  location: { x: (x / W) * 100, y: (y / H) * 100 }, confidence: 0.9, legendTypeCode: code ?? 'no_confident_match', matchConfidence,
});

describe('type tag anchors', () => {
  it('reads plan tags only, skipping schedule rows and big grid bubbles', () => {
    const text = [
      ...Array.from({ length: 8 }, (_, i) => tag('A', 100 + i * 60, 200)),
      tag('A  B-4', 100, 400),
      tag('A', 800, 300), // schedule row
      tag('A', 20, 600, 14), // grid bubble
      tag('QUEEN SUITE', 300, 500),
    ];
    const anchors = findTypeTagAnchors(text, ['A', 'B'], W, H, [...plan, schedule]);
    expect(anchors).toHaveLength(9);
    expect(anchors.every(a => a.code === 'A')).toBe(true);
    expect(findTypeTagAnchors(text, ['A'], W, H, undefined)).toEqual([]);
  });

  it('types unresolved detections from their tag and adds tagged fixtures vision missed', () => {
    const anchors = Array.from({ length: 8 }, (_, i) => ({ code: 'A', x: 10 + i * 6, y: 20 }));
    const items: DetectedItem[] = [
      ...anchors.slice(0, 6).map((a, i) => item(`v${i}`, a.x * 10 + 15, a.y * 10 + 10, i === 0 ? undefined : 'A', i === 0 ? 'low' : 'high')),
      item('b1', anchors[6].x * 10 - 10, 200, 'B'), // confident other type next to tag 7: conflict, don't add
      item('untagged', 600, 800, 'A'),
    ];
    const result = anchorDetectionsToTextTags(items, anchors, W, H);
    expect(result.resolved).toBe(1);
    expect(result.added).toBe(1);
    expect(result.items).toHaveLength(items.length + 1);
    expect(result.items.find(i => i.id === 'v0')?.legendTypeCode).toBe('A');
    expect(result.items.some(i => i.id === 'untagged')).toBe(true);
  });

  it('changes nothing when the tags do not line up with detections', () => {
    const anchors = Array.from({ length: 8 }, (_, i) => ({ code: 'A', x: 10 + i * 6, y: 20 }));
    const items = [item('far', 900, 900, 'A')];
    const result = anchorDetectionsToTextTags(items, anchors, W, H);
    expect(result.items).toBe(items);
    expect(result.added).toBe(0);
  });
});
