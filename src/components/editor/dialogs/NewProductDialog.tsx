import { useState, useEffect } from 'react';
import { Folder, Package } from 'lucide-react';
import { useProductStore } from '@/store/productStore';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface NewProductDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: 'folder' | 'product';
  parentId: string | null;
}

export function NewProductDialog({ open, onOpenChange, type, parentId }: NewProductDialogProps) {
  const [name, setName] = useState('');
  const { addFolder, addProduct, nodes, setSelectedNode, setActiveProduct } = useProductStore();

  const parentNode = parentId ? nodes[parentId] : null;

  useEffect(() => {
    if (open) {
      setName('');
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!name.trim()) return;

    let newId: string;
    if (type === 'folder') {
      newId = addFolder(parentId, name.trim());
    } else {
      newId = addProduct(parentId, name.trim());
      // Optionally set the new product as active
      setActiveProduct(newId);
    }
    
    setSelectedNode(newId);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {type === 'folder' ? (
              <Folder className="w-5 h-5 text-yellow-500" />
            ) : (
              <Package className="w-5 h-5 text-primary" />
            )}
            New {type === 'folder' ? 'Folder' : 'Product'}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit}>
          <div className="space-y-4 py-4">
            {parentNode && (
              <div className="text-xs text-muted-foreground">
                Creating in: <span className="font-medium">{parentNode.name}</span>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={type === 'folder' ? 'e.g., Electrical' : 'e.g., EM1 Exit Light'}
                autoFocus
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Create {type === 'folder' ? 'Folder' : 'Product'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
