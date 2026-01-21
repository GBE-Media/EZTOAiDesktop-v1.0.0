import { useEffect, useRef, useCallback, useState } from 'react';
import { useProductStore } from '@/store/productStore';
import { useAuth } from '@/hooks/useAuth';
import { loadUserProducts, syncProductsToDb } from '@/lib/productApi';
import { externalAuthClient } from '@/integrations/external-auth/client';
import { toast } from 'sonner';

const SYNC_DEBOUNCE_MS = 1000;

export function useProductSync() {
  const { user, session } = useAuth();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { nodes, rootIds, loadFromDatabase, clearStore } = useProductStore();
  
  const syncTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSyncedDataRef = useRef<string>('');
  const isInitialLoadRef = useRef(true);
  const isSyncingRef = useRef(false);

  // Load products from database when user logs in
  useEffect(() => {
    async function loadProducts() {
      if (!session?.access_token) {
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);
        
        const data = await loadUserProducts(session.access_token);
        
        if (data) {
          // Check for localStorage migration
          const localStorageData = localStorage.getItem('product-store');
          const hasLocalData = localStorageData && JSON.parse(localStorageData)?.state?.rootIds?.length > 0;
          const hasDbData = data.rootIds.length > 0;
          
          if (hasLocalData && !hasDbData) {
            // Migrate localStorage data to database with regenerated UUIDs
            const localState = JSON.parse(localStorageData).state;
            
            // Regenerate UUIDs for all nodes to ensure DB compatibility
            const idMap = new Map<string, string>();
            const migratedNodes: Record<string, any> = {};
            
            // First pass: generate new UUIDs for all nodes
            Object.keys(localState.nodes).forEach(oldId => {
              const newId = crypto.randomUUID();
              idMap.set(oldId, newId);
            });
            
            // Second pass: migrate nodes with updated IDs and references
            Object.entries(localState.nodes).forEach(([oldId, node]: [string, any]) => {
              const newId = idMap.get(oldId)!;
              const newParentId = node.parentId ? idMap.get(node.parentId) || null : null;
              const newChildren = node.children.map((childId: string) => idMap.get(childId) || childId);
              
              // Migrate components and measurements with new UUIDs
              const components = (node.components || []).map((c: any) => ({
                ...c,
                id: crypto.randomUUID(),
              }));
              
              const measurements = (node.measurements || []).map((m: any) => ({
                ...m,
                id: crypto.randomUUID(),
              }));
              
              migratedNodes[newId] = {
                ...node,
                id: newId,
                parentId: newParentId,
                children: newChildren,
                components,
                measurements,
              };
            });
            
            // Update root IDs
            const migratedRootIds = localState.rootIds.map((oldId: string) => idMap.get(oldId) || oldId);
            
            loadFromDatabase(migratedNodes, migratedRootIds);
            
            // Sync to database
            const success = await syncProductsToDb(
              session.access_token,
              migratedNodes,
              migratedRootIds
            );
            
            if (success) {
              localStorage.removeItem('product-store');
              toast.success('Your products have been synced to your account');
            }
          } else {
            // Load from database
            loadFromDatabase(data.nodes, data.rootIds);
            
            // Clear localStorage to avoid conflicts
            localStorage.removeItem('product-store');
          }
          
          // Store initial synced data hash
          lastSyncedDataRef.current = JSON.stringify({ nodes: data.nodes, rootIds: data.rootIds });
        }
        
        isInitialLoadRef.current = false;
      } catch (err) {
        console.error('Failed to load products:', err);
        setError('Failed to load products');
      } finally {
        setIsLoading(false);
      }
    }

    loadProducts();
  }, [session?.access_token, loadFromDatabase]);

  // Sync changes to database with debounce
  const syncToDatabase = useCallback(async () => {
    if (!session?.access_token || isInitialLoadRef.current || isSyncingRef.current) {
      return;
    }

    const currentData = JSON.stringify({ nodes, rootIds });
    
    // Skip if data hasn't changed
    if (currentData === lastSyncedDataRef.current) {
      return;
    }

    isSyncingRef.current = true;
    
    try {
      const success = await syncProductsToDb(session.access_token, nodes, rootIds);
      
      if (success) {
        lastSyncedDataRef.current = currentData;
      } else {
        console.error('Failed to sync products');
      }
    } catch (err) {
      console.error('Sync error:', err);
    } finally {
      isSyncingRef.current = false;
    }
  }, [session?.access_token, nodes, rootIds]);

  // Watch for store changes and trigger sync
  useEffect(() => {
    if (isInitialLoadRef.current || !session?.access_token) {
      return;
    }

    // Clear existing timeout
    if (syncTimeoutRef.current) {
      clearTimeout(syncTimeoutRef.current);
    }

    // Debounce sync
    syncTimeoutRef.current = setTimeout(() => {
      syncToDatabase();
    }, SYNC_DEBOUNCE_MS);

    return () => {
      if (syncTimeoutRef.current) {
        clearTimeout(syncTimeoutRef.current);
      }
    };
  }, [nodes, rootIds, syncToDatabase, session?.access_token]);

  // Clear store on logout
  useEffect(() => {
    if (!user && !isLoading) {
      clearStore();
      lastSyncedDataRef.current = '';
      isInitialLoadRef.current = true;
    }
  }, [user, isLoading, clearStore]);

  return { isLoading, error };
}
