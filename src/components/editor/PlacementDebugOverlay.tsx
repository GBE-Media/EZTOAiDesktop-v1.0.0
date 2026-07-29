import { usePlacementDebugStore } from '@/services/ai/placement';
import { useCanvasLayersStore } from '@/store/canvasLayersStore';
import { BASE_RENDER_SCALE } from '@/services/ai/placement/coords';
import { cn } from '@/lib/utils';

/**
 * Analysis overlay for OCR boxes, anchors, and AI markup proposals.
 * Hidden by default; layer / Review mode controls what paints.
 * Coordinates in the debug store are document points; drawn at render scale.
 */
export function PlacementDebugOverlay({
  width,
  height,
  pageNumber,
  suspendHeavyLayers = false,
}: {
  width: number;
  height: number;
  pageNumber: number;
  /** While panning/zooming, skip expensive analysis paints. */
  suspendHeavyLayers?: boolean;
}) {
  const page = usePlacementDebugStore(state => state.page);
  const ocrRects = usePlacementDebugStore(state => state.ocrRects);
  const anchors = usePlacementDebugStore(state => state.anchors);
  const proposals = usePlacementDebugStore(state => state.proposals);
  const layers = useCanvasLayersStore(state => state.layers);

  if (suspendHeavyLayers) return null;
  if (!page || page.pageNumber !== pageNumber) return null;

  const showOcr = layers.ocr;
  const showAnchors = layers.anchors;
  const showProposals = layers.proposals;
  if (!showOcr && !showAnchors && !showProposals) return null;

  const scale = page.renderScale || BASE_RENDER_SCALE;

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-20"
      style={{ width, height }}
    >
      {showOcr &&
        ocrRects.map((rect, index) => (
          <div
            key={`ocr_${index}`}
            className="absolute border border-sky-400/70 bg-sky-400/10"
            style={{
              left: rect.x * scale,
              top: rect.y * scale,
              width: Math.max(1, rect.width * scale),
              height: Math.max(1, rect.height * scale),
            }}
          />
        ))}

      {showAnchors &&
        anchors.map(anchor => {
          const point = anchor.point;
          if (!point) return null;
          return (
            <div
              key={anchor.id}
              className="absolute h-2 w-2 -translate-x-1 -translate-y-1 rounded-full border border-amber-500 bg-amber-400/80"
              style={{
                left: point.x * scale,
                top: point.y * scale,
              }}
              title={anchor.label || anchor.type}
            />
          );
        })}

      {showProposals &&
        proposals.map(proposal => {
          const confidence = proposal.confidence;
          return (
            <div
              key={proposal.id}
              className={cn(
                'absolute border-2',
                confidence >= 0.75 && 'border-emerald-500 bg-emerald-500/10',
                confidence >= 0.45 && confidence < 0.75 && 'border-amber-500 bg-amber-500/10',
                confidence < 0.45 && 'border-destructive bg-destructive/10',
              )}
              style={{
                left: proposal.boundingBox.x * scale,
                top: proposal.boundingBox.y * scale,
                width: Math.max(1, proposal.boundingBox.width * scale),
                height: Math.max(1, proposal.boundingBox.height * scale),
              }}
              title={`${proposal.markupType} · ${Math.round(confidence * 100)}% · ${proposal.placementMode}`}
            />
          );
        })}
    </div>
  );
}
