import { describe, expect, it } from 'vitest';
import { catalogSnapshotToProductTree } from './catalogAdapter';
import type { CatalogSnapshot } from '@/types/catalog';
import type { ProductNode } from '@/types/product';

const snapshot: CatalogSnapshot = {
  categories: [
    {
      id: 'category-lighting',
      user_id: 'user-1',
      path: 'Lighting/Interior',
      sort_order: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  products: [
    {
      id: 'product-1',
      user_id: 'user-1',
      name: 'Fixture',
      description: null,
      category: 'Lighting/Interior',
      unit_of_measure: 'each',
      unit_price: 50,
      labor_cost: 25,
      material_cost: 25,
      supplier: null,
      sku: null,
      notes: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      organization_id: 'org-1',
      is_org_catalog: true,
    },
  ],
  assemblies: [
    {
      id: 'assembly-1',
      user_id: 'user-1',
      name: 'Fixture install',
      description: null,
      category: 'Lighting/Interior',
      unit_of_measure: 'each',
      sku: null,
      notes: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
  ],
  components: [
    {
      id: 'component-1',
      assembly_id: 'assembly-1',
      component_type: 'product',
      catalog_product_id: 'product-1',
      description: null,
      quantity: 2,
      unit_of_measure: 'each',
      labor_rate: 0,
      sort_order: 0,
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
};

describe('catalogSnapshotToProductTree', () => {
  it('builds category paths and exposes products and assemblies', () => {
    const result = catalogSnapshotToProductTree(snapshot);

    expect(result.nodes['product-1'].parentId).toBe('category-lighting');
    expect(result.nodes['assembly-1'].type).toBe('assembly');
    expect(result.nodes['assembly-1'].components?.[0].name).toBe('Fixture');
    expect(result.nodes['product-1'].readOnly).toBe(true);
  });

  it('preserves project measurement links during catalog refresh', () => {
    const previous: Record<string, ProductNode> = {
      'product-1': {
        id: 'product-1',
        name: 'Old name',
        type: 'product',
        parentId: null,
        children: [],
        expanded: false,
        measurements: [
          {
            id: 'measurement-1',
            markupId: 'markup-1',
            documentId: 'document-1',
            page: 1,
            type: 'count',
            value: 1,
            unit: 'ea',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
    };

    const result = catalogSnapshotToProductTree(snapshot, previous);
    expect(result.nodes['product-1'].measurements).toEqual(previous['product-1'].measurements);
  });
});
