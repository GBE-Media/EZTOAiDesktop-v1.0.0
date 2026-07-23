import { useCatalogSync } from '@/components/catalog/CatalogSyncProvider';

// Compatibility wrapper for existing product and AI panels. Synchronization is
// owned by one provider, so mounting this hook in multiple panels is harmless.
export function useProductSync() {
  const { isLoading, isSyncing, error, refreshCatalog } = useCatalogSync();
  return { isLoading, isSyncing, error, refreshCatalog };
}
