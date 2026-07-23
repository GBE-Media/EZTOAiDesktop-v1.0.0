import { getVisibleChildren } from '@/lib/productTree';
import type { ProductNode } from '@/types/product';
import type { CanvasMarkup, CountMarkerMarkup, MeasurementMarkup } from '@/types/markup';

const MAX_MARKUP_LINES = 30;
const MAX_CATALOG_ITEMS = 40;

// Only summarizes the page whose image is actually being sent to the model,
// so the text and the image never describe different pages.
export function summarizeMarkupsForChat(
  markupsByPage: Record<number, CanvasMarkup[]>,
  page: number,
): string {
  const markups = markupsByPage[page] || [];
  if (markups.length === 0) return '';

  const lines: string[] = [];

  const countMarkers = markups.filter((m): m is CountMarkerMarkup => m.type === 'count-marker');
  const countGroups = new Map<string, CountMarkerMarkup[]>();
  countMarkers.forEach((marker) => {
    const key = marker.groupId || 'ungrouped';
    const group = countGroups.get(key);
    if (group) {
      group.push(marker);
    } else {
      countGroups.set(key, [marker]);
    }
  });
  countGroups.forEach((group, groupId) => {
    const label = group[0].label ? ` "${group[0].label}"` : '';
    const productRef = group[0].productId ? ` (linked product: ${group[0].productId})` : '';
    lines.push(`- count-marker${label}: ${group.length} marker(s), group "${groupId}"${productRef}`);
  });

  (['measurement-length', 'measurement-area'] as const).forEach((type) => {
    const items = markups.filter((m): m is MeasurementMarkup => m.type === type);
    if (items.length === 0) return;
    const values = items.map((m) => `${m.scaledValue.toFixed(1)} ${m.unit}`);
    lines.push(`- ${type}: ${items.length} item(s) - ${values.join(', ')}`);
  });

  const handledTypes = new Set(['count-marker', 'measurement-length', 'measurement-area']);
  const otherTypes = Array.from(new Set(markups.map((m) => m.type).filter((t) => !handledTypes.has(t))));
  otherTypes.forEach((type) => {
    const items = markups.filter((m) => m.type === type);
    const labels = items.map((m) => m.label).filter((label): label is string => Boolean(label));
    const shownLabels = labels.slice(0, 5);
    const labelSuffix = shownLabels.length
      ? ` (labels: ${shownLabels.join(', ')}${labels.length > shownLabels.length ? ', ...' : ''})`
      : '';
    lines.push(`- ${type}: ${items.length} item(s)${labelSuffix}`);
  });

  const truncated = lines.length > MAX_MARKUP_LINES;
  const shownLines = lines.slice(0, MAX_MARKUP_LINES);
  if (truncated) {
    shownLines.push(`... and ${lines.length - MAX_MARKUP_LINES} more markup group(s) not shown`);
  }

  return `Markups on page ${page} (${markups.length} total):\n${shownLines.join('\n')}`;
}

// Walks the full product tree regardless of the tree UI's expand/collapse
// state - unlike flattenVisibleTree, a catalog summary must include every
// item, not just the ones currently visible on screen.
export function summarizeCatalogForChat(
  nodes: Record<string, ProductNode>,
  rootIds: string[],
  activeProductId: string | null,
): string {
  const items: Array<{ path: string; node: ProductNode }> = [];

  const visit = (id: string, path: string) => {
    const node = nodes[id];
    if (!node) return;
    if (node.type === 'folder') {
      const childPath = path ? `${path}/${node.name}` : node.name;
      getVisibleChildren(node, nodes).forEach((childId) => visit(childId, childPath));
      return;
    }
    items.push({ path, node });
  };

  rootIds.forEach((id) => visit(id, ''));

  if (items.length === 0) return '';

  const shown = items.slice(0, MAX_CATALOG_ITEMS);
  const lines = shown.map(({ path, node }) => {
    const location = path ? `${path}: ` : '';
    if (node.type === 'assembly') {
      return `- ${location}${node.name} (assembly, ${node.unitOfMeasure || 'each'})`;
    }
    const price = typeof node.unitPrice === 'number'
      ? `$${node.unitPrice.toFixed(2)}/${node.unitOfMeasure || 'each'}`
      : node.unitOfMeasure || 'each';
    return `- ${location}${node.name} (product, ${price})`;
  });

  if (items.length > MAX_CATALOG_ITEMS) {
    lines.push(`... and ${items.length - MAX_CATALOG_ITEMS} more item(s) not shown`);
  }

  const productCount = items.filter((item) => item.node.type === 'product').length;
  const assemblyCount = items.filter((item) => item.node.type === 'assembly').length;
  const activeNode = activeProductId ? nodes[activeProductId] : null;
  const activeLine = activeNode ? `\nCurrently active for takeoff: ${activeNode.name}` : '';

  return `Catalog (${productCount} products, ${assemblyCount} assemblies):\n${lines.join('\n')}${activeLine}`;
}
