import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Package, Check, MoreHorizontal, Pencil, Trash2, FolderPlus, PackagePlus, Boxes } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProductNode } from '@/types/product';
import { useProductStore } from '@/store/productStore';
import { useEditorStore } from '@/store/editorStore';
import { useCatalogStore } from '@/store/catalogStore';
import { useCatalogSync } from '@/components/catalog/CatalogSyncProvider';
import { getVisibleChildren } from '@/lib/productTree';
import { toast } from 'sonner';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface ProductTreeItemProps {
  node: ProductNode;
  depth: number;
  onEdit: (node: ProductNode) => void;
  onNewFolder: (parentId: string | null) => void;
  onNewProduct: (parentId: string | null) => void;
  onNewAssembly: (parentId: string | null) => void;
}

export function ProductTreeItem({ node, depth, onEdit, onNewFolder, onNewProduct, onNewAssembly }: ProductTreeItemProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(node.name);
  
  const {
    nodes,
    activeProductId,
    selectedNodeId,
    setActiveProduct,
    setSelectedNode,
    toggleExpanded,
    renameNode,
    deleteNode,
  } = useProductStore();
  const { products, categories, assemblies } = useCatalogStore();
  const { queueMutation } = useCatalogSync();

  // Use active document to show per-PDF measurement counts
  const activeDocument = useEditorStore((state) => state.activeDocument);
  
  const isActive = activeProductId === node.id;
  const isSelected = selectedNodeId === node.id;
  const derivedChildren = getVisibleChildren(node, nodes);
  const hasChildren = node.type === 'folder' && derivedChildren.length > 0;
  // Only show measurement count if a document is active, and filter by document
  const measurementCount = activeDocument && node.type !== 'folder'
    ? (node.measurements || []).filter((m) => m.documentId === activeDocument).length
    : 0;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedNode(node.id);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.type !== 'folder') {
      setActiveProduct(isActive ? null : node.id);
    } else {
      toggleExpanded(node.id);
    }
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleExpanded(node.id);
  };

  const handleRenameSubmit = async () => {
    if (renameValue.trim() && renameValue !== node.name) {
      try {
        if (node.type === 'product' && products[node.id]) {
          const row = products[node.id];
          await queueMutation('product_catalog', 'update', { ...row, name: renameValue.trim() }, row.updated_at);
        } else if (node.type === 'assembly' && assemblies[node.id]) {
          const row = assemblies[node.id];
          await queueMutation('assemblies', 'update', { ...row, name: renameValue.trim() }, row.updated_at);
        } else if (node.type === 'folder' && node.catalogCategoryId && categories[node.catalogCategoryId]) {
          const row = categories[node.catalogCategoryId];
          const oldPath = row.path;
          const parts = row.path.split('/');
          parts[parts.length - 1] = renameValue.trim();
          const newPath = parts.join('/');
          await queueMutation('product_categories', 'update', { ...row, path: newPath }, row.updated_at);
          for (const category of Object.values(categories)) {
            if (category.id !== row.id && category.path.startsWith(`${oldPath}/`)) {
              await queueMutation(
                'product_categories',
                'update',
                { ...category, path: `${newPath}${category.path.slice(oldPath.length)}` },
                category.updated_at,
              );
            }
          }
          for (const product of Object.values(products)) {
            if (product.category === oldPath || product.category?.startsWith(`${oldPath}/`)) {
              await queueMutation(
                'product_catalog',
                'update',
                { ...product, category: `${newPath}${product.category.slice(oldPath.length)}` },
                product.updated_at,
              );
            }
          }
          for (const assembly of Object.values(assemblies)) {
            if (assembly.category === oldPath || assembly.category?.startsWith(`${oldPath}/`)) {
              await queueMutation(
                'assemblies',
                'update',
                { ...assembly, category: `${newPath}${assembly.category.slice(oldPath.length)}` },
                assembly.updated_at,
              );
            }
          }
        } else {
          renameNode(node.id, renameValue.trim());
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to rename item');
      }
    }
    setIsRenaming(false);
  };

  const handleDelete = async () => {
    if (node.type === 'folder' && hasChildren) {
      toast.error('Move or delete the items in this category before deleting it.');
      return;
    }
    if (confirm(`Delete "${node.name}"?`)) {
      try {
        if (node.type === 'product' && products[node.id]) {
          const row = products[node.id];
          await queueMutation('product_catalog', 'delete', row, row.updated_at);
        } else if (node.type === 'assembly' && assemblies[node.id]) {
          const row = assemblies[node.id];
          await queueMutation('assemblies', 'delete', row, row.updated_at);
        } else if (node.type === 'folder' && node.catalogCategoryId && categories[node.catalogCategoryId]) {
          const row = categories[node.catalogCategoryId];
          await queueMutation('product_categories', 'delete', row, row.updated_at);
        } else {
          deleteNode(node.id);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : 'Unable to delete item');
      }
    }
  };
  const canEdit = !node.readOnly && (node.type !== 'folder' || Boolean(node.catalogCategoryId));

  const contextMenuContent = (
    <>
      {node.type === 'folder' && (
        <>
          <ContextMenuItem onClick={() => onNewFolder(node.id)}>
            <FolderPlus className="w-4 h-4 mr-2" />
            New Folder
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onNewProduct(node.id)}>
            <PackagePlus className="w-4 h-4 mr-2" />
            New Product
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onNewAssembly(node.id)}>
            <Boxes className="w-4 h-4 mr-2" />
            New Assembly
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      {node.type !== 'folder' && (
        <>
          <ContextMenuItem onClick={() => setActiveProduct(isActive ? null : node.id)}>
            <Check className={cn('w-4 h-4 mr-2', !isActive && 'opacity-0')} />
            {isActive ? 'Deactivate' : 'Set as Active'}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem disabled={!canEdit} onClick={() => {
        setIsRenaming(true);
        setRenameValue(node.name);
      }}>
        <Pencil className="w-4 h-4 mr-2" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem disabled={!canEdit} onClick={() => void handleDelete()} className="text-destructive">
        <Trash2 className="w-4 h-4 mr-2" />
        Delete
      </ContextMenuItem>
    </>
  );

  return (
    <div>
      <ContextMenu>
        <ContextMenuTrigger>
          <div
            data-node-id={node.id}
            className={cn(
              'flex items-center gap-1 px-2 py-1 cursor-pointer text-sm transition-colors group',
              isSelected && 'bg-primary/20',
              isActive && 'bg-status-success/10',
              !isSelected && !isActive && 'hover:bg-secondary'
            )}
            style={{ paddingLeft: `${depth * 16 + 8}px` }}
            onClick={handleClick}
            onDoubleClick={handleDoubleClick}
          >
            {/* Expand/collapse toggle */}
            <button
              className={cn(
                'w-4 h-4 flex items-center justify-center',
                !hasChildren && node.type === 'folder' && 'opacity-0'
              )}
              onClick={handleToggleExpand}
            >
              {node.type === 'folder' && hasChildren && (
                node.expanded ? (
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                )
              )}
            </button>

            {/* Icon */}
            {node.type === 'folder' ? (
              node.expanded ? (
                <FolderOpen className="w-4 h-4 text-yellow-500" />
              ) : (
                <Folder className="w-4 h-4 text-yellow-500" />
              )
            ) : node.type === 'assembly' ? (
              <Boxes className={cn('w-4 h-4', isActive ? 'text-status-success' : 'text-violet-400')} />
            ) : (
              <Package className={cn('w-4 h-4', isActive ? 'text-status-success' : 'text-primary')} />
            )}

            {/* Name */}
            {isRenaming ? (
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => void handleRenameSubmit()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleRenameSubmit();
                  if (e.key === 'Escape') setIsRenaming(false);
                }}
                className="flex-1 px-1 py-0 text-sm bg-input border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring"
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className={cn('flex-1 truncate', isActive && 'text-status-success font-medium')}>
                {node.name}
              </span>
            )}

            {/* Active indicator */}
            {isActive && (
              <Check className="w-3.5 h-3.5 text-status-success" />
            )}

            {/* Measurement count badge */}
            {measurementCount > 0 && (
              <span className="px-1.5 py-0.5 text-[10px] bg-muted rounded-full text-muted-foreground">
                {measurementCount}
              </span>
            )}

            {/* More menu */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <button className="w-5 h-5 flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-secondary rounded">
                  <MoreHorizontal className="w-3.5 h-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {node.type === 'folder' && (
                  <>
                    <DropdownMenuItem onClick={() => onNewFolder(node.id)}>
                      <FolderPlus className="w-4 h-4 mr-2" />
                      New Folder
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onNewProduct(node.id)}>
                      <PackagePlus className="w-4 h-4 mr-2" />
                      New Product
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => onNewAssembly(node.id)}>
                      <Boxes className="w-4 h-4 mr-2" />
                      New Assembly
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {node.type !== 'folder' && (
                  <>
                    <DropdownMenuItem onClick={() => setActiveProduct(isActive ? null : node.id)}>
                      <Check className={cn('w-4 h-4 mr-2', !isActive && 'opacity-0')} />
                      {isActive ? 'Deactivate' : 'Set as Active'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem disabled={!canEdit} onClick={() => {
                  setIsRenaming(true);
                  setRenameValue(node.name);
                }}>
                  <Pencil className="w-4 h-4 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!canEdit} onClick={() => void handleDelete()} className="text-destructive">
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          {contextMenuContent}
        </ContextMenuContent>
      </ContextMenu>

      {/* Children */}
      {node.type === 'folder' && node.expanded && (
        <div>
          {derivedChildren.map((childId) => {
            const childNode = nodes[childId];
            if (!childNode) return null;
            return (
              <ProductTreeItem
                key={childId}
                node={childNode}
                depth={depth + 1}
                onEdit={onEdit}
                onNewFolder={onNewFolder}
                onNewProduct={onNewProduct}
                onNewAssembly={onNewAssembly}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
