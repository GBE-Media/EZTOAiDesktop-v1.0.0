import { useEffect, useState } from 'react';
import { Boxes, Folder, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProductStore } from '@/store/productStore';
import { useCatalogSync } from '@/components/catalog/CatalogSyncProvider';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface NewProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'folder' | 'product' | 'assembly';
  parentId: string | null;
}

export function NewProductDialog({ open, onOpenChange, type, parentId }: NewProductDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const { user } = useAuth();
  const { queueMutation } = useCatalogSync();
  const { nodes, setSelectedNode, setActiveProduct } = useProductStore();
  const parentNode = parentId ? nodes[parentId] : null;
  const parentPath = parentNode?.categoryPath || '';

  useEffect(() => {
    if (open) setName('');
  }, [open]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !user) return;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    setSaving(true);
    try {
      if (type === 'folder') {
        const path = parentPath ? `${parentPath}/${name.trim()}` : name.trim();
        await queueMutation('product_categories', 'insert', {
          id,
          user_id: user.id,
          path,
          sort_order: 0,
          created_at: now,
          updated_at: now,
        });
      } else if (type === 'product') {
        await queueMutation('product_catalog', 'insert', {
          id,
          user_id: user.id,
          name: name.trim(),
          description: '',
          category: parentPath || null,
          unit_of_measure: 'each',
          unit_price: 0,
          labor_cost: 0,
          material_cost: 0,
          supplier: null,
          sku: null,
          notes: null,
          created_at: now,
          updated_at: now,
          organization_id: null,
          is_org_catalog: false,
        });
        setActiveProduct(id);
      } else {
        await queueMutation('assemblies', 'insert', {
          id,
          user_id: user.id,
          name: name.trim(),
          description: '',
          category: parentPath || null,
          unit_of_measure: 'each',
          sku: null,
          notes: null,
          created_at: now,
          updated_at: now,
        });
        setActiveProduct(id);
      }
      setSelectedNode(id);
      onOpenChange(false);
      toast.success(`${type === 'folder' ? 'Category' : type === 'product' ? 'Product' : 'Assembly'} created`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to create catalog item');
    } finally {
      setSaving(false);
    }
  };

  const label = type === 'folder' ? 'Category' : type === 'product' ? 'Product' : 'Assembly';
  const Icon = type === 'folder' ? Folder : type === 'product' ? Package : Boxes;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="w-5 h-5 text-primary" />
            New {label}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {parentPath && (
              <div className="text-xs text-muted-foreground">
                Creating in: <span className="font-medium">{parentPath}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="catalog-name">Name</Label>
              <Input
                id="catalog-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={type === 'folder' ? 'e.g., Lighting/Interior' : `New ${label.toLowerCase()}`}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? 'Saving…' : `Create ${label}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
