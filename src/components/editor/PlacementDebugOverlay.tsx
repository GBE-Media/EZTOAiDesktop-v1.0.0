import { useEffect } from 'react';
import { usePlacementDebugStore } from '@/services/ai/placement';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { BASE_RENDER_SCALE } from '@/services/ai/placement/coords';
import { cn } from '@/lib/utils';

/**
 * Lightweight debug overlay for OCR boxes, anchors, and AI markup proposals.
 * Coordinates in the debug store are document points; drawn at render scale.
 */
export function PlacementDebugOverlay({
  width,
  height,
  pageNumber,
}: {
  width: number;
  height: number;
  pageNumber: number;
}) {
  const enabled = usePlacementDebugStore(state => state.enabled);
  const setEnabled = usePlacementDebugStore(state => state.setEnabled);
  const showPlacementDebug = useAISettingsStore(state => state.showPlacementDebug);
  const page = usePlacementDebugStore(state => state.page);
  const ocrRects = usePlacementDebugStore(state => state.ocrRects);
  const anchors = usePlacementDebugStore(state => state.anchors);
  const proposals = usePlacementDebugStore(state => state.proposals);

  useEffect(() => {
    setEnabled(showPlacementDebug);
  }, [setEnabled, showPlacementDebug]);

  if (!enabled || !page || page.pageNumber !== pageNumber) return null;

  const scale = page.renderScale || BASE_RENDER_SCALE;

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-20"
      style={{ width, height }}
    >
      {ocrRects.map((rect, index) => (
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

      {anchors.map(anchor => {
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

      {proposals.map(proposal => {
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
