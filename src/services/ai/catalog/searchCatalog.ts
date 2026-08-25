import { getVisibleChildren } from '@/lib/productTree';
import type { ProductNode } from '@/types/product';
import { useProductStore } from '@/store/productStore';

export type CatalogSearchHit = {
  productId: string;
  name: string;
  type: 'product' | 'assembly';
  path: string;
  unitOfMeasure?: string;
  sku?: string | null;
  unitPrice?: number;
  score: number;
  matchKind: 'exact' | 'sku' | 'prefix' | 'keyword' | 'partial';
};

export type CatalogSearchResult = {
  query: string;
  categoryFilter?: string;
  matches: CatalogSearchHit[];
  /** True when no hit reaches the confidence threshold — do not guess a product. */
  noConfidentMatch: boolean;
  confidentMatches: CatalogSearchHit[];
  message: string;
};

/** Minimum score to treat a hit as safe for auto-binding without user confirmation. */
export const CATALOG_CONFIDENT_SCORE = 0.75;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9#+./-]+/)
    .filter(Boolean);
}

function buildCatalogIndex(nodes: Record<string, ProductNode>, rootIds: string[]) {
  const items: Array<{ node: ProductNode; path: string }> = [];

  const visit = (id: string, path: string) => {
    const node = nodes[id];
    if (!node) return;
    if (node.type === 'folder') {
      const childPath = path ? `${path}/${node.name}` : node.name;
      getVisibleChildren(node, nodes).forEach((childId) => visit(childId, childPath));
      return;
    }
    items.push({ node, path });
  };

  rootIds.forEach((id) => visit(id, ''));
  return items;
}

function scoreHit(
  query: string,
  item: { node: ProductNode; path: string },
): Omit<CatalogSearchHit, 'productId' | 'name' | 'type' | 'path' | 'unitOfMeasure' | 'sku' | 'unitPrice'> | null {
  const q = normalize(query);
  if (!q) return null;
  const name = normalize(item.node.name);
  const path = normalize(item.path);
  const sku = item.node.sku ? normalize(item.node.sku) : '';
  const haystack = `${path} ${name} ${sku}`.trim();

  if (name === q) return { score: 1, matchKind: 'exact' };
  if (sku && sku === q) return { score: 1, matchKind: 'sku' };
  if (name.startsWith(q) || name.includes(` ${q}`)) return { score: 0.9, matchKind: 'prefix' };

  const qTokens = tokenize(query);
  if (qTokens.length === 0) return null;
  const hayTokens = new Set(tokenize(haystack));
  const matched = qTokens.filter((t) => {
    if (hayTokens.has(t)) return true;
    // Allow short plan codes like "a1" / "b-nl" to match tokens containing them
    for (const h of hayTokens) {
      if (h.includes(t) || t.includes(h)) return true;
    }
    return false;
  });
  if (matched.length === 0) return null;
  const ratio = matched.length / qTokens.length;
  if (ratio >= 1) return { score: 0.85, matchKind: 'keyword' };
  if (ratio >= 0.5) return { score: 0.55 + 0.2 * ratio, matchKind: 'partial' };
  return { score: 0.4 * ratio, matchKind: 'partial' };
}

/**
 * Search the real Products panel catalog (useProductStore nodes).
 * Returns structured hits with real product IDs — never invents catalog rows.
 */
export function searchCatalog(options: {
  query: string;
  category?: string;
  limit?: number;
  /** When true, only type:'product' (linkable for takeoff measurements). */
  productsOnly?: boolean;
  nodes?: Record<string, ProductNode>;
  rootIds?: string[];
}): CatalogSearchResult {
  const store = useProductStore.getState();
  const nodes = options.nodes ?? store.nodes;
  const rootIds = options.rootIds ?? store.rootIds;
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  const categoryFilter = options.category?.trim();
  const query = options.query?.trim() || '';

  let items = buildCatalogIndex(nodes, rootIds);
  if (options.productsOnly) {
    items = items.filter((item) => item.node.type === 'product');
  }
  if (categoryFilter) {
    const cat = normalize(categoryFilter);
    items = items.filter((item) => {
      const path = normalize(item.path);
      const name = normalize(item.node.name);
      return path.includes(cat) || name.includes(cat) || (item.node.categoryPath || '').toLowerCase().includes(cat);
    });
  }

  const scored: CatalogSearchHit[] = [];
  for (const item of items) {
    if (!query) {
      scored.push({
        productId: item.node.id,
        name: item.node.name,
        type: item.node.type === 'assembly' ? 'assembly' : 'product',
        path: item.path,
        unitOfMeasure: item.node.unitOfMeasure,
        sku: item.node.sku,
        unitPrice: item.node.unitPrice,
        score: categoryFilter ? 0.7 : 0.5,
        matchKind: 'partial',
      });
      continue;
    }
    const scoredHit = scoreHit(query, item);
    if (!scoredHit) continue;
    scored.push({
      productId: item.node.id,
      name: item.node.name,
      type: item.node.type === 'assembly' ? 'assembly' : 'product',
      path: item.path,
      unitOfMeasure: item.node.unitOfMeasure,
      sku: item.node.sku,
      unitPrice: item.node.unitPrice,
      ...scoredHit,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const matches = scored.slice(0, limit);
  const confidentMatches = matches.filter((m) => m.score >= CATALOG_CONFIDENT_SCORE);
  const noConfidentMatch = Boolean(query) && confidentMatches.length === 0;

  let message: string;
  if (!query && !categoryFilter) {
    message = `Listed ${matches.length} catalog item(s). Pass a query to search by name/SKU/fixture code.`;
  } else if (matches.length === 0) {
    message = `No catalog products matched “${query || categoryFilter}”. Do not invent a product ID — place geometry with label only or ask the user.`;
  } else if (noConfidentMatch) {
    message = `No confident catalog match for “${query}” (best score ${(matches[0]?.score ?? 0).toFixed(2)}). `
      + 'Do not silently bind a product — flag “no matching catalog product found” and leave productId unset, or ask the user to pick.';
  } else {
    message = `Found ${confidentMatches.length} confident match(es) for “${query}”. Use productId from confidentMatches when placing/linking.`;
  }

  return {
    query,
    categoryFilter: categoryFilter || undefined,
    matches,
    noConfidentMatch,
    confidentMatches,
    message,
  };
}
