/**
 * Hand-checked counts on real sheets. The printed type tags (text) are the primary count, so
 * these must hold exactly — any drift here is a real accuracy regression.
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseScheduleTables } from './sheetLegend';
import { zoneFromSignals } from './pageZones';
import { anchorDetectionsToTextTags, findTypeTagAnchors, type TypeTagAnchor } from './textTagAnchors';
import type { DetectedItem } from '../providers/types';

function load(name: string) {
  return JSON.parse(gunzipSync(readFileSync(`src/test/fixtures/zones/${name}.json.gz`)).toString());
}

function tagCounts(name: string, fallbackCodes: string[] = []) {
  const d = load(name);
  const zones = zoneFromSignals(d);
  let codes = parseScheduleTables(d.textItems).map(e => e.typeCode);
  if (!codes.length) codes = fallbackCodes;
  const counts: Record<string, number> = {};
  for (const a of findTypeTagAnchors(d.textItems, codes, d.pageWidth, d.pageHeight, zones)) counts[a.code] = (counts[a.code] || 0) + 1;
  return counts;
}

describe('ground-truth tag counts on real sheets', () => {
  it('Library EL-201: E2 = 81, and switch legs "c" never count as type C', () => {
    const counts = tagCounts('library_EL201');
    expect(counts.E2).toBe(81);
    expect(counts.C).toBe(25);
  });

  it('Otsego E2.10: every type exact', () => {
    const counts = tagCounts('otsego_E210');
    expect(counts).toMatchObject({ RA: 16, PA: 13, RB: 14, RC: 4, A: 10, TA: 8, TB: 7 });
  });

  it('MSU E100: A1 = 20; lower-case switch legs a/b are not types A/B', () => {
    const counts = tagCounts('msu_E100', ['A', 'A1', 'B', 'C']);
    expect(counts.A1).toBe(20);
    expect(counts.B || 0).toBeLessThanOrEqual(1);
    expect(counts.A || 0).toBeLessThanOrEqual(1);
  });
});

const W = 1000;
const H = 1000;
const det = (id: string, code: string, x: number, y: number): DetectedItem => ({
  id, type: code, trade: 'electrical', name: code, quantity: 1,
  location: { x: (x / W) * 100, y: (y / H) * 100 }, confidence: 0.9,
  legendTypeCode: code, matchConfidence: 'high',
});
const tag = (code: string, x: number, y: number): TypeTagAnchor => ({ code, x: (x / W) * 100, y: (y / H) * 100 });

describe('text tags drive the count', () => {
  it('adds a missed fixture that sits right beside a found one', () => {
    const anchors = [tag('E2', 100, 100), tag('E2', 140, 100), tag('E2', 300, 100), tag('E2', 500, 100)];
    const items = [det('a', 'E2', 100, 108), det('c', 'E2', 300, 108), det('d', 'E2', 500, 108)];
    const out = anchorDetectionsToTextTags(items, anchors, W, H);
    expect(out.added).toBe(1);
    expect(out.items.filter(i => i.legendTypeCode === 'E2')).toHaveLength(4);
  });

  it('sends an untagged extra of a fully-tagged type to review', () => {
    const anchors = Array.from({ length: 10 }, (_, k) => tag('E2', 100 + k * 80, 100));
    const items = [...anchors.map((a, k) => det(`v${k}`, 'E2', 100 + k * 80, 106)), det('extra', 'E2', 500, 700)];
    const out = anchorDetectionsToTextTags(items, anchors, W, H);
    expect(out.demoted).toBe(1);
    expect(out.items.find(i => i.id === 'extra')?.matchConfidence).toBe('low');
    expect(out.items.filter(i => i.matchConfidence !== 'low')).toHaveLength(10);
  });

  it('keeps untagged fixtures when the sheet only tags some of them', () => {
    const anchors = Array.from({ length: 8 }, (_, k) => tag('E2', 100 + k * 80, 100));
    const tagged = anchors.map((_, k) => det(`v${k}`, 'E2', 100 + k * 80, 106));
    const untagged = Array.from({ length: 8 }, (_, k) => det(`u${k}`, 'E2', 100 + k * 80, 600));
    const out = anchorDetectionsToTextTags([...tagged, ...untagged], anchors, W, H);
    expect(out.demoted || 0).toBe(0);
    expect(out.items.filter(i => i.matchConfidence !== 'low')).toHaveLength(16);
  });
});
