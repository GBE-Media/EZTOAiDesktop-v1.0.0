import { useCanvasStore } from '@/store/canvasStore';
import type { CanvasMarkup } from '@/types/markup';
import { capturePageRegionView, normalizeViewRegion, VIEW_IMAGE_MAX_PX } from '../imageCapture';
import { BASE_RENDER_SCALE } from '../placement/coords';
import { resolveDocumentRef } from '../documentRef';

/** One image the assistant looks at on its next step (never put into the text tool output). */
export interface ViewPageImage {
  base64: string;
  caption: string;
}

export interface ViewPageMarker {
  id: string;
  number: number;
  label?: string;
  review?: boolean;
  /** Marker centre in page 0-100 percent (same frame as region). */
  x: number;
  y: number;
}

export interface ViewPageResult {
  status: 'completed' | 'unavailable' | 'failed';
  message?: string;
  page?: number;
  documentId?: string;
  region?: { x: number; y: number; width: number; height: number };
  dpi?: number;
  imageSize?: { width: number; height: number };
  /** Count markers drawn on the image (numbered rings), for checking placement. */
  markersShown?: ViewPageMarker[];
  image?: ViewPageImage;
}

/** Most markers listed back in text; the image shows all of them. */
const MAX_LISTED_MARKERS = 60;

export type RegionRenderer = typeof capturePageRegionView;

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Count markers on a page, in page percent. Markup geometry is render space (BASE_RENDER_SCALE). */
export function markersInRegion(
  markups: CanvasMarkup[],
  pageWidth: number,
  pageHeight: number,
  region: { x: number; y: number; width: number; height: number },
): ViewPageMarker[] {
  const out: ViewPageMarker[] = [];
  for (const markup of markups) {
    if (markup.type !== 'count-marker') continue;
    const x = ((markup.x / BASE_RENDER_SCALE) / pageWidth) * 100;
    const y = ((markup.y / BASE_RENDER_SCALE) / pageHeight) * 100;
    if (x < region.x || x > region.x + region.width || y < region.y || y > region.y + region.height) continue;
    out.push({
      id: markup.id,
      number: markup.number,
      ...(markup.label ? { label: markup.label } : {}),
      ...(markup.reviewMarker ? { review: true } : {}),
      x: Math.round(x * 100) / 100,
      y: Math.round(y * 100) / 100,
    });
  }
  return out;
}

/**
 * view_page: render a page — or a zoomed region of it — so the assistant can actually look at the
 * drawing (other sheets, schedules, details, dense areas) and check where its markers sit.
 */
export async function viewPage(
  input: unknown,
  options: { signal?: AbortSignal; render?: RegionRenderer } = {},
): Promise<ViewPageResult> {
  if (options.signal?.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');
  const raw = (input && typeof input === 'object') ? input as Record<string, unknown> : {};
  const ref = typeof raw.documentId === 'string' && raw.documentId.trim() ? raw.documentId.trim() : undefined;
  const resolved = resolveDocumentRef(ref);
  if ('error' in resolved) {
    return { status: Object.keys(useCanvasStore.getState().pdfDocuments).length ? 'failed' : 'unavailable', message: resolved.error };
  }
  const docId = resolved.docId;
  const pdf = useCanvasStore.getState().pdfDocuments[docId];
  if (!pdf?.pdfDocument || !pdf.originalPageWidth || !pdf.originalPageHeight) {
    return { status: 'unavailable', message: 'No PDF document is open to view.' };
  }
  const page = num(raw.page) && Number.isInteger(raw.page) && (raw.page as number) > 0
    ? raw.page as number
    : pdf.currentPage || 1;
  if (page > (pdf.totalPages || 0)) {
    return { status: 'failed', message: `Page ${page} is out of range (document has ${pdf.totalPages} pages).` };
  }
  const pageWidth = pdf.originalPageWidth;
  const pageHeight = pdf.originalPageHeight;

  // A region in page percent, or a box around a DocPoint (e.g. a marker from count_page_items).
  let region = normalizeViewRegion(raw.region as Record<string, unknown> | undefined);
  const center = raw.center as Record<string, unknown> | undefined;
  if (center && num(center.x) !== undefined && num(center.y) !== undefined) {
    const size = Math.max(24, num(raw.sizePt) ?? 144);
    region = normalizeViewRegion({
      x: ((num(center.x)! - size / 2) / pageWidth) * 100,
      y: ((num(center.y)! - size / 2) / pageHeight) * 100,
      width: (size / pageWidth) * 100,
      height: (size / pageHeight) * 100,
    });
  }

  const showMarkers = raw.showMarkers !== false;
  const markers = showMarkers
    ? markersInRegion((pdf.markupsByPage?.[page] || []) as CanvasMarkup[], pageWidth, pageHeight, region)
    : [];
  const render = options.render || capturePageRegionView;
  try {
    const shot = await render(pdf.pdfDocument, page, region, {
      maxPx: VIEW_IMAGE_MAX_PX,
      overlay: markers.length
        ? (ctx, toPx) => {
            const r = Math.max(8, Math.round(Math.min(ctx.canvas.width, ctx.canvas.height) / 90));
            ctx.lineWidth = Math.max(2, r / 4);
            ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
            for (const marker of markers) {
              const [px, py] = toPx(marker.x, marker.y);
              ctx.strokeStyle = marker.review ? '#f59e0b' : '#e11d48';
              ctx.beginPath();
              ctx.arc(px, py, r, 0, Math.PI * 2);
              ctx.stroke();
              ctx.fillStyle = ctx.strokeStyle;
              ctx.fillText(String(marker.number), px + r + 2, py - r);
            }
          }
        : undefined,
    });
    if (options.signal?.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');
    const whole = region.width >= 99.9 && region.height >= 99.9;
    const where = whole
      ? 'whole sheet'
      : `region x ${region.x.toFixed(1)}–${(region.x + region.width).toFixed(1)}%, y ${region.y.toFixed(1)}–${(region.y + region.height).toFixed(1)}%`;
    const caption = `view_page image: page ${page}, ${where}, ${shot.dpi} dpi`
      + (markers.length ? `; ${markers.length} count marker(s) drawn as numbered rings (red = placed, amber = review)` : '')
      + '. Image pixel (0,0) is the top-left of this region.';
    return {
      status: 'completed',
      page,
      documentId: docId,
      region,
      dpi: shot.dpi,
      imageSize: { width: shot.width, height: shot.height },
      ...(markers.length ? { markersShown: markers.slice(0, MAX_LISTED_MARKERS) } : {}),
      image: { base64: shot.base64, caption },
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    return { status: 'failed', message: `Could not render page ${page}: ${error instanceof Error ? error.message : String(error)}` };
  }
}
