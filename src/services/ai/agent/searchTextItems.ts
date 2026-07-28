import type { EvidenceCitation } from '@/types/assistant';

export interface SearchTextItemsInput {
  query: string;
  page: number;
  documentId?: string;
  textItems: Array<{ str: string; x: number; y: number; width: number; height: number }>;
}

/** Match PDF text items and return citations with geometry for canvas focus. */
export function searchTextItemsWithBounds(input: SearchTextItemsInput): EvidenceCitation[] {
  const query = input.query.trim();
  if (!query || !input.textItems.length) return [];

  const lower = query.toLowerCase();
  const tokens = lower.split(/\s+/).filter(Boolean);

  // Prefer full-query substring hits on individual items.
  const itemHits = input.textItems.filter(item => item.str.toLowerCase().includes(lower));

  // Also match multi-token queries across nearby items on the same line (y-proximity).
  const lineGroups = groupNearbyTextItems(input.textItems);
  const lineHits = lineGroups
    .map(group => {
      const joined = group.map(item => item.str).join(' ');
      const joinedLower = joined.toLowerCase();
      if (!joinedLower.includes(lower) && !tokens.every(token => joinedLower.includes(token))) {
        return null;
      }
      return {
        snippet: joined.slice(0, 200),
        bounds: unionBounds(group),
      };
    })
    .filter((hit): hit is { snippet: string; bounds: { x: number; y: number; width: number; height: number } } => Boolean(hit));

  const citations: EvidenceCitation[] = [];

  for (const hit of lineHits.slice(0, 12)) {
    citations.push({
      id: `search_line_${citations.length}`,
      documentId: input.documentId,
      page: input.page,
      label: query,
      snippet: hit.snippet,
      bounds: hit.bounds,
    });
  }

  if (!citations.length) {
    for (const item of itemHits.slice(0, 20)) {
      citations.push({
        id: `search_${citations.length}`,
        documentId: input.documentId,
        page: input.page,
        label: query,
        snippet: item.str.slice(0, 200),
        bounds: { x: item.x, y: item.y, width: item.width, height: item.height },
      });
    }
  }

  return citations;
}

function groupNearbyTextItems(
  items: Array<{ str: string; x: number; y: number; width: number; height: number }>,
  yTolerance = 8,
): Array<Array<{ str: string; x: number; y: number; width: number; height: number }>> {
  if (!items.length) return [];
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: Array<Array<typeof items[number]>> = [];
  let current: Array<typeof items[number]> = [];
  let currentY = sorted[0].y;

  for (const item of sorted) {
    if (current.length && Math.abs(item.y - currentY) > yTolerance) {
      groups.push(current);
      current = [];
    }
    current.push(item);
    currentY = item.y;
  }
  if (current.length) groups.push(current);
  return groups;
}

function unionBounds(
  items: Array<{ x: number; y: number; width: number; height: number }>,
): { x: number; y: number; width: number; height: number } {
  const minX = Math.min(...items.map(item => item.x));
  const minY = Math.min(...items.map(item => item.y));
  const maxX = Math.max(...items.map(item => item.x + item.width));
  const maxY = Math.max(...items.map(item => item.y + item.height));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}
