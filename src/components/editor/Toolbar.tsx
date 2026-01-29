import { 
  MousePointer2, 
  Hand, 
  Type, 
  Highlighter,
  Cloud,
  Square,
  Circle,
  Minus,
  ArrowRight,
  Spline,
  Pentagon,
  MessageSquare,
  Stamp,
  Pencil,
  Eraser,
  Ruler,
  Grid3X3,
  Magnet,
  Undo2,
  Redo2,
  ZoomIn,
  ZoomOut,
  Maximize,
  RotateCw,
  Save,
  SaveAll,
  Printer,
  Hash,
  Bot
} from 'lucide-react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useHistoryStore } from '@/store/historyStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { useSave } from '@/hooks/useSave';
import { printDocument } from '@/lib/pdfPrint';
import type { ToolType } from '@/types/editor';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';

interface ToolButtonProps {
  tool?: ToolType;
  icon: React.ReactNode;
  label: string;
  shortcut?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}

function ToolButton({ tool, icon, label, shortcut, onClick, active, disabled }: ToolButtonProps) {
  const { activeTool, setActiveTool } = useEditorStore();
  const isActive = active ?? (tool ? activeTool === tool : false);

  const handleClick = () => {
    if (disabled) return;
    if (onClick) {
      onClick();
    } else if (tool) {
      setActiveTool(tool);
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`toolbar-button ${isActive ? 'active' : ''} ${disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
          onClick={handleClick}
          disabled={disabled}
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        {label}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function ToolbarDivider() {
  return <div className="w-px h-6 bg-panel-border mx-1" />;
}

export function Toolbar() {
  const { snapEnabled, gridEnabled, toggleSnap, toggleGrid, documents, activeDocument, rotation, setRotation } = useEditorStore();
  const { zoom, setZoom, startCalibration, undo, redo, getPdfDocument, getMarkupsByPage } = useCanvasStore();
  const { past, future } = useHistoryStore();
  const { save, saveAs } = useSave();

  const currentDoc = documents.find(d => d.id === activeDocument);

  const handleSave = async () => {
    await save();
  };

  const handleSaveAs = async () => {
    await saveAs();
  };

  const handlePrint = async () => {
    const pdfDocument = getPdfDocument();
    const markupsByPage = getMarkupsByPage();
    
    if (!pdfDocument) {
      toast.error('No document to print');
      return;
    }
    
    try {
      toast.loading('Preparing document for print...', { id: 'print-pdf' });
      await printDocument(pdfDocument, markupsByPage);
      toast.success('Print dialog opened', { id: 'print-pdf' });
    } catch (error) {
      console.error('Failed to print:', error);
      toast.error('Failed to print document', { id: 'print-pdf' });
    }
  };

  const handleUndo = () => {
    if (past.length > 0) {
      undo();
      toast.success('Undo');
    }
  };

  const handleRedo = () => {
    if (future.length > 0) {
      redo();
      toast.success('Redo');
    }
  };

  const handleZoomIn = () => {
    setZoom(Math.min(zoom + 5, 400));
  };

  const handleZoomOut = () => {
    setZoom(Math.max(zoom - 5, 25));
  };

  const handleFitPage = () => {
    setZoom(100);
  };

  const handleRotate = () => {
    const newRotation = ((rotation || 0) + 90) % 360;
    setRotation(newRotation);
    toast.success(`Rotated to ${newRotation}°`);
  };

  const handleCalibrate = () => {
    startCalibration();
    toast.info('Click two points on the document to set scale');
  };

  return (
    <div className="flex items-center h-10 bg-toolbar border-b border-toolbar-border px-2 gap-0.5">
      {/* File operations */}
      <ToolButton icon={<Save className="w-4 h-4" />} label="Save" shortcut="Ctrl+S" onClick={handleSave} disabled={!currentDoc} />
      <ToolButton icon={<SaveAll className="w-4 h-4" />} label="Save As" shortcut="Ctrl+Shift+S" onClick={handleSaveAs} disabled={!currentDoc} />
      <ToolButton icon={<Printer className="w-4 h-4" />} label="Print" shortcut="Ctrl+P" onClick={handlePrint} />

      <ToolbarDivider />

      {/* Undo/Redo */}
      <ToolButton icon={<Undo2 className="w-4 h-4" />} label="Undo" shortcut="Ctrl+Z" onClick={handleUndo} disabled={past.length === 0} />
      <ToolButton icon={<Redo2 className="w-4 h-4" />} label="Redo" shortcut="Ctrl+Y" onClick={handleRedo} disabled={future.length === 0} />

      <ToolbarDivider />

      {/* Selection tools */}
      <ToolButton tool="select" icon={<MousePointer2 className="w-4 h-4" />} label="Select" shortcut="V" />
      <ToolButton tool="pan" icon={<Hand className="w-4 h-4" />} label="Pan" shortcut="H" />

      <ToolbarDivider />

      {/* Text tools */}
      <ToolButton tool="text" icon={<Type className="w-4 h-4" />} label="Text Box" shortcut="T" />
      <ToolButton tool="highlight" icon={<Highlighter className="w-4 h-4" />} label="Highlight" shortcut="I" />
      <ToolButton tool="callout" icon={<MessageSquare className="w-4 h-4" />} label="Callout" shortcut="O" />

      <ToolbarDivider />

      {/* Shape tools */}
      <ToolButton tool="cloud" icon={<Cloud className="w-4 h-4" />} label="Cloud" shortcut="C" />
      <ToolButton tool="rectangle" icon={<Square className="w-4 h-4" />} label="Rectangle" shortcut="R" />
      <ToolButton tool="ellipse" icon={<Circle className="w-4 h-4" />} label="Ellipse" shortcut="E" />
      <ToolButton tool="polygon" icon={<Pentagon className="w-4 h-4" />} label="Polygon" shortcut="G" />

      <ToolbarDivider />

      {/* Line tools */}
      <ToolButton tool="line" icon={<Minus className="w-4 h-4" />} label="Line" shortcut="L" />
      <ToolButton tool="arrow" icon={<ArrowRight className="w-4 h-4" />} label="Arrow" shortcut="A" />
      <ToolButton tool="polyline" icon={<Spline className="w-4 h-4" />} label="Polyline" shortcut="Y" />

      <ToolbarDivider />

      {/* Drawing tools */}
      <ToolButton tool="freehand" icon={<Pencil className="w-4 h-4" />} label="Freehand" shortcut="P" />
      <ToolButton tool="stamp" icon={<Stamp className="w-4 h-4" />} label="Stamp" shortcut="S" />
      <ToolButton tool="eraser" icon={<Eraser className="w-4 h-4" />} label="Eraser" shortcut="X" />

      <ToolbarDivider />

      {/* Measurement tools */}
      <ToolButton tool="measure-length" icon={<Ruler className="w-4 h-4" />} label="Measure Length" shortcut="M" />
      <ToolButton tool="measure-area" icon={<Grid3X3 className="w-4 h-4" />} label="Measure Area" />
      <ToolButton tool="count" icon={<Hash className="w-4 h-4" />} label="Count" shortcut="N" />
      <ToolButton 
        icon={<Ruler className="w-4 h-4 rotate-45" />} 
        label="Calibrate Scale" 
        onClick={handleCalibrate}
      />

      <ToolbarDivider />

      {/* View controls */}
      <ToolButton 
        icon={<Magnet className="w-4 h-4" />} 
        label="Snap to Objects" 
        shortcut="Shift+S"
        active={snapEnabled}
        onClick={toggleSnap}
      />
      <ToolButton 
        icon={<Grid3X3 className="w-4 h-4" />} 
        label="Show Grid" 
        shortcut="Ctrl+G"
        active={gridEnabled}
        onClick={toggleGrid}
      />

      <ToolbarDivider />

      {/* AI Assistant */}
      <ToolButton 
        icon={<Bot className="w-4 h-4" />} 
        label="AI Assistant" 
        shortcut="Ctrl+Shift+A"
        active={useAIChatStore.getState().isOpen}
        onClick={() => useAIChatStore.getState().toggleDrawer()}
      />

      <div className="flex-1" />

      {/* Zoom controls */}
      <ToolButton icon={<ZoomOut className="w-4 h-4" />} label="Zoom Out" shortcut="Ctrl+-" onClick={handleZoomOut} />
      <div className="px-2 text-xs text-muted-foreground font-mono min-w-[50px] text-center">
        {zoom}%
      </div>
      <ToolButton icon={<ZoomIn className="w-4 h-4" />} label="Zoom In" shortcut="Ctrl++" onClick={handleZoomIn} />
      <ToolButton icon={<Maximize className="w-4 h-4" />} label="Fit Page" shortcut="Ctrl+0" onClick={handleFitPage} />
      <ToolButton icon={<RotateCw className="w-4 h-4" />} label="Rotate View" shortcut="Ctrl+Shift+R" onClick={handleRotate} />
    </div>
  );
}
