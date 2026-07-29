import { Loader2 } from 'lucide-react';
import { useAIChatStore } from '@/store/aiChatStore';
import { useCanvasStore } from '@/store/canvasStore';

function calmStatusLabel(message: string, stage?: string | null): string {
  const text = `${stage || ''} ${message}`.toLowerCase();

  if (/ocr|recogniz|scanned/.test(text)) return 'Scanning current page';
  if (/label|dimension|text|read/.test(text)) return 'Reading labels and dimensions';
  if (/anchor|layout|snap|geometry/.test(text)) return 'Finding placement anchors';
  if (/place|markup|suggest|proposal|pointer/.test(text)) return 'Preparing markup suggestions';
  if (/vision|analyz|detect|blueprint/.test(text)) return 'Scanning current page';
  if (/estimat|count|quantit/.test(text)) return 'Preparing estimate results';
  if (message.trim()) return message.trim();
  return 'Working…';
}

/**
 * Compact, non-blocking canvas HUD for AI/OCR progress.
 * Does not paint analysis geometry.
 */
export function CanvasStatusChip() {
  const pipelineStatus = useAIChatStore(state => state.pipelineStatus);
  const ocr = useCanvasStore(state => {
    const id = state.activeDocId;
    if (!id) return { status: 'none' as const, progress: 0 };
    const doc = state.pdfDocuments[id];
    return {
      status: doc?.ocrStatus || 'none',
      progress: doc?.ocrProgress || 0,
    };
  });

  const aiBusy = pipelineStatus.isRunning;
  const ocrBusy = ocr.status === 'running';
  if (!aiBusy && !ocrBusy) return null;

  const label = ocrBusy
    ? `Recognizing text (${Math.round(ocr.progress)}%)`
    : calmStatusLabel(pipelineStatus.message || '', pipelineStatus.currentStage);

  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-full border border-panel-border bg-panel/95 px-3 py-1.5 text-xs text-foreground shadow-md backdrop-blur-sm">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="max-w-[280px] truncate">{label}</span>
      </div>
    </div>
  );
}
