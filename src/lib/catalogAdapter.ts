import type { CatalogSnapshot } from '@/types/catalog';
import type { ProductComponent, ProductNode } from '@/types/product';

const virtualCategoryId = (path: string) => `catalog-category:${path}`;

export function catalogSnapshotToProductTree(
  snapshot: CatalogSnapshot,
  previousNodes: Record<string, ProductNode> = {},
): { nodes: Record<string, ProductNode>; rootIds: string[] } {
  const nodes: Record<string, ProductNode> = {};
  const categoryIdByPath = new Map<string, string>();
  const categoryRowByPath = new Map(snapshot.categories.map((category) => [category.path, category]));

  const ensureCategoryPath = (path: string): string | null => {
    const normalized = path.trim().replace(/^\/+|\/+$/g, '');
    if (!normalized) return null;
    if (categoryIdByPath.has(normalized)) return categoryIdByPath.get(normalized)!;

    const parts = normalized.split('/').filter(Boolean);
    let parentId: string | null = null;
    let currentPath = '';

    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      let id = categoryIdByPath.get(currentPath);
      if (!id) {
        const category = categoryRowByPath.get(currentPath);
        id = category?.id ?? virtualCategoryId(currentPath);
        const previous = previousNodes[id];
        nodes[id] = {
          id,
          name: part,
          type: 'folder',
          parentId,
          children: [],
          expanded: previous?.expanded ?? true,
          categoryPath: currentPath,
          updatedAt: category?.updated_at,
          catalogCategoryId: category?.id,
        };
        categoryIdByPath.set(currentPath, id);
        if (parentId && nodes[parentId]) nodes[parentId].children.push(id);
      }
      parentId = id;
    }

    return parentId;
  };

  [...snapshot.categories]
    .sort((a, b) => a.sort_order - b.sort_order || a.path.localeCompare(b.path))
    .forEach((category) => ensureCategoryPath(category.path));

  const componentsByAssembly = new Map<string, ProductComponent[]>();
  for (const component of [...snapshot.components].sort((a, b) => a.sort_order - b.sort_order)) {
    const productName = component.catalog_product_id
      ? snapshot.products.find((product) => product.id === component.catalog_product_id)?.name
      : null;
    const list = componentsByAssembly.get(component.assembly_id) ?? [];
    list.push({
      id: component.id,
      name: productName || component.description || 'Component',
      quantity: Number(component.quantity),
      unit: component.unit_of_measure,
      notes: component.description || undefined,
      componentType: component.component_type,
      catalogProductId: component.catalog_product_id,
      laborRate: Number(component.labor_rate),
      sortOrder: component.sort_order,
    });
    componentsByAssembly.set(component.assembly_id, list);
  }

  for (const product of snapshot.products) {
    const parentId = ensureCategoryPath(product.category || '');
    const previous = previousNodes[product.id];
    nodes[product.id] = {
      id: product.id,
      name: product.name,
      type: 'product',
      parentId,
      children: [],
      expanded: false,
      description: product.description || '',
      unitOfMeasure: product.unit_of_measure,
      components: [],
      measurements: previous?.measurements || [],
      categoryPath: product.category,
      updatedAt: product.updated_at,
      readOnly: product.is_org_catalog,
      unitPrice: Number(product.unit_price),
      laborCost: Number(product.labor_cost),
      materialCost: Number(product.material_cost),
      supplier: product.supplier,
      sku: product.sku,
      notes: product.notes,
    };
    if (parentId && nodes[parentId]) nodes[parentId].children.push(product.id);
  }

  for (const assembly of snapshot.assemblies) {
    const parentId = ensureCategoryPath(assembly.category || '');
    const previous = previousNodes[assembly.id];
    nodes[assembly.id] = {
      id: assembly.id,
      name: assembly.name,
      type: 'assembly',
      parentId,
      children: [],
      expanded: false,
      description: assembly.description || '',
      unitOfMeasure: assembly.unit_of_measure,
      components: componentsByAssembly.get(assembly.id) || [],
      measurements: previous?.measurements || [],
      categoryPath: assembly.category,
      updatedAt: assembly.updated_at,
      sku: assembly.sku,
      notes: assembly.notes,
    };
    if (parentId && nodes[parentId]) nodes[parentId].children.push(assembly.id);
  }

  // Keep project-only snapshots that are no longer present in the shared
  // catalog. They remain read-only and retain measurement history.
  for (const previous of Object.values(previousNodes)) {
    if (
      previous.type !== 'folder' &&
      !nodes[previous.id] &&
      (previous.measurements?.length || 0) > 0
    ) {
      const parentId = previous.parentId?.startsWith('project-snapshots:')
        ? previous.parentId
        : 'project-snapshots:detached';
      if (!nodes[parentId]) {
        nodes[parentId] = previousNodes[parentId] || {
          id: parentId,
          name: 'Project snapshots',
          type: 'folder',
          parentId: null,
          children: [],
          expanded: true,
          readOnly: true,
        };
      }
      nodes[previous.id] = { ...previous, parentId, readOnly: true };
      nodes[parentId].children.push(previous.id);
    }
  }

  const rootIds = Object.values(nodes)
    .filter((node) => !node.parentId)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((node) => node.id);

  for (const node of Object.values(nodes)) {
    if (node.type === 'folder') {
      node.children.sort((a, b) => {
        const left = nodes[a];
        const right = nodes[b];
        if (left.type === 'folder' && right.type !== 'folder') return -1;
        if (left.type !== 'folder' && right.type === 'folder') return 1;
        return left.name.localeCompare(right.name);
      });
    }
  }

  return { nodes, rootIds };
}
