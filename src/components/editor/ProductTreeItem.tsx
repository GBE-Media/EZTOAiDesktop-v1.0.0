import { useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, Package, Check, MoreHorizontal, Pencil, Trash2, FolderPlus, PackagePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ProductNode } from '@/types/product';
import { useProductStore } from '@/store/productStore';
import { useEditorStore } from '@/store/editorStore';
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
}

export function ProductTreeItem({ node, depth, onEdit, onNewFolder, onNewProduct }: ProductTreeItemProps) {
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

  // Use active document to show per-PDF measurement counts
  const activeDocument = useEditorStore((state) => state.activeDocument);
  
  const isActive = activeProductId === node.id;
  const isSelected = selectedNodeId === node.id;
  const derivedChildren = node.type === 'folder' && node.children.length === 0
    ? Object.values(nodes)
        .filter((child) => child.parentId === node.id)
        .map((child) => child.id)
    : node.children;
  const hasChildren = node.type === 'folder' && derivedChildren.length > 0;
  // Only show measurement count if a document is active, and filter by document
  const measurementCount = activeDocument && node.type === 'product'
    ? (node.measurements || []).filter((m) => m.documentId === activeDocument).length
    : 0;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedNode(node.id);
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.type === 'product') {
      setActiveProduct(isActive ? null : node.id);
    } else {
      toggleExpanded(node.id);
    }
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleExpanded(node.id);
  };

  const handleRenameSubmit = () => {
    if (renameValue.trim() && renameValue !== node.name) {
      renameNode(node.id, renameValue.trim());
    }
    setIsRenaming(false);
  };

  const handleDelete = () => {
    if (confirm(`Delete "${node.name}"${hasChildren ? ' and all its contents' : ''}?`)) {
      deleteNode(node.id);
    }
  };

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
          <ContextMenuSeparator />
        </>
      )}
      {node.type === 'product' && (
        <>
          <ContextMenuItem onClick={() => setActiveProduct(isActive ? null : node.id)}>
            <Check className={cn('w-4 h-4 mr-2', !isActive && 'opacity-0')} />
            {isActive ? 'Deactivate' : 'Set as Active'}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      )}
      <ContextMenuItem onClick={() => {
        setIsRenaming(true);
        setRenameValue(node.name);
      }}>
        <Pencil className="w-4 h-4 mr-2" />
        Rename
      </ContextMenuItem>
      <ContextMenuItem onClick={handleDelete} className="text-destructive">
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
            ) : (
              <Package className={cn('w-4 h-4', isActive ? 'text-status-success' : 'text-primary')} />
            )}

            {/* Name */}
            {isRenaming ? (
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={handleRenameSubmit}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRenameSubmit();
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
                    <DropdownMenuSeparator />
                  </>
                )}
                {node.type === 'product' && (
                  <>
                    <DropdownMenuItem onClick={() => setActiveProduct(isActive ? null : node.id)}>
                      <Check className={cn('w-4 h-4 mr-2', !isActive && 'opacity-0')} />
                      {isActive ? 'Deactivate' : 'Set as Active'}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => {
                  setIsRenaming(true);
                  setRenameValue(node.name);
                }}>
                  <Pencil className="w-4 h-4 mr-2" />
                  Rename
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleDelete} className="text-destructive">
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
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
