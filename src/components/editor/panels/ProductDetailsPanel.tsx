import { useState } from 'react';
import { Plus, Trash2, Ruler, Box, Hash, Package, Unlink } from 'lucide-react';
import { useProductStore } from '@/store/productStore';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

const measurementTypeIcons: Record<string, any> = {
  length: Ruler,
  area: Box,
  count: Hash,
};

export function ProductDetailsPanel() {
  const [newComponentName, setNewComponentName] = useState('');
  const [newComponentQty, setNewComponentQty] = useState('1');
  const [newComponentUnit, setNewComponentUnit] = useState('each');

  const {
    nodes,
    selectedNodeId,
    updateProductDescription,
    updateProductUnitOfMeasure,
    addComponent,
    deleteComponent,
    unlinkMeasurement,
    setActiveProduct,
    activeProductId,
  } = useProductStore();

  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : null;
  const activeDocument = useEditorStore((state) => state.activeDocument);

  if (!selectedNode) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <Package className="w-10 h-10 text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground">Select a product to view details</p>
      </div>
    );
  }

  if (selectedNode.type === 'folder') {
    return (
      <div className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <Package className="w-5 h-5 text-yellow-500" />
          <h3 className="font-medium">{selectedNode.name}</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Folder containing {selectedNode.children.length} item(s)
        </p>
      </div>
    );
  }

  const isActive = activeProductId === selectedNode.id;
  const components = selectedNode.components || [];
  const measurements = (selectedNode.measurements || []).filter(
    (m) => activeDocument && m.documentId === activeDocument
  );

  // Calculate totals
  const totals = {
    length: measurements.filter(m => m.type === 'length').reduce((sum, m) => sum + m.value, 0),
    area: measurements.filter(m => m.type === 'area').reduce((sum, m) => sum + m.value, 0),
    count: measurements.filter(m => m.type === 'count').reduce((sum, m) => sum + m.value, 0),
  };

  const handleAddComponent = () => {
    if (!newComponentName.trim()) return;
    
    addComponent(selectedNode.id, {
      name: newComponentName.trim(),
      quantity: parseFloat(newComponentQty) || 1,
      unit: newComponentUnit,
    });
    
    setNewComponentName('');
    setNewComponentQty('1');
    setNewComponentUnit('each');
  };

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package className={cn('w-5 h-5', isActive ? 'text-status-success' : 'text-primary')} />
            <h3 className="font-medium">{selectedNode.name}</h3>
          </div>
          <Button
            variant={isActive ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setActiveProduct(isActive ? null : selectedNode.id)}
          >
            {isActive ? 'Active' : 'Set Active'}
          </Button>
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label className="text-xs">Description</Label>
          <Textarea
            placeholder="Product description..."
            value={selectedNode.description || ''}
            onChange={(e) => updateProductDescription(selectedNode.id, e.target.value)}
            className="text-xs min-h-[60px] resize-none"
          />
        </div>

        {/* Unit of Measure */}
        <div className="space-y-1.5">
          <Label className="text-xs">Unit of Measure</Label>
          <Select
            value={selectedNode.unitOfMeasure || 'each'}
            onValueChange={(value: any) => updateProductUnitOfMeasure(selectedNode.id, value)}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="each">Each</SelectItem>
              <SelectItem value="length">Linear (ft)</SelectItem>
              <SelectItem value="area">Area (sf)</SelectItem>
              <SelectItem value="count">Count</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Components */}
        <div className="space-y-2">
          <Label className="text-xs">Components</Label>
          
          {components.length > 0 && (
            <div className="space-y-1">
              {components.map((comp) => (
                <div
                  key={comp.id}
                  className="flex items-center gap-2 px-2 py-1.5 bg-secondary rounded text-xs"
                >
                  <span className="flex-1 truncate">{comp.name}</span>
                  <span className="text-muted-foreground">
                    {comp.quantity} {comp.unit}
                  </span>
                  <button
                    onClick={() => deleteComponent(selectedNode.id, comp.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Add component form */}
          <div className="flex gap-1">
            <Input
              placeholder="Component name"
              value={newComponentName}
              onChange={(e) => setNewComponentName(e.target.value)}
              className="flex-1 h-7 text-xs"
              onKeyDown={(e) => e.key === 'Enter' && handleAddComponent()}
            />
            <Input
              type="number"
              value={newComponentQty}
              onChange={(e) => setNewComponentQty(e.target.value)}
              className="w-14 h-7 text-xs"
              min="0"
              step="0.1"
            />
            <Select value={newComponentUnit} onValueChange={setNewComponentUnit}>
              <SelectTrigger className="w-16 h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="each">ea</SelectItem>
                <SelectItem value="ft">ft</SelectItem>
                <SelectItem value="lf">LF</SelectItem>
                <SelectItem value="sf">SF</SelectItem>
                <SelectItem value="in">in</SelectItem>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={handleAddComponent}
              disabled={!newComponentName.trim()}
            >
              <Plus className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>

        {/* Linked Measurements */}
        <div className="space-y-2">
          <Label className="text-xs">Linked Measurements ({measurements.length})</Label>
          
          {measurements.length > 0 ? (
            <>
              <div className="space-y-1">
                {measurements.slice(0, 5).map((m) => {
                  const Icon = measurementTypeIcons[m.type] || Ruler;
                  const handleUnlink = () => {
                    // Delete the canvas markup first (this will cascade and handle renumbering)
                    const canvasStore = useCanvasStore.getState();
                    canvasStore.deleteMarkupFromDocument(m.documentId, m.page, m.markupId);
                    // The cascade in deleteMarkupFromDocument will handle unlinking from product store
                    // But since we're using deleteMarkupFromDocument which doesn't auto-unlink, we do it manually
                    unlinkMeasurement(selectedNode.id, m.id);
                  };
                  
                  return (
                    <div
                      key={m.id}
                      className="flex items-center gap-2 px-2 py-1.5 bg-secondary rounded text-xs"
                    >
                      <Icon className="w-3 h-3 text-muted-foreground" />
                      <span className="flex-1">
                        {m.type === 'count' ? `#${m.value.toFixed(0)}` : `${m.value.toFixed(2)} ${m.unit}`}
                      </span>
                      <span className="text-muted-foreground">
                        p.{m.page}
                      </span>
                      <button
                        onClick={handleUnlink}
                        className="text-muted-foreground hover:text-destructive"
                        title="Unlink and remove measurement"
                      >
                        <Unlink className="w-3 h-3" />
                      </button>
                    </div>
                  );
                })}
                {measurements.length > 5 && (
                  <p className="text-xs text-muted-foreground text-center py-1">
                    +{measurements.length - 5} more measurements
                  </p>
                )}
              </div>

              {/* Totals */}
              <div className="pt-2 border-t border-panel-border space-y-1">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Totals</p>
                {totals.length > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <Ruler className="w-3 h-3 text-primary" />
                    <span>Length:</span>
                    <span className="font-mono">{totals.length.toFixed(2)} ft</span>
                  </div>
                )}
                {totals.area > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <Box className="w-3 h-3 text-primary" />
                    <span>Area:</span>
                    <span className="font-mono">{totals.area.toFixed(2)} sf</span>
                  </div>
                )}
                {totals.count > 0 && (
                  <div className="flex items-center gap-2 text-xs">
                    <Hash className="w-3 h-3 text-primary" />
                    <span>Count:</span>
                    <span className="font-mono">{totals.count}</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {isActive 
                ? 'Take measurements in the document to link them here'
                : 'Set as active product, then take measurements'}
            </p>
          )}
        </div>
      </div>
    </ScrollArea>
  );
}
