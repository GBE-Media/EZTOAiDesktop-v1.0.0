/**
 * Deterministic cross-check for vision counts: most lighting plans print the fixture type
 * ("A", "XA", "B1"…) next to every fixture. Those tags are in the PDF text layer, so they read
 * the same on every run. Vision detections are snapped to them:
 *  - a detection the vision model couldn't classify takes the type of the tag beside it;
 *  - a tag with no detection near it is a fixture the vision pass missed, so it is added.
 * Vision detections are never removed (untagged fixtures are common), so the count only moves
 * toward the stable printed tags.
 */
import type { TextItemWithBounds } from '@/lib/pdfLoader';
import type { DetectedItem } from '../providers/types';
import { zoneAtPoint, type PageZone } from './pageZones';

export interface TypeTagAnchor {
  code: string;
  /** Display percent (0–100). */
  x: number;
  y: number;
}

const NO_MATCH = 'no_confident_match';
/** Minimum tags on a sheet before they're trusted as a convention. */
const MIN_ANCHORS = 6;
/** A tag belongs to a fixture within this distance (page points, ~0.75"). */
const PAIR_RADIUS_PT = 54;
/** A type counts as fully tagged when it has this many tags… */
const FULLY_TAGGED_MIN = 8;
/** …and at least this share of its detections sit beside one. */
const FULLY_TAGGED_SHARE = 0.8;

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Fixture type tags in the plan views. Needs page zones: without them schedule rows and notes
 * could pass for tags, so nothing is returned.
 */
export function findTypeTagAnchors(
  textItems: TextItemWithBounds[] | undefined,
  codes: string[],
  pageWidth: number,
  pageHeight: number,
  zones: PageZone[] | undefined,
): TypeTagAnchor[] {
  if (!textItems?.length || !codes.length || !zones?.length || pageWidth <= 0 || pageHeight <= 0) return [];
  const codeSet = new Set(codes.map(code => code.trim().toUpperCase()).filter(Boolean));
  if (!codeSet.size) return [];

  const raw: Array<TypeTagAnchor & { h: number; px: number; py: number }> = [];
  for (const item of textItems) {
    const text = item.str || '';
    if (!text.trim() || text.length > 40) continue;
    // Tags are short tokens, possibly printed with the circuit ("A  B-4") in one text run.
    const tokens = [...text.matchAll(/\S+/g)];
    if (tokens.length > 3) continue;
    for (const token of tokens) {
      const printed = token[0].replace(/[(),.;:]+$/g, '');
      // Case-sensitive: schedules print types in capitals; a lower-case letter beside a fixture
      // is its switch leg ("E2, 1, c"), never type C.
      if (printed !== printed.toUpperCase()) continue;
      const value = printed;
      if (!codeSet.has(value)) continue;
      const frac = text.length ? (token.index! + value.length / 2) / text.length : 0.5;
      const px = item.x + item.width * frac;
      const py = item.y + item.height / 2;
      const x = (px / pageWidth) * 100;
      const y = (py / pageHeight) * 100;
      const zone = zoneAtPoint(zones, x, y);
      if (!zone || zone.kind !== 'plan') continue;
      raw.push({ code: value, x, y, px, py, h: item.height });
    }
  }

  // Grid bubbles and detail callouts reuse the same letters in much larger text.
  const typical = median(raw.map(anchor => anchor.h).filter(h => h > 0));
  const sized = typical > 0 ? raw.filter(anchor => !(anchor.h > typical * 1.4)) : raw;

  // The same tag drawn twice (shadowed text) is one tag.
  const anchors: typeof sized = [];
  for (const anchor of sized) {
    if (anchors.some(other => other.code === anchor.code && Math.hypot(other.px - anchor.px, other.py - anchor.py) < 3)) continue;
    anchors.push(anchor);
  }
  if (anchors.length < MIN_ANCHORS) return [];
  return anchors.map(({ code, x, y }) => ({ code, x, y }));
}

export interface AnchorReconcileResult {
  items: DetectedItem[];
  anchors: number;
  matched: number;
  added: number;
  resolved: number;
  /** Untagged detections of a fully-tagged type, sent to review. */
  demoted?: number;
  tagCounts: Record<string, number>;
}

function isUnresolved(item: DetectedItem): boolean {
  const code = (item.legendTypeCode || '').trim();
  return !code || code === NO_MATCH || item.matchConfidence === 'low';
}

export function anchorDetectionsToTextTags(
  items: DetectedItem[],
  anchors: TypeTagAnchor[],
  pageWidth: number,
  pageHeight: number,
): AnchorReconcileResult {
  const tagCounts: Record<string, number> = {};
  for (const anchor of anchors) tagCounts[anchor.code] = (tagCounts[anchor.code] || 0) + 1;
  if (!anchors.length) return { items, anchors: 0, matched: 0, added: 0, resolved: 0, tagCounts };

  const pts = items.map(item => (item.locationMissing || !Number.isFinite(item.location?.x) || !Number.isFinite(item.location?.y)
    ? null
    : { x: (item.location.x / 100) * pageWidth, y: (item.location.y / 100) * pageHeight }));

  // Closest pairs first, one tag per detection (deterministic tie-break by index).
  const pairs: Array<{ a: number; i: number; d: number; sameCode: boolean }> = [];
  const hasNeighbour = new Set<number>();
  anchors.forEach((anchor, a) => {
    const ax = (anchor.x / 100) * pageWidth;
    const ay = (anchor.y / 100) * pageHeight;
    pts.forEach((pt, i) => {
      if (!pt) return;
      const d = Math.hypot(pt.x - ax, pt.y - ay);
      if (d > PAIR_RADIUS_PT) return;
      hasNeighbour.add(a);
      const code = (items[i].legendTypeCode || '').trim().toUpperCase();
      pairs.push({ a, i, d, sameCode: code === anchor.code });
    });
  });
  // A detection already classified as this tag's type is the best partner; then the nearest.
  pairs.sort((p, q) => Number(q.sameCode) - Number(p.sameCode) || p.d - q.d || p.a - q.a || p.i - q.i);
  const anchorUsed = new Set<number>();
  const itemUsed = new Set<number>();
  const next = [...items];
  let resolved = 0;
  for (const pair of pairs) {
    if (anchorUsed.has(pair.a) || itemUsed.has(pair.i)) continue;
    const item = next[pair.i];
    const code = anchors[pair.a].code;
    const itemCode = (item.legendTypeCode || '').trim().toUpperCase();
    // A confident, different type is a neighbouring fixture; leave the tag for another match.
    if (!isUnresolved(item) && itemCode !== code) continue;
    anchorUsed.add(pair.a);
    itemUsed.add(pair.i);
    if (isUnresolved(item)) {
      resolved += 1;
      next[pair.i] = {
        ...item,
        type: code,
        legendTypeCode: code,
        matchConfidence: 'medium',
        evidence: [item.evidence, `Type tag "${code}" printed beside this symbol`].filter(Boolean).join('; '),
      };
    }
  }

  // Most tags must sit beside a detection, or the tag convention (or text frame) isn't what we
  // think — then change nothing.
  if (anchorUsed.size + [...hasNeighbour].filter(a => !anchorUsed.has(a)).length < anchors.length * 0.5) {
    return { items, anchors: anchors.length, matched: 0, added: 0, resolved: 0, tagCounts };
  }

  // A tag left over next to a detection that no tag claimed is a type conflict (for review), not
  // a missed fixture. A neighbour already paired with its own tag doesn't block it: in dense
  // grids a missed fixture sits right next to a found one.
  const conflict = new Set<number>();
  anchors.forEach((anchor, a) => {
    if (anchorUsed.has(a)) return;
    const ax = (anchor.x / 100) * pageWidth;
    const ay = (anchor.y / 100) * pageHeight;
    if (pts.some((pt, i) => !!pt && !itemUsed.has(i) && Math.hypot(pt.x - ax, pt.y - ay) <= PAIR_RADIUS_PT)) conflict.add(a);
  });
  let added = 0;
  anchors.forEach((anchor, a) => {
    if (anchorUsed.has(a) || conflict.has(a)) return;
    added += 1;
    next.push({
      id: `tag_${anchor.code}_${a}`,
      type: anchor.code,
      trade: items[0]?.trade || 'electrical',
      name: `Type ${anchor.code}`,
      quantity: 1,
      location: { x: anchor.x, y: anchor.y },
      confidence: 0.7,
      legendTypeCode: anchor.code,
      matchConfidence: 'medium',
      evidence: `Type tag "${anchor.code}" printed on the plan; the symbol was not picked up by the vision pass`,
    });
  });

  // Text is the primary count: when this sheet tags (nearly) every fixture of a type, a detection
  // of that type with no tag beside it is a duplicate or a misread — send it to review rather than
  // let it inflate the total. Sheets that tag only some fixtures keep every detection.
  let demoted = 0;
  const pairedByCode: Record<string, number> = {};
  const detectedByCode: Record<string, number> = {};
  items.forEach((item, i) => {
    if (!pts[i] || isUnresolved(next[i])) return;
    const code = (next[i].legendTypeCode || '').trim().toUpperCase();
    if (!tagCounts[code]) return;
    detectedByCode[code] = (detectedByCode[code] || 0) + 1;
    if (itemUsed.has(i)) pairedByCode[code] = (pairedByCode[code] || 0) + 1;
  });
  items.forEach((item, i) => {
    if (!pts[i] || itemUsed.has(i) || isUnresolved(next[i])) return;
    const code = (next[i].legendTypeCode || '').trim().toUpperCase();
    const tags = tagCounts[code] || 0;
    const paired = pairedByCode[code] || 0;
    if (tags < FULLY_TAGGED_MIN || paired < (detectedByCode[code] || 0) * FULLY_TAGGED_SHARE) return;
    demoted += 1;
    next[i] = {
      ...next[i],
      matchConfidence: 'low',
      evidence: [next[i].evidence, `No "${code}" tag printed here, though every other ${code} on this sheet is tagged — review`].filter(Boolean).join('; '),
    };
  });

  return { items: next, anchors: anchors.length, matched: anchorUsed.size, added, resolved, demoted, tagCounts };
}
