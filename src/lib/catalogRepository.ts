import Dexie from 'dexie';
import { externalAuthClient } from '@/integrations/external-auth/client';
import {
  catalogDb,
  getCacheKey,
  readCatalogSnapshot,
  toCachedAssembly,
  toCachedCategory,
  toCachedComponent,
  toCachedProduct,
} from '@/db/catalogDb';
import type {
  AssemblyComponent,
  CatalogAssembly,
  CatalogCategory,
  CatalogMutation,
  CatalogProduct,
  CatalogSnapshot,
  CatalogSyncResponse,
  CatalogTable,
} from '@/types/catalog';

const SUPABASE_URL =
  import.meta.env.VITE_EXTERNAL_SUPABASE_URL ||
  import.meta.env.VITE_SUPABASE_URL ||
  'https://einpdmanlpadqyqnvccb.supabase.co';
const CATALOG_SYNC_URL = `${SUPABASE_URL}/functions/v1/catalog-sync`;

export type CatalogRow = CatalogProduct | CatalogCategory | CatalogAssembly | AssemblyComponent;

export class CatalogConflictError extends Error {
  constructor(public readonly table: CatalogTable, public readonly entityId: string) {
    super('This item was changed in the web app. The newer server copy has been loaded.');
    this.name = 'CatalogConflictError';
  }
}

export async function fetchCatalogDelta(
  accessToken: string,
  since: string | null,
): Promise<CatalogSyncResponse> {
  const response = await fetch(CATALOG_SYNC_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(since ? { since } : {}),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Catalog sync failed (${response.status}): ${details || response.statusText}`);
  }

  return response.json() as Promise<CatalogSyncResponse>;
}

export async function applyCatalogDelta(
  userId: string,
  delta: CatalogSyncResponse,
  replaceAll = false,
): Promise<CatalogSnapshot> {
  const changedAssemblyIds = delta.assemblies.map((assembly) => assembly.id);

  await catalogDb.transaction(
    'rw',
    [
      catalogDb.products,
      catalogDb.categories,
      catalogDb.assemblies,
      catalogDb.components,
      catalogDb.syncMeta,
    ],
    async () => {
      if (replaceAll) {
        await Promise.all([
          catalogDb.products.where('cache_user_id').equals(userId).delete(),
          catalogDb.categories.where('cache_user_id').equals(userId).delete(),
          catalogDb.assemblies.where('cache_user_id').equals(userId).delete(),
          catalogDb.components.where('cache_user_id').equals(userId).delete(),
        ]);
      }
      if (delta.products.length) {
        await catalogDb.products.bulkPut(delta.products.map((row) => toCachedProduct(userId, row)));
      }
      if (delta.categories.length) {
        await catalogDb.categories.bulkPut(delta.categories.map((row) => toCachedCategory(userId, row)));
      }
      if (delta.assemblies.length) {
        await catalogDb.assemblies.bulkPut(delta.assemblies.map((row) => toCachedAssembly(userId, row)));
      }

      for (const assemblyId of changedAssemblyIds) {
        await catalogDb.components
          .where('[cache_user_id+assembly_id]')
          .equals([userId, assemblyId])
          .delete();
      }
      if (delta.components.length) {
        await catalogDb.components.bulkPut(delta.components.map((row) => toCachedComponent(userId, row)));
      }

      await catalogDb.products.bulkDelete(
        delta.deletedIds.products.map((id) => getCacheKey(userId, id)),
      );
      await catalogDb.categories.bulkDelete(
        delta.deletedIds.categories.map((id) => getCacheKey(userId, id)),
      );
      await catalogDb.assemblies.bulkDelete(
        delta.deletedIds.assemblies.map((id) => getCacheKey(userId, id)),
      );
      for (const assemblyId of delta.deletedIds.assemblies) {
        await catalogDb.components
          .where('[cache_user_id+assembly_id]')
          .equals([userId, assemblyId])
          .delete();
      }

      await catalogDb.syncMeta.put({ userId, lastSyncAt: delta.serverTime });
    },
  );

  return readCatalogSnapshot(userId);
}

export async function getLastSyncAt(userId: string): Promise<string | null> {
  return (await catalogDb.syncMeta.get(userId))?.lastSyncAt ?? null;
}

export async function getPendingMutationCount(userId: string): Promise<number> {
  return catalogDb.mutations.where('userId').equals(userId).count();
}

function tableFor(table: CatalogTable) {
  switch (table) {
    case 'product_catalog':
      return catalogDb.products;
    case 'product_categories':
      return catalogDb.categories;
    case 'assemblies':
      return catalogDb.assemblies;
    case 'assembly_components':
      return catalogDb.components;
  }
}

function toCachedRow(userId: string, table: CatalogTable, row: CatalogRow) {
  switch (table) {
    case 'product_catalog':
      return toCachedProduct(userId, row as CatalogProduct);
    case 'product_categories':
      return toCachedCategory(userId, row as CatalogCategory);
    case 'assemblies':
      return toCachedAssembly(userId, row as CatalogAssembly);
    case 'assembly_components':
      return toCachedComponent(userId, row as AssemblyComponent);
  }
}

export async function enqueueCatalogMutation(
  userId: string,
  table: CatalogTable,
  operation: CatalogMutation['operation'],
  row: CatalogRow,
  knownUpdatedAt: string | null = null,
): Promise<CatalogMutation> {
  const mutation: CatalogMutation = {
    id: crypto.randomUUID(),
    userId,
    table,
    operation,
    entityId: row.id,
    payload: operation === 'delete' ? null : { ...row },
    knownUpdatedAt,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };
  const mutationTable = tableFor(table);
  const transactionTables =
    mutationTable === catalogDb.components
      ? [catalogDb.components, catalogDb.mutations]
      : [mutationTable, catalogDb.components, catalogDb.mutations];

  await catalogDb.transaction(
    'rw',
    transactionTables,
    async () => {
      if (operation === 'delete') {
        await mutationTable.delete(getCacheKey(userId, row.id));
        if (table === 'assemblies') {
          await catalogDb.components
            .where('[cache_user_id+assembly_id]')
            .equals([userId, row.id])
            .delete();
        }
      } else {
        await mutationTable.put(toCachedRow(userId, table, row) as never);
      }
      await catalogDb.mutations.put(mutation);
    },
  );

  return mutation;
}

async function replaceWithAuthoritativeRow(
  userId: string,
  table: CatalogTable,
  entityId: string,
) {
  const { data, error } = await externalAuthClient.from(table).select('*').eq('id', entityId).maybeSingle();
  if (error) throw error;
  if (data) {
    await tableFor(table).put(toCachedRow(userId, table, data as CatalogRow) as never);
  } else {
    await tableFor(table).delete(getCacheKey(userId, entityId));
  }
}

async function sendMutation(mutation: CatalogMutation): Promise<void> {
  const query = externalAuthClient.from(mutation.table);

  if (mutation.operation === 'insert') {
    const { data, error } = await query.insert(mutation.payload as never).select('*').single();
    if (error) throw error;
    if (data) {
      await tableFor(mutation.table).put(
        toCachedRow(mutation.userId, mutation.table, data as CatalogRow) as never,
      );
    }
    return;
  }

  if (mutation.operation === 'delete') {
    let deleteQuery = query.delete().eq('id', mutation.entityId);
    if (mutation.knownUpdatedAt && mutation.table !== 'assembly_components') {
      deleteQuery = deleteQuery.eq('updated_at', mutation.knownUpdatedAt);
    }
    const { data, error } = await deleteQuery.select('id');
    if (error) throw error;
    if (mutation.knownUpdatedAt && (!data || data.length === 0)) {
      await replaceWithAuthoritativeRow(mutation.userId, mutation.table, mutation.entityId);
      throw new CatalogConflictError(mutation.table, mutation.entityId);
    }
    return;
  }

  let updateQuery = query.update(mutation.payload as never).eq('id', mutation.entityId);
  if (mutation.knownUpdatedAt && mutation.table !== 'assembly_components') {
    updateQuery = updateQuery.eq('updated_at', mutation.knownUpdatedAt);
  }
  const { data, error } = await updateQuery.select('*');
  if (error) throw error;
  if (mutation.knownUpdatedAt && (!data || data.length === 0)) {
    await replaceWithAuthoritativeRow(mutation.userId, mutation.table, mutation.entityId);
    throw new CatalogConflictError(mutation.table, mutation.entityId);
  }
  if (data?.[0]) {
    await tableFor(mutation.table).put(
      toCachedRow(mutation.userId, mutation.table, data[0] as CatalogRow) as never,
    );
  }
}

export async function flushCatalogMutations(
  userId: string,
  onConflict?: (error: CatalogConflictError) => void,
): Promise<void> {
  if (!navigator.onLine) return;

  const mutations = await catalogDb.mutations
    .where('[userId+createdAt]')
    .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
    .sortBy('createdAt');

  for (const mutation of mutations) {
    try {
      await sendMutation(mutation);
      await catalogDb.mutations.delete(mutation.id);
    } catch (error) {
      if (error instanceof CatalogConflictError) {
        await catalogDb.mutations.delete(mutation.id);
        onConflict?.(error);
        continue;
      }

      await catalogDb.mutations.update(mutation.id, {
        attempts: mutation.attempts + 1,
        lastError: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
}

async function reapplyPendingMutations(userId: string): Promise<void> {
  const pending = await catalogDb.mutations
    .where('[userId+createdAt]')
    .between([userId, Dexie.minKey], [userId, Dexie.maxKey])
    .sortBy('createdAt');
  if (!pending.length) return;

  await catalogDb.transaction(
    'rw',
    [catalogDb.products, catalogDb.categories, catalogDb.assemblies, catalogDb.components],
    async () => {
      for (const mutation of pending) {
        const table = tableFor(mutation.table);
        if (mutation.operation === 'delete') {
          await table.delete(getCacheKey(userId, mutation.entityId));
          if (mutation.table === 'assemblies') {
            await catalogDb.components
              .where('[cache_user_id+assembly_id]')
              .equals([userId, mutation.entityId])
              .delete();
          }
        } else if (mutation.payload) {
          await table.put(
            toCachedRow(userId, mutation.table, mutation.payload as unknown as CatalogRow) as never,
          );
        }
      }
    },
  );
}

export async function syncCatalog(
  userId: string,
  accessToken: string,
  onConflict?: (error: CatalogConflictError) => void,
): Promise<{ snapshot: CatalogSnapshot; lastSyncAt: string; pendingCount: number }> {
  await flushCatalogMutations(userId, onConflict);
  const since = await getLastSyncAt(userId);
  const delta = await fetchCatalogDelta(accessToken, since);
  await applyCatalogDelta(userId, delta, since === null);
  await reapplyPendingMutations(userId);
  const snapshot = await readCatalogSnapshot(userId);
  return {
    snapshot,
    lastSyncAt: delta.serverTime,
    pendingCount: await getPendingMutationCount(userId),
  };
}
