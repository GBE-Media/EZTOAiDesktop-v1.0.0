import { FileText, Package } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProductStore } from '@/store/productStore';

interface ModeTabsProps {
  mode: 'documents' | 'products';
  onModeChange: (mode: 'documents' | 'products') => void;
}

export function ModeTabs({ mode, onModeChange }: ModeTabsProps) {
  const { activeProductId, nodes } = useProductStore();
  const activeProduct = activeProductId ? nodes[activeProductId] : null;

  return (
    <div className="h-8 bg-panel-header border-b border-panel-border flex items-center px-2">
      <button
        className={cn(
          'flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-sm transition-colors',
          mode === 'documents'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
        )}
        onClick={() => onModeChange('documents')}
      >
        <FileText className="w-3.5 h-3.5" />
        Documents
      </button>
      
      <button
        className={cn(
          'flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-sm transition-colors ml-1',
          mode === 'products'
            ? 'bg-primary text-primary-foreground'
            : 'text-muted-foreground hover:text-foreground hover:bg-secondary'
        )}
        onClick={() => onModeChange('products')}
      >
        <Package className="w-3.5 h-3.5" />
        Products
      </button>

      {/* Active product indicator */}
      {activeProduct && (
        <div className="ml-4 flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Active:</span>
          <span className="px-2 py-0.5 bg-status-success/20 text-status-success rounded font-medium">
            {activeProduct.name}
          </span>
        </div>
      )}
    </div>
  );
}
