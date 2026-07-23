import Dexie, { type EntityTable } from 'dexie';
import type {
  CachedAssemblyComponent,
  CachedCatalogAssembly,
  CachedCatalogCategory,
  CachedCatalogProduct,
  CatalogMutation,
  CatalogSnapshot,
  CatalogSyncMeta,
} from '@/types/catalog';

const cacheKey = (userId: string, id: string) => `${userId}:${id}`;

class CatalogDatabase extends Dexie {
  products!: EntityTable<CachedCatalogProduct, 'cache_key'>;
  categories!: EntityTable<CachedCatalogCategory, 'cache_key'>;
  assemblies!: EntityTable<CachedCatalogAssembly, 'cache_key'>;
  components!: EntityTable<CachedAssemblyComponent, 'cache_key'>;
  syncMeta!: EntityTable<CatalogSyncMeta, 'userId'>;
  mutations!: EntityTable<CatalogMutation, 'id'>;

  constructor() {
    super('bidveraai-catalog');
    this.version(1).stores({
      products: '&cache_key, cache_user_id, id, category, updated_at',
      categories: '&cache_key, cache_user_id, id, path, updated_at',
      assemblies: '&cache_key, cache_user_id, id, category, updated_at',
      components: '&cache_key, cache_user_id, id, assembly_id, [cache_user_id+assembly_id]',
      syncMeta: '&userId',
      mutations: '&id, userId, [userId+createdAt], entityId',
    });
  }
}

export const catalogDb = new CatalogDatabase();

export async function readCatalogSnapshot(userId: string): Promise<CatalogSnapshot> {
  const [products, categories, assemblies, components] = await Promise.all([
    catalogDb.products.where('cache_user_id').equals(userId).toArray(),
    catalogDb.categories.where('cache_user_id').equals(userId).toArray(),
    catalogDb.assemblies.where('cache_user_id').equals(userId).toArray(),
    catalogDb.components.where('cache_user_id').equals(userId).toArray(),
  ]);

  return {
    products: products.map(({ cache_key: _key, cache_user_id: _user, ...row }) => row),
    categories: categories.map(({ cache_key: _key, cache_user_id: _user, ...row }) => row),
    assemblies: assemblies.map(({ cache_key: _key, cache_user_id: _user, ...row }) => row),
    components: components.map(({ cache_key: _key, cache_user_id: _user, ...row }) => row),
  };
}

export const toCachedProduct = (
  userId: string,
  row: CatalogSnapshot['products'][number],
): CachedCatalogProduct => ({
  ...row,
  cache_key: cacheKey(userId, row.id),
  cache_user_id: userId,
});

export const toCachedCategory = (
  userId: string,
  row: CatalogSnapshot['categories'][number],
): CachedCatalogCategory => ({
  ...row,
  cache_key: cacheKey(userId, row.id),
  cache_user_id: userId,
});

export const toCachedAssembly = (
  userId: string,
  row: CatalogSnapshot['assemblies'][number],
): CachedCatalogAssembly => ({
  ...row,
  cache_key: cacheKey(userId, row.id),
  cache_user_id: userId,
});

export const toCachedComponent = (
  userId: string,
  row: CatalogSnapshot['components'][number],
): CachedAssemblyComponent => ({
  ...row,
  cache_key: cacheKey(userId, row.id),
  cache_user_id: userId,
});

export const getCacheKey = cacheKey;
