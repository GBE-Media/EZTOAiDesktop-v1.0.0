import type { ProductNode } from '@/types/product';

export interface ProductHighlight {
  nodeId: string;
  name: string;
  /** markupIds on the active document, by page. */
  byPage: Record<number, string[]>;
  ids: Set<string>;
  total: number;
  /** Linked counts on other documents. */
  otherDocuments: number;
}

/** Markups linked to a product (or every product under a folder) on one document, grouped by page. */
export function productHighlight(
  nodes: Record<string, ProductNode>,
  nodeId: string | null,
  documentId: string | null,
): ProductHighlight | null {
  if (!nodeId || !documentId) return null;
  const root = nodes[nodeId];
  if (!root) return null;
  const byPage: Record<number, string[]> = {};
  const ids = new Set<string>();
  let otherDocuments = 0;
  const visit = (id: string, depth: number) => {
    const node = nodes[id];
    if (!node || depth > 12) return;
    for (const m of node.measurements || []) {
      if (m.documentId !== documentId) { otherDocuments += 1; continue; }
      if (ids.has(m.markupId)) continue;
      ids.add(m.markupId);
      (byPage[m.page] = byPage[m.page] || []).push(m.markupId);
    }
    for (const child of node.children || []) visit(child, depth + 1);
  };
  visit(nodeId, 0);
  if (!ids.size && !otherDocuments) return null;
  return { nodeId, name: root.name, byPage, ids, total: ids.size, otherDocuments };
}
