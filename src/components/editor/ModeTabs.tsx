import { FileText, Package, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProductStore } from '@/store/productStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { CountMarkerMarkup } from '@/types/markup';

interface ModeTabsProps {
  mode: 'documents' | 'products';
  onModeChange: (mode: 'documents' | 'products') => void;
}

export function ModeTabs({ mode, onModeChange }: ModeTabsProps) {
  const { activeProductId, nodes } = useProductStore();
  const activeProduct = activeProductId ? nodes[activeProductId] : null;
  
  // Get count and selection info from canvas store
  const { pdfDocuments, activeDocId, selectedMarkupIds } = useCanvasStore();
  const { activeDocument } = useEditorStore();
  
  // Get all count markers in the active document
  const allCountMarkers: CountMarkerMarkup[] = (() => {
    if (!activeDocId || !pdfDocuments[activeDocId]) return [];
    const docData = pdfDocuments[activeDocId];
    const markers: CountMarkerMarkup[] = [];
    Object.values(docData.markupsByPage).forEach((pageMarkups) => {
      pageMarkups.forEach((m) => {
        if (m.type === 'count-marker') {
          markers.push(m as CountMarkerMarkup);
        }
      });
    });
    return markers;
  })();
  
  const totalCount = allCountMarkers.length;
  
  // Find if any selected markup is a count marker and get its groupId
  const selectedGroupId = (() => {
    if (selectedMarkupIds.length === 0) return null;
    const selectedCountMarker = allCountMarkers.find((m) => selectedMarkupIds.includes(m.id));
    return selectedCountMarker?.groupId || null;
  })();
  
  // Count markers in the selected group
  const selectedGroupCount = selectedGroupId
    ? allCountMarkers.filter((m) => m.groupId === selectedGroupId).length
    : 0;

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

      {/* Count indicator */}
      {activeDocument && totalCount > 0 && (
        <div className="ml-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Hash className="w-3.5 h-3.5" />
          {selectedGroupId ? (
            // Show selected group count / total
            <span className="font-medium">
              <span className="text-foreground">{selectedGroupCount}</span>
              <span className="mx-1">/</span>
              <span>{totalCount}</span>
            </span>
          ) : (
            // Show total count
            <span className="font-medium">{totalCount}</span>
          )}
        </div>
      )}

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
