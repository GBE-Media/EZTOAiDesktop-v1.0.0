import { useState } from 'react';
import { Ruler, Grid3X3, Box, Hash, Trash2, Download, Settings } from 'lucide-react';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';

const typeIcons: Record<string, React.ReactNode> = {
  length: <Ruler className="w-3 h-3" />,
  area: <Grid3X3 className="w-3 h-3" />,
  volume: <Box className="w-3 h-3" />,
  count: <Hash className="w-3 h-3" />,
};

export function MeasurementsPanel() {
  const { documents, activeDocument } = useEditorStore();
  const { pdfDocuments, activeDocId, scale, scaleUnit } = useCanvasStore();
  const [selectedMeasurements, setSelectedMeasurements] = useState<string[]>([]);

  // Derive values from document data
  const currentDocData = activeDocId ? pdfDocuments[activeDocId] : null;
  const currentPage = currentDocData?.currentPage || 1;
  const markupsByPage = currentDocData?.markupsByPage || {};

  const doc = documents.find((d) => d.id === activeDocument);
  
  // Get measurements from canvas store
  const canvasMarkups = markupsByPage[currentPage] || [];
  const measurementMarkups = canvasMarkups.filter(
    (m) => m.type === 'measurement-length' || m.type === 'measurement-area'
  );
  const measurements = doc?.measurements ?? [];

  const toggleSelection = (id: string, multi: boolean) => {
    if (multi) {
      setSelectedMeasurements((prev) =>
        prev.includes(id) ? prev.filter((m) => m !== id) : [...prev, id]
      );
    } else {
      setSelectedMeasurements([id]);
    }
  };

  // Calculate totals from canvas measurements
  const totals = measurementMarkups.reduce((acc, m: any) => {
    const type = m.type === 'measurement-length' ? 'length' : 'area';
    acc[type] = (acc[type] || 0) + (m.scaledValue || 0);
    return acc;
  }, {} as Record<string, number>);

  // Combine old measurements with new canvas measurements
  const allMeasurements = [
    ...measurements,
    ...measurementMarkups.map((m: any) => ({
      id: m.id,
      type: m.type === 'measurement-length' ? 'length' : 'area',
      label: m.label || `Measurement ${m.id.slice(-4)}`,
      value: m.scaledValue || 0,
      unit: m.unit || scaleUnit,
      page: m.page,
      date: m.createdAt,
    })),
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Scale info */}
      <div className="p-2 border-b border-panel-border">
        <div className="bg-secondary rounded p-2 space-y-1">
          <div className="flex justify-between items-center">
            <span className="text-[10px] text-muted-foreground uppercase">Current Scale</span>
            <button className="text-[10px] text-primary hover:underline flex items-center gap-1">
              <Settings className="w-3 h-3" />
              Calibrate
            </button>
          </div>
          <div className="text-sm font-mono">
            {scale ? `1/4" = 1'-0" (${scale}:1)` : 'Not calibrated'}
          </div>
        </div>
      </div>

      {/* Measurements list */}
      <div className="flex-1 overflow-auto">
        {allMeasurements.length === 0 ? (
          <div className="p-4 text-center text-xs text-muted-foreground">
            <Ruler className="w-8 h-8 mx-auto mb-2 opacity-30" />
            <p>No measurements yet</p>
            <p className="mt-1">Use the measure tools to create measurements</p>
          </div>
        ) : (
          <div className="py-1">
            {allMeasurements.map((measurement) => (
              <div
                key={measurement.id}
                className={`list-item group ${
                  selectedMeasurements.includes(measurement.id) ? 'selected' : ''
                }`}
                onClick={(e) => toggleSelection(measurement.id, e.ctrlKey || e.metaKey)}
              >
                {/* Type icon */}
                <div className="w-6 h-6 rounded bg-secondary flex items-center justify-center text-muted-foreground">
                  {typeIcons[measurement.type]}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs truncate">{measurement.label}</span>
                    <span className="text-[10px] text-muted-foreground capitalize">
                      {measurement.type}
                    </span>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Page {measurement.page} · {measurement.date}
                  </div>
                </div>

                {/* Value */}
                <div className="text-right">
                  <div className="text-sm font-mono font-medium">
                    {measurement.value.toLocaleString()}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {measurement.unit}
                  </div>
                </div>

                {/* Delete button */}
                <button className="opacity-0 group-hover:opacity-100 p-1 hover:bg-destructive/20 rounded transition-opacity">
                  <Trash2 className="w-3 h-3 text-destructive" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Totals */}
      {allMeasurements.length > 0 && (
        <div className="border-t border-panel-border p-2 space-y-1">
          <div className="text-[10px] text-muted-foreground uppercase mb-2">Totals</div>
          {Object.entries(totals).map(([type, value]) => (
            <div key={type} className="flex justify-between text-xs">
              <span className="capitalize text-muted-foreground">{type}</span>
              <span className="font-mono font-medium">
                {value.toLocaleString()} {type === 'area' ? 'sq ft' : type === 'volume' ? 'cu ft' : 'ft'}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="p-2 border-t border-panel-border flex gap-1">
        <button className="flex-1 h-7 text-xs bg-secondary hover:bg-secondary/80 rounded transition-colors flex items-center justify-center gap-1">
          <Download className="w-3 h-3" />
          Export
        </button>
      </div>
    </div>
  );
}
