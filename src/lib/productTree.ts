import type { ProductNode } from '@/types/product';

// Legacy nodes may not have `children` populated (they were linked purely via
// `parentId`), so folders fall back to deriving their child list from `nodes`.
export function getVisibleChildren(node: ProductNode, nodes: Record<string, ProductNode>): string[] {
  if (node.type !== 'folder') return [];
  if (node.children.length > 0) return node.children;
  return Object.values(nodes)
    .filter((child) => child.parentId === node.id)
    .map((child) => child.id);
}

// Flattens the tree into the exact top-to-bottom order currently rendered on
// screen, only descending into folders that are expanded.
export function flattenVisibleTree(rootIds: string[], nodes: Record<string, ProductNode>): string[] {
  const result: string[] = [];

  const visit = (id: string) => {
    const node = nodes[id];
    if (!node) return;
    result.push(id);
    if (node.type === 'folder' && node.expanded) {
      getVisibleChildren(node, nodes).forEach(visit);
    }
  };

  rootIds.forEach(visit);
  return result;
}
