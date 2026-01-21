import { useState } from 'react';
import { Search, FolderPlus, PackagePlus, Package, Upload, Loader2 } from 'lucide-react';
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

export function ProductsPanel() {
  const [searchQuery, setSearchQuery] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogType, setDialogType] = useState<'folder' | 'product'>('folder');
  const [dialogParentId, setDialogParentId] = useState<string | null>(null);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const { nodes, rootIds, setSelectedNode } = useProductStore();
  const { documents, activeDocument } = useEditorStore();
  const activeDocName = activeDocument
    ? documents.find((d) => d.id === activeDocument)?.name || 'Unknown Document'
    : null;
  const { isLoading, error } = useProductSync();
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

  const handleEdit = (node: any) => {
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
            Folder
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
        </div>
      </div>

      {/* Tree view */}
      <ScrollArea className="flex-1">
        <div className="py-1">
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
                />
              );
            })
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
              <Package className="w-10 h-10 text-muted-foreground/50 mb-3" />
              <p className="text-sm text-muted-foreground mb-1">No products yet</p>
              <p className="text-xs text-muted-foreground/70 mb-4">
                Create folders and products to organize your takeoff
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => handleNewFolder(null)}
                >
                  <FolderPlus className="w-3.5 h-3.5 mr-1" />
                  New Folder
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
