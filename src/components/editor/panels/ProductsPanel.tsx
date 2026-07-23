import { useMemo, useRef, useState } from 'react';
import { Search, FolderPlus, PackagePlus, Package, Upload, Loader2, RefreshCw, Boxes, WifiOff } from 'lucide-react';
import { ExportProductsDialog } from '../dialogs/ExportProductsDialog';
import { useProductStore } from '@/store/productStore';
import { useEditorStore } from '@/store/editorStore';
import { ProductTreeItem } from '../ProductTreeItem';
import { NewProductDialog } from '../dialogs/NewProductDialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useProductSync } from '@/hooks/useProductSync';
import { useAuth } from '@/hooks/useAuth';
import { useCatalogSync } from '@/components/catalog/CatalogSyncProvider';
import { flattenVisibleTree, getVisibleChildren } from '@/lib/productTree';
import type { ProductNode } from '@/types/product';

export function ProductsPanel() {
  const [searchQuery, setSearchQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogType, setDialogType] = useState<'folder' | 'product' | 'assembly'>('folder');
  const [dialogParentId, setDialogParentId] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const treeContainerRef = useRef<HTMLDivElement>(null);

  const {
    nodes,
    rootIds,
    selectedNodeId,
    activeProductId,
    setSelectedNode,
    setActiveProduct,
    toggleExpanded,
  } = useProductStore();
  const { documents, activeDocument } = useEditorStore();
  const activeDocName = activeDocument
    ? documents.find((d) => d.id === activeDocument)?.name || 'Unknown Document'
    : null;
  const { isLoading, error } = useProductSync();
  const { refreshCatalog, isSyncing, isOnline, pendingCount, lastSyncAt } = useCatalogSync();
  const { user } = useAuth();

  const handleNewFolder = (parentId: string | null) => {
    setDialogType('folder');
    setDialogParentId(parentId);
    setDialogOpen(true);
  };

  const handleNewProduct = (parentId: string | null) => {
    setDialogType('product');
    setDialogParentId(parentId);
    setDialogOpen(true);
  };

  const handleNewAssembly = (parentId: string | null) => {
    setDialogType('assembly');
    setDialogParentId(parentId);
    setDialogOpen(true);
  };

  const handleEdit = (node: ProductNode) => {
    setSelectedNode(node.id);
  };

  // Filter nodes by search query
  const filterNodes = (nodeIds: string[]): string[] => {
    if (!searchQuery.trim()) return nodeIds;
    
    const matchesSearch = (nodeId: string): boolean => {
      const node = nodes[nodeId];
      if (!node) return false;
      
      const nameMatches = node.name.toLowerCase().includes(searchQuery.toLowerCase());
      const childMatches = node.children.some(matchesSearch);
      
      return nameMatches || childMatches;
    };

    return nodeIds.filter(matchesSearch);
  };

  const filteredRootIds = filterNodes(rootIds);

  // Exact top-to-bottom order of rows currently rendered, respecting expand
  // state, so arrow keys can walk it the same way the eye does.
  const visibleIds = useMemo(
    () => flattenVisibleTree(filteredRootIds, nodes),
    [filteredRootIds, nodes],
  );

  const revealNode = (id: string) => {
    requestAnimationFrame(() => {
      treeContainerRef.current
        ?.querySelector<HTMLElement>(`[data-node-id="${id}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  };

  const selectAndReveal = (id: string) => {
    setSelectedNode(id);
    revealNode(id);
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (!visibleIds.length) return;

    const currentIndex = selectedNodeId ? visibleIds.indexOf(selectedNodeId) : -1;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const nextIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, visibleIds.length - 1);
        selectAndReveal(visibleIds[nextIndex]);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prevIndex = currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0);
        selectAndReveal(visibleIds[prevIndex]);
        break;
      }
      case 'ArrowRight': {
        if (currentIndex < 0) break;
        e.preventDefault();
        const node = nodes[visibleIds[currentIndex]];
        if (!node || node.type !== 'folder') break;
        if (!node.expanded) {
          toggleExpanded(node.id);
        } else {
          const children = getVisibleChildren(node, nodes);
          if (children[0]) selectAndReveal(children[0]);
        }
        break;
      }
      case 'ArrowLeft': {
        if (currentIndex < 0) break;
        e.preventDefault();
        const node = nodes[visibleIds[currentIndex]];
        if (!node) break;
        if (node.type === 'folder' && node.expanded) {
          toggleExpanded(node.id);
        } else if (node.parentId) {
          selectAndReveal(node.parentId);
        }
        break;
      }
      case 'Enter': {
        if (currentIndex < 0) break;
        e.preventDefault();
        const node = nodes[visibleIds[currentIndex]];
        if (!node) break;
        if (node.type === 'folder') {
          toggleExpanded(node.id);
        } else {
          setActiveProduct(activeProductId === node.id ? null : node.id);
        }
        break;
      }
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search and actions */}
      <div className="p-2 border-b border-panel-border space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            placeholder="Search products..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-7 h-7 text-xs"
          />
        </div>

        <div className="text-[11px] text-muted-foreground">
          {activeDocName ? `Showing counts for: ${activeDocName}` : 'No document active'}
        </div>
        
        <div className="flex gap-1">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-7 text-xs"
            onClick={() => handleNewFolder(null)}
          >
            <FolderPlus className="w-3.5 h-3.5 mr-1" />
            Category
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-7 text-xs"
            onClick={() => handleNewProduct(null)}
          >
            <PackagePlus className="w-3.5 h-3.5 mr-1" />
            Product
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 h-7 text-xs"
            onClick={() => handleNewAssembly(null)}
          >
            <Boxes className="w-3.5 h-3.5 mr-1" />
            Assembly
          </Button>
        </div>
        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span className="truncate">
            {!isOnline ? (
              <><WifiOff className="inline w-3 h-3 mr-1" />Offline</>
            ) : pendingCount ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} pending` :
              lastSyncAt ? `Synced ${new Date(lastSyncAt).toLocaleTimeString()}` : 'Not synced'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            disabled={isSyncing || !user}
            onClick={() => void refreshCatalog()}
            title="Refresh Catalog"
          >
            <RefreshCw className={`w-3 h-3 mr-1 ${isSyncing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Tree view */}
      <ScrollArea className="flex-1 min-h-0">
        <div
          ref={treeContainerRef}
          role="tree"
          tabIndex={0}
          className="py-1 outline-none"
          onKeyDown={handleTreeKeyDown}
          onClickCapture={() => treeContainerRef.current?.focus()}
        >
          {isLoading ? (
            <div className="flex flex-col items-center justify-center py-8 px-4">
              <Loader2 className="w-6 h-6 text-muted-foreground animate-spin mb-2" />
              <p className="text-xs text-muted-foreground">Loading products...</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <p className="text-sm text-destructive mb-1">Failed to load products</p>
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          ) : !user ? (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <Package className="w-10 h-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">Sign in to save products</p>
              <p className="text-xs text-muted-foreground/70">
                Your products will sync across devices
              </p>
            </div>
          ) : filteredRootIds.length > 0 ? (
            filteredRootIds.map((nodeId) => {
              const node = nodes[nodeId];
              if (!node) return null;
              return (
                <ProductTreeItem
                  key={nodeId}
                  node={node}
                  depth={0}
                  onEdit={handleEdit}
                  onNewFolder={handleNewFolder}
                  onNewProduct={handleNewProduct}
                  onNewAssembly={handleNewAssembly}
                />
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <Package className="w-10 h-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No products yet</p>
              <p className="text-xs text-muted-foreground/70 mb-4">
                Create categories, products, and assemblies to organize your takeoff
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleNewFolder(null)}
                >
                  <FolderPlus className="w-3.5 h-3.5 mr-1" />
                  New Category
                </Button>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer with Export button */}
      <div className="p-2 border-t border-panel-border">
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7 text-xs"
          onClick={() => setExportDialogOpen(true)}
        >
          <Upload className="w-3.5 h-3.5 mr-1" />
          Export Products
        </Button>
      </div>

      {/* Dialogs */}
      <NewProductDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        type={dialogType}
        parentId={dialogParentId}
      />
      <ExportProductsDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
      />
    </div>
  );
}
