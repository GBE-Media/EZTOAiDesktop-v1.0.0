import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import type { CanvasMarkup } from '@/types/markup';

export type AiPreviewMarkup = { page: number; markup: CanvasMarkup };

export function setLiveAiPreview(input: {
  approvalId: string;
  docId: string;
  markups: AiPreviewMarkup[];
}): void {
  const canvas = useCanvasStore.getState();
  canvas.setAiPreview({
    approvalId: input.approvalId,
    docId: input.docId,
    markups: input.markups,
  });
  focusAiPreview(input.docId, input.markups);
}

export function focusAiPreview(docId?: string, markups?: AiPreviewMarkup[]): void {
  const canvas = useCanvasStore.getState();
  const preview = canvas.aiPreview;
  const targetDoc = docId || preview?.docId;
  const rows = markups || preview?.markups || [];
  if (!targetDoc || !rows.length) return;
  if (targetDoc !== canvas.activeDocId) {
    useEditorStore.getState().setActiveDocument(targetDoc);
    canvas.setActiveDocId(targetDoc);
  }
  const page = rows[0].page;
  canvas.setCurrentPage(page);
  const pageRows = rows.filter(row => row.page === page);
  const bounds = boundsOfMarkups(pageRows.map(row => row.markup));
  const doc = canvas.pdfDocuments[targetDoc];
  if (!bounds || !doc) return;
  const pad = 48;
  const containerW = canvas.containerWidth || 1200;
  const containerH = canvas.containerHeight || 800;
  const scale = Math.min(
    (containerW - pad * 2) / Math.max(40, bounds.width + pad * 2),
    (containerH - pad * 2) / Math.max(40, bounds.height + pad * 2),
    3,
  );
  const zoom = Math.max(25, Math.min(400, Math.round(scale * 100)));
  canvas.setZoom(zoom);
  canvas.setPanOffset(
    containerW / 2 - (bounds.x + bounds.width / 2) * (zoom / 100),
    containerH / 2 - (bounds.y + bounds.height / 2) * (zoom / 100),
  );
}

function boundsOfMarkups(markups: CanvasMarkup[]): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const markup of markups) {
    const row = markup as CanvasMarkup & {
      x?: number; y?: number; width?: number; height?: number;
      startX?: number; startY?: number; endX?: number; endY?: number;
      points?: Array<{ x: number; y: number }>;
    };
    const xs: number[] = [];
    const ys: number[] = [];
    if (typeof row.x === 'number') xs.push(row.x, row.x + (row.width || 0));
    if (typeof row.y === 'number') ys.push(row.y, row.y + (row.height || 0));
    if (typeof row.startX === 'number') xs.push(row.startX, row.endX || row.startX);
    if (typeof row.startY === 'number') ys.push(row.startY, row.endY || row.startY);
    for (const point of row.points || []) {
      xs.push(point.x);
      ys.push(point.y);
    }
    if (!xs.length || !ys.length) continue;
    minX = Math.min(minX, ...xs);
    minY = Math.min(minY, ...ys);
    maxX = Math.max(maxX, ...xs);
    maxY = Math.max(maxY, ...ys);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: Math.max(8, maxX - minX), height: Math.max(8, maxY - minY) };
}
