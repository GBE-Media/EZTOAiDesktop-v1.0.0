import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { readCatalogSnapshot } from '@/db/catalogDb';
import {
  enqueueCatalogMutation,
  flushCatalogMutations,
  getLastSyncAt,
  getPendingMutationCount,
  syncCatalog,
  CatalogConflictError,
  type CatalogRow,
} from '@/lib/catalogRepository';
import { catalogSnapshotToProductTree } from '@/lib/catalogAdapter';
import { useCatalogStore } from '@/store/catalogStore';
import { useProductStore } from '@/store/productStore';
import type { CatalogMutation, CatalogTable } from '@/types/catalog';

interface CatalogSyncContextValue {
  isLoading: boolean;
  isSyncing: boolean;
  isOnline: boolean;
  error: string | null;
  lastSyncAt: string | null;
  pendingCount: number;
  refreshCatalog: () => Promise<void>;
  queueMutation: (
    table: CatalogTable,
    operation: CatalogMutation['operation'],
    row: CatalogRow,
    knownUpdatedAt?: string | null,
  ) => Promise<void>;
}

const CatalogSyncContext = createContext<CatalogSyncContextValue | null>(null);

export function CatalogSyncProvider({ children }: { children: ReactNode }) {
  const { user, session } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const syncPromiseRef = useRef<Promise<void> | null>(null);

  const hydrate = useCallback(async (userId: string) => {
    const snapshot = await readCatalogSnapshot(userId);
    useCatalogStore.getState().setSnapshot(userId, snapshot);
    const previousNodes = useProductStore.getState().nodes;
    const tree = catalogSnapshotToProductTree(snapshot, previousNodes);
    useProductStore.getState().loadFromDatabase(tree.nodes, tree.rootIds);
  }, []);

  const handleConflict = useCallback((conflict: CatalogConflictError) => {
    toast.warning(conflict.message);
  }, []);

  const runRefresh = useCallback(async () => {
    if (!user || !session?.access_token) return;
    if (syncPromiseRef.current) return syncPromiseRef.current;

    const work = (async () => {
      setIsSyncing(true);
      setError(null);
      try {
        if (!navigator.onLine) {
          await hydrate(user.id);
          setPendingCount(await getPendingMutationCount(user.id));
          return;
        }
        const result = await syncCatalog(user.id, session.access_token, handleConflict);
        useCatalogStore.getState().setSnapshot(user.id, result.snapshot);
        const previousNodes = useProductStore.getState().nodes;
        const tree = catalogSnapshotToProductTree(result.snapshot, previousNodes);
        useProductStore.getState().loadFromDatabase(tree.nodes, tree.rootIds);
        setLastSyncAt(result.lastSyncAt);
        setPendingCount(result.pendingCount);
      } catch (syncError) {
        const message = syncError instanceof Error ? syncError.message : 'Catalog sync failed';
        setError(message);
        await hydrate(user.id);
        setPendingCount(await getPendingMutationCount(user.id));
      } finally {
        setIsSyncing(false);
      }
    })();

    syncPromiseRef.current = work;
    try {
      await work;
    } finally {
      syncPromiseRef.current = null;
    }
  }, [handleConflict, hydrate, session?.access_token, user]);

  useEffect(() => {
    let cancelled = false;
    const initialize = async () => {
      if (!user) {
        useCatalogStore.getState().clearMemory();
        useProductStore.getState().clearStore();
        setLastSyncAt(null);
        setPendingCount(0);
        setIsLoading(false);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        useProductStore.getState().clearStore();
        await hydrate(user.id);
        if (cancelled) return;
        setLastSyncAt(await getLastSyncAt(user.id));
        setPendingCount(await getPendingMutationCount(user.id));
        await runRefresh();
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    void initialize();
    return () => {
      cancelled = true;
    };
  }, [hydrate, runRefresh, user]);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      void runRefresh();
    };
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [runRefresh]);

  const queueMutation = useCallback<CatalogSyncContextValue['queueMutation']>(
    async (table, operation, row, knownUpdatedAt = null) => {
      if (!user) throw new Error('You must be signed in to edit the catalog.');
      await enqueueCatalogMutation(user.id, table, operation, row, knownUpdatedAt);
      await hydrate(user.id);
      setPendingCount(await getPendingMutationCount(user.id));

      if (navigator.onLine) {
        await flushCatalogMutations(user.id, handleConflict);
        await hydrate(user.id);
        setPendingCount(await getPendingMutationCount(user.id));
      }
    },
    [handleConflict, hydrate, user],
  );

  const value = useMemo<CatalogSyncContextValue>(
    () => ({
      isLoading,
      isSyncing,
      isOnline,
      error,
      lastSyncAt,
      pendingCount,
      refreshCatalog: runRefresh,
      queueMutation,
    }),
    [error, isLoading, isOnline, isSyncing, lastSyncAt, pendingCount, queueMutation, runRefresh],
  );

  return <CatalogSyncContext.Provider value={value}>{children}</CatalogSyncContext.Provider>;
}

// The hook intentionally shares the provider module to keep the public sync
// contract colocated; this does not affect Electron's production renderer.
// eslint-disable-next-line react-refresh/only-export-components
export function useCatalogSync() {
  const context = useContext(CatalogSyncContext);
  if (!context) throw new Error('useCatalogSync must be used within CatalogSyncProvider');
  return context;
}
