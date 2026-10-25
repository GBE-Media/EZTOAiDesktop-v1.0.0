/**
 * Bridge from AI services to the catalog sync (a React context): CatalogSyncProvider registers its
 * queueMutation here so products the AI creates are saved to the user's catalog, not just memory.
 */
import type { CatalogRow } from '@/lib/catalogRepository';
import type { CatalogMutation, CatalogTable } from '@/types/catalog';

export type CatalogPersister = {
  userId: string;
  queue: (table: CatalogTable, operation: CatalogMutation['operation'], row: CatalogRow) => Promise<void>;
};

let current: CatalogPersister | null = null;

export function registerCatalogPersister(persister: CatalogPersister | null): void {
  current = persister;
}

export function getCatalogPersister(): CatalogPersister | null {
  return current;
}
