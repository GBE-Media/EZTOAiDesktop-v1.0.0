import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { CheckCircle2, Package, X } from 'lucide-react';

export function StatusBar() {
  const { documents, activeDocument } = useEditorStore();
  const { pdfDocuments, activeDocId, snapToGrid, scale } = useCanvasStore();
  const { activeProductId, nodes, setActiveProduct } = useProductStore();
  
  const activeProduct = activeProductId ? nodes[activeProductId] : null;
  
  const doc = documents.find((d) => d.id === activeDocument);

  return (
    <div className="h-6 bg-panel-header border-t border-panel-border flex items-center px-2 text-[10px] text-muted-foreground">
      {/* Save status */}
      <div className="flex items-center gap-1">
        <CheckCircle2 className="w-3 h-3 text-status-success" />
        <span>Saved</span>
      </div>

      <div className="w-px h-3 bg-panel-border mx-2" />

      {/* Document info */}
      {doc && (
        <>
          <span>Page {doc.currentPage} of {doc.pages}</span>
          <div className="w-px h-3 bg-panel-border mx-2" />
          <span>{doc.zoom}%</span>
        </>
      )}

      <div className="flex-1" />

      {/* Scale */}
      {scale && (
        <>
          <span className="font-mono">Scale: 1/4" = 1'-0"</span>
          <div className="w-px h-3 bg-panel-border mx-2" />
        </>
      )}

      {/* Active product */}
      {activeProduct && (
        <>
          <div className="flex items-center gap-1 px-2 py-0.5 bg-status-success/20 rounded">
            <Package className="w-3 h-3 text-status-success" />
            <span className="text-status-success font-medium">{activeProduct.name}</span>
            <button 
              onClick={() => setActiveProduct(null)}
              className="ml-1 hover:bg-status-success/30 rounded p-0.5"
              title="Stop linking measurements"
            >
              <X className="w-2.5 h-2.5 text-status-success" />
            </button>
          </div>
          <div className="w-px h-3 bg-panel-border mx-2" />
        </>
      )}

      {/* Snap status */}
      <span className={snapToGrid ? 'text-primary' : ''}>
        Snap: {snapToGrid ? 'On' : 'Off'}
      </span>

      <div className="w-px h-3 bg-panel-border mx-2" />

      {/* Coordinates */}
      <span className="font-mono min-w-[100px]">X: 0.00" Y: 0.00"</span>
    </div>
  );
}
