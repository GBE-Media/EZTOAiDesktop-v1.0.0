import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    },
  });
});
import { catalogDb, readCatalogSnapshot } from '@/db/catalogDb';
import {
  applyCatalogDelta,
  enqueueCatalogMutation,
  getLastSyncAt,
  getPendingMutationCount,
} from './catalogRepository';

const product = {
  id: 'product-1',
  user_id: 'user-1',
  name: 'Fixture',
  description: null,
  category: 'Lighting',
  unit_of_measure: 'each',
  unit_price: 50,
  labor_cost: 25,
  material_cost: 25,
  supplier: null,
  sku: null,
  notes: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  organization_id: null,
  is_org_catalog: false,
};

afterEach(async () => {
  await catalogDb.delete();
  await catalogDb.open();
});

describe('catalog repository', () => {
  it('applies deltas and keeps sync cursors isolated per user', async () => {
    await applyCatalogDelta('user-1', {
      serverTime: '2026-07-23T21:44:14.320Z',
      products: [product],
      categories: [],
      assemblies: [],
      components: [],
      deletedIds: { products: [], assemblies: [], categories: [] },
    });

    expect((await readCatalogSnapshot('user-1')).products).toHaveLength(1);
    expect((await readCatalogSnapshot('user-2')).products).toHaveLength(0);
    expect(await getLastSyncAt('user-1')).toBe('2026-07-23T21:44:14.320Z');
    expect(await getLastSyncAt('user-2')).toBeNull();
  });

  it('replaces changed assembly components and applies deleted IDs', async () => {
    const assembly = {
      id: 'assembly-1',
      user_id: 'user-1',
      name: 'Install',
      description: null,
      category: null,
      unit_of_measure: 'each',
      sku: null,
      notes: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    };
    const component = {
      id: 'component-old',
      assembly_id: assembly.id,
      component_type: 'labor' as const,
      catalog_product_id: null,
      description: 'Old labor',
      quantity: 1,
      unit_of_measure: 'hr',
      labor_rate: 50,
      sort_order: 0,
      created_at: '2026-01-01T00:00:00Z',
    };

    await applyCatalogDelta('user-1', {
      serverTime: '2026-01-01T00:00:00Z',
      products: [product],
      categories: [],
      assemblies: [assembly],
      components: [component],
      deletedIds: { products: [], assemblies: [], categories: [] },
    });
    await applyCatalogDelta('user-1', {
      serverTime: '2026-01-02T00:00:00Z',
      products: [],
      categories: [],
      assemblies: [{ ...assembly, updated_at: '2026-01-02T00:00:00Z' }],
      components: [{ ...component, id: 'component-new', description: 'New labor' }],
      deletedIds: { products: ['product-1'], assemblies: [], categories: [] },
    });

    const result = await readCatalogSnapshot('user-1');
    expect(result.products).toHaveLength(0);
    expect(result.components.map((row) => row.id)).toEqual(['component-new']);
  });

  it('stores optimistic writes and their durable mutation queue together', async () => {
    await enqueueCatalogMutation('user-1', 'product_catalog', 'insert', product);
    expect((await readCatalogSnapshot('user-1')).products[0].id).toBe(product.id);
    expect(await getPendingMutationCount('user-1')).toBe(1);
  });
});
