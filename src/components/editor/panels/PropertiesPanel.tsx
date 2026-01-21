import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { 
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue 
} from '@/components/ui/select';
import { toast } from 'sonner';
import type { CanvasMarkup, MarkupStyle, RectangleMarkup, LineMarkup, PolygonMarkup, TextMarkup } from '@/types/markup';

const colorPresets = [
  '#ef4444', '#f97316', '#eab308', '#22c55e', 
  '#3b82f6', '#8b5cf6', '#ec4899', '#000000'
];

const fontFamilies = ['Arial', 'Helvetica', 'Times New Roman', 'Courier New'];
const lineWidths = [1, 2, 3, 4, 6, 8];

export function PropertiesPanel() {
  const { activeTool, toolProperties, updateToolProperties } = useEditorStore();
  const { 
    pdfDocuments, 
    activeDocId, 
    selectedMarkupIds, 
    defaultStyle, 
    setDefaultStyle, 
    updateMarkup,
    scale,
    scaleUnit,
    startCalibration,
  } = useCanvasStore();

  // Get current document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const currentPage = currentDocData?.currentPage || 1;
  const markupsByPage = currentDocData?.markupsByPage || {};
  const markups = markupsByPage[currentPage] || [];
  
  // Find selected markup(s)
  const selectedMarkups = markups.filter(m => selectedMarkupIds.includes(m.id));
  const hasSelection = selectedMarkups.length > 0;
  const selectedMarkup = selectedMarkups[0]; // Primary selection for single-edit

  // Determine which properties to show based on selection or active tool
  const getPropertyContext = () => {
    if (hasSelection && selectedMarkup) {
      const type = selectedMarkup.type;
      return {
        isText: ['text', 'callout'].includes(type),
        isShape: ['rectangle', 'ellipse', 'polygon', 'cloud', 'highlight'].includes(type),
        isLine: ['line', 'arrow', 'polyline', 'freehand'].includes(type),
        isMeasure: type.startsWith('measurement-'),
        style: selectedMarkup.style,
        label: `Editing: ${type.replace('-', ' ')}`,
      };
    }
    return {
      isText: ['text', 'callout'].includes(activeTool),
      isShape: ['rectangle', 'ellipse', 'polygon', 'cloud'].includes(activeTool),
      isLine: ['line', 'arrow', 'polyline', 'freehand'].includes(activeTool),
      isMeasure: activeTool.startsWith('measure-'),
      style: defaultStyle,
      label: activeTool.replace('-', ' '),
    };
  };

  const ctx = getPropertyContext();

  // Sync property changes to both stores and optionally to selected markup
  const handlePropertyChange = (updates: Partial<MarkupStyle>) => {
    // Update tool properties in editor store (for UI feedback)
    const editorUpdates: Record<string, any> = {};
    if ('strokeColor' in updates) editorUpdates.color = updates.strokeColor;
    if ('fillColor' in updates) editorUpdates.fillColor = updates.fillColor;
    if ('opacity' in updates) editorUpdates.opacity = updates.opacity;
    if ('strokeWidth' in updates) editorUpdates.lineWidth = updates.strokeWidth;
    if ('fontSize' in updates) editorUpdates.fontSize = updates.fontSize;
    if ('fontFamily' in updates) editorUpdates.fontFamily = updates.fontFamily;
    
    if (Object.keys(editorUpdates).length > 0) {
      updateToolProperties(editorUpdates);
    }
    
    // Update default style in canvas store (for new markups)
    setDefaultStyle(updates);
    
    // If markup(s) are selected, update them too
    if (hasSelection) {
      selectedMarkups.forEach(markup => {
        updateMarkup(currentPage, markup.id, {
          style: { ...markup.style, ...updates }
        });
      });
    }
  };

  const handleSaveAsDefault = () => {
    // The current style is already set as default, just confirm to user
    toast.success('Style saved as default');
  };

  const handleResetToDefault = () => {
    const reset: MarkupStyle = {
      strokeColor: '#ef4444',
      fillColor: 'transparent',
      strokeWidth: 2,
      opacity: 100,
      fontSize: 12,
      fontFamily: 'Arial',
    };
    setDefaultStyle(reset);
    updateToolProperties({
      color: reset.strokeColor,
      fillColor: reset.fillColor,
      opacity: reset.opacity,
      lineWidth: reset.strokeWidth,
      fontSize: reset.fontSize,
      fontFamily: reset.fontFamily,
    });
    toast.success('Reset to default style');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto p-3 space-y-4">
        {/* Context indicator */}
        <div className={`rounded px-2 py-1.5 text-xs ${hasSelection ? 'bg-primary/20 border border-primary/30' : 'bg-secondary'}`}>
          <span className="text-muted-foreground">{hasSelection ? 'Selected:' : 'Active Tool:'}</span>
          <span className="ml-2 font-medium capitalize">{ctx.label}</span>
          {hasSelection && selectedMarkups.length > 1 && (
            <span className="ml-1 text-muted-foreground">({selectedMarkups.length} items)</span>
          )}
        </div>

        {/* Color */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Stroke Color</Label>
          <div className="flex flex-wrap gap-1">
            {colorPresets.map((color) => (
              <button
                key={color}
                className={`w-6 h-6 rounded border-2 transition-all ${
                  ctx.style.strokeColor === color 
                    ? 'border-primary scale-110' 
                    : 'border-transparent hover:border-muted-foreground/30'
                }`}
                style={{ backgroundColor: color }}
                onClick={() => handlePropertyChange({ strokeColor: color })}
              />
            ))}
          </div>
          <Input
            type="text"
            value={ctx.style.strokeColor}
            onChange={(e) => handlePropertyChange({ strokeColor: e.target.value })}
            className="h-7 text-xs font-mono bg-secondary border-none"
          />
        </div>

        {/* Fill Color (for shapes) */}
        {ctx.isShape && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Fill Color</Label>
            <div className="flex flex-wrap gap-1">
              <button
                className={`w-6 h-6 rounded border-2 flex items-center justify-center ${
                  ctx.style.fillColor === 'transparent' 
                    ? 'border-primary' 
                    : 'border-transparent'
                }`}
                onClick={() => handlePropertyChange({ fillColor: 'transparent' })}
              >
                <div className="w-4 h-px bg-muted-foreground rotate-45" />
              </button>
              {colorPresets.map((color) => (
                <button
                  key={color}
                  className={`w-6 h-6 rounded border-2 transition-all ${
                    ctx.style.fillColor === color 
                      ? 'border-primary scale-110' 
                      : 'border-transparent hover:border-muted-foreground/30'
                  }`}
                  style={{ backgroundColor: color + '40' }}
                  onClick={() => handlePropertyChange({ fillColor: color })}
                />
              ))}
            </div>
          </div>
        )}

        {/* Opacity */}
        <div className="space-y-2">
          <div className="flex justify-between">
            <Label className="text-xs text-muted-foreground">Opacity</Label>
            <span className="text-xs font-mono">{ctx.style.opacity}%</span>
          </div>
          <Slider
            value={[ctx.style.opacity]}
            onValueChange={([value]) => handlePropertyChange({ opacity: value })}
            min={10}
            max={100}
            step={5}
            className="w-full"
          />
        </div>

        {/* Line Width */}
        {(ctx.isShape || ctx.isLine) && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Line Width</Label>
            <div className="flex gap-1">
              {lineWidths.map((width) => (
                <button
                  key={width}
                  className={`flex-1 h-8 rounded flex items-center justify-center bg-secondary transition-all ${
                    ctx.style.strokeWidth === width 
                      ? 'ring-2 ring-primary' 
                      : 'hover:bg-muted'
                  }`}
                  onClick={() => handlePropertyChange({ strokeWidth: width })}
                >
                  <div 
                    className="bg-foreground rounded-full"
                    style={{ 
                      width: `${Math.min(width * 3, 20)}px`, 
                      height: `${width}px` 
                    }}
                  />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Text properties */}
        {ctx.isText && (
          <>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Font Family</Label>
              <Select
                value={ctx.style.fontFamily || 'Arial'}
                onValueChange={(value) => handlePropertyChange({ fontFamily: value })}
              >
                <SelectTrigger className="h-7 text-xs bg-secondary border-none">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {fontFamilies.map((font) => (
                    <SelectItem key={font} value={font} className="text-xs">
                      {font}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Font Size</Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  value={ctx.style.fontSize || 12}
                  onChange={(e) => handlePropertyChange({ fontSize: Number(e.target.value) })}
                  className="h-7 text-xs bg-secondary border-none flex-1"
                  min={8}
                  max={72}
                />
                <span className="text-xs text-muted-foreground self-center">pt</span>
              </div>
            </div>
          </>
        )}

        {/* Measurement tool info */}
        {ctx.isMeasure && (
          <div className="bg-secondary/50 rounded p-3 space-y-2">
            <div className="text-xs text-muted-foreground">Current Scale</div>
            <div className="text-sm font-mono">
              {scale.toFixed(2)} px/{scaleUnit}
            </div>
            <button 
              className="text-[10px] text-primary hover:underline"
              onClick={() => {
                startCalibration();
                toast.info('Click two points on the document to set scale');
              }}
            >
              Calibrate Scale...
            </button>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div className="p-2 border-t border-panel-border space-y-2">
        <Button 
          variant="secondary" 
          size="sm" 
          className="w-full h-7 text-xs"
          onClick={handleSaveAsDefault}
        >
          Save as Default
        </Button>
        <Button 
          variant="ghost" 
          size="sm" 
          className="w-full h-7 text-xs text-muted-foreground"
          onClick={handleResetToDefault}
        >
          Reset to Default
        </Button>
      </div>
    </div>
  );
}
