import type { ToolType } from '@/types/editor';
import type { CanvasMarkup, MarkupStyle, Point } from '@/types/markup';
import { useCanvasStore } from '@/store/canvasStore';
import { useEditorStore } from '@/store/editorStore';
import { useHistoryStore } from '@/store/historyStore';
import { BASE_RENDER_SCALE, createPageGeometry, docToRender } from '../placement/coords';
import type { DocPoint, PageGeometry } from '../placement/types';

export const EDITOR_TOOL_TYPES = [
  'select',
  'pan',
  'text',
  'highlight',
  'cloud',
  'rectangle',
  'ellipse',
  'line',
  'arrow',
  'polyline',
  'polygon',
  'callout',
  'stamp',
  'freehand',
  'eraser',
  'count',
  'measure-length',
  'measure-area',
] as const satisfies readonly ToolType[];

export type EditorToolType = (typeof EDITOR_TOOL_TYPES)[number];

const EDITOR_TOOL_SET = new Set<string>(EDITOR_TOOL_TYPES);

const TEXTUAL_TYPES = new Set(['text', 'callout']);
const BOX_TYPES = new Set(['rectangle', 'ellipse', 'highlight', 'stamp', 'text', 'callout']);
const POINT_TYPES = new Set([
  'polygon',
  'polyline',
  'cloud',
  'freehand',
  'measurement-length',
  'measurement-area',
]);
const LINE_TYPES = new Set(['line', 'arrow']);
const COUNT_TYPES = new Set(['count-marker']);

export type MarkupMutationItemResult = {
  id: string;
  status: 'updated' | 'deleted' | 'not-found' | 'rejected';
  page?: number;
  reason?: string;
};

export type ActivateEditorToolResult = {
  activated: boolean;
  tool?: EditorToolType;
  message: string;
};

export function isEditorToolType(tool: string): tool is EditorToolType {
  return EDITOR_TOOL_SET.has(tool);
}

/** Switch the human canvas tool mode (UI state only — no document mutation). */
export function activateEditorToolOnCanvas(tool: string): ActivateEditorToolResult {
  if (!isEditorToolType(tool)) {
    return {
      activated: false,
      message: `Unknown editor tool "${tool}". Valid tools: ${EDITOR_TOOL_TYPES.join(', ')}.`,
    };
  }
  useEditorStore.getState().setActiveTool(tool);
  return {
    activated: true,
    tool,
    message: `Switched to ${tool} tool — please use the canvas to continue.`,
  };
}

function getActiveDocData() {
  const canvas = useCanvasStore.getState();
  if (!canvas.activeDocId) return null;
  const docData = canvas.pdfDocuments[canvas.activeDocId];
  if (!docData) return null;
  return { canvas, docId: canvas.activeDocId, docData };
}

function pageGeometryFor(page: number): PageGeometry {
  const meta = getActiveDocData();
  const docWidth = meta?.docData.originalPageWidth || 612;
  const docHeight = meta?.docData.originalPageHeight || 792;
  return createPageGeometry({
    pageNumber: page,
    docWidth,
    docHeight,
    renderScale: BASE_RENDER_SCALE,
  });
}

export function findMarkupById(
  markupId: string,
  preferredPage?: number,
): { page: number; markup: CanvasMarkup } | null {
  const meta = getActiveDocData();
  if (!meta) return null;
  const byPage = meta.docData.markupsByPage;

  if (preferredPage != null) {
    const onPreferred = (byPage[preferredPage] || []).find(m => m.id === markupId);
    if (onPreferred) return { page: preferredPage, markup: onPreferred };
  }

  for (const [pageKey, markups] of Object.entries(byPage)) {
    const found = markups.find(m => m.id === markupId);
    if (found) return { page: Number(pageKey), markup: found };
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeStyle(
  current: MarkupStyle,
  patchStyle: unknown,
): { ok: true; style: MarkupStyle } | { ok: false; reason: string } {
  if (patchStyle === undefined) return { ok: true, style: current };
  if (!isPlainObject(patchStyle)) {
    return { ok: false, reason: 'style must be an object' };
  }
  const next: MarkupStyle = { ...current };
  if (patchStyle.strokeColor !== undefined) {
    if (typeof patchStyle.strokeColor !== 'string') {
      return { ok: false, reason: 'style.strokeColor must be a string' };
    }
    next.strokeColor = patchStyle.strokeColor;
  }
  if (patchStyle.fillColor !== undefined) {
    if (typeof patchStyle.fillColor !== 'string') {
      return { ok: false, reason: 'style.fillColor must be a string' };
    }
    next.fillColor = patchStyle.fillColor;
  }
  if (patchStyle.strokeWidth !== undefined) {
    if (typeof patchStyle.strokeWidth !== 'number' || !(patchStyle.strokeWidth > 0)) {
      return { ok: false, reason: 'style.strokeWidth must be a positive number' };
    }
    next.strokeWidth = patchStyle.strokeWidth;
  }
  if (patchStyle.opacity !== undefined) {
    if (typeof patchStyle.opacity !== 'number' || !Number.isFinite(patchStyle.opacity)) {
      return { ok: false, reason: 'style.opacity must be a finite number' };
    }
    next.opacity = patchStyle.opacity;
  }
  if (patchStyle.fontSize !== undefined) {
    if (typeof patchStyle.fontSize !== 'number' || !(patchStyle.fontSize > 0)) {
      return { ok: false, reason: 'style.fontSize must be a positive number' };
    }
    next.fontSize = patchStyle.fontSize;
  }
  if (patchStyle.fontFamily !== undefined) {
    if (typeof patchStyle.fontFamily !== 'string') {
      return { ok: false, reason: 'style.fontFamily must be a string' };
    }
    next.fontFamily = patchStyle.fontFamily;
  }
  return { ok: true, style: next };
}

function toRenderPoint(point: DocPoint, geometry: PageGeometry): Point {
  return docToRender(point, geometry);
}

function toRenderSize(width: number, height: number, geometry: PageGeometry): { width: number; height: number } {
  const scale = geometry.renderScale || BASE_RENDER_SCALE;
  return { width: width * scale, height: height * scale };
}

/**
 * Validate a partial update against the live markup type and convert any
 * DocPoint geometry into canvas render-space before applying.
 */
export function buildValidatedMarkupPatch(
  markup: CanvasMarkup,
  patch: Record<string, unknown>,
  geometry: PageGeometry,
): { ok: true; updates: Partial<CanvasMarkup> } | { ok: false; reason: string } {
  const type = markup.type;
  const updates: Record<string, unknown> = {};
  const rejected: string[] = [];

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;

    switch (key) {
      case 'label':
      case 'aiNote':
        if (typeof value !== 'string') {
          return { ok: false, reason: `${key} must be a string` };
        }
        updates[key] = value;
        break;

      case 'content':
        if (!TEXTUAL_TYPES.has(type)) {
          rejected.push(`content is not valid on ${type}`);
          break;
        }
        if (typeof value !== 'string') {
          return { ok: false, reason: 'content must be a string' };
        }
        updates.content = value;
        break;

      case 'style': {
        const styled = mergeStyle(markup.style, value);
        if (styled.ok === false) {
          return { ok: false, reason: styled.reason };
        }
        updates.style = styled.style;
        break;
      }

      case 'x':
      case 'y': {
        if (!(BOX_TYPES.has(type) || COUNT_TYPES.has(type))) {
          rejected.push(`${key} is not valid on ${type}`);
          break;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, reason: `${key} must be a finite number (DocPoint)` };
        }
        break;
      }

      case 'width':
      case 'height': {
        if (!BOX_TYPES.has(type)) {
          rejected.push(`${key} is not valid on ${type}`);
          break;
        }
        if (typeof value !== 'number' || !(value > 0)) {
          return { ok: false, reason: `${key} must be a positive number (document units)` };
        }
        break;
      }

      case 'points': {
        if (!(POINT_TYPES.has(type) || LINE_TYPES.has(type) || type === 'callout')) {
          rejected.push(`points is not valid on ${type}`);
          break;
        }
        if (!Array.isArray(value) || value.length < 1) {
          return { ok: false, reason: 'points must be a non-empty DocPoint array' };
        }
        const points: Point[] = [];
        for (const p of value) {
          if (!isPlainObject(p) || typeof p.x !== 'number' || typeof p.y !== 'number') {
            return { ok: false, reason: 'points must be DocPoint {x,y} values' };
          }
          points.push(toRenderPoint({ x: p.x, y: p.y }, geometry));
        }
        if (LINE_TYPES.has(type)) {
          if (points.length < 2) {
            return { ok: false, reason: 'line/arrow updates need at least 2 points' };
          }
          updates.startX = points[0].x;
          updates.startY = points[0].y;
          updates.endX = points[points.length - 1].x;
          updates.endY = points[points.length - 1].y;
        } else if (type === 'callout') {
          updates.leaderPoints = points;
        } else {
          updates.points = points;
        }
        break;
      }

      case 'startX':
      case 'startY':
      case 'endX':
      case 'endY': {
        if (!LINE_TYPES.has(type)) {
          rejected.push(`${key} is not valid on ${type}`);
          break;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, reason: `${key} must be a finite DocPoint coordinate` };
        }
        break;
      }

      case 'leaderPoints': {
        if (type !== 'callout') {
          rejected.push('leaderPoints is only valid on callout');
          break;
        }
        if (!Array.isArray(value)) {
          return { ok: false, reason: 'leaderPoints must be an array' };
        }
        const leaderPoints: Point[] = [];
        for (const p of value) {
          if (!isPlainObject(p) || typeof p.x !== 'number' || typeof p.y !== 'number') {
            return { ok: false, reason: 'leaderPoints must be DocPoint {x,y} values' };
          }
          leaderPoints.push(toRenderPoint({ x: p.x, y: p.y }, geometry));
        }
        updates.leaderPoints = leaderPoints;
        break;
      }

      case 'number': {
        if (!COUNT_TYPES.has(type)) {
          rejected.push(`number is not valid on ${type}`);
          break;
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          return { ok: false, reason: 'number must be finite' };
        }
        updates.number = value;
        break;
      }

      default:
        rejected.push(`unsupported patch field "${key}" on ${type}`);
    }
  }

  // Convert box/count position DocPoints after validating keys.
  if (typeof patch.x === 'number' || typeof patch.y === 'number') {
    const currentX = 'x' in markup ? Number((markup as { x: number }).x) : 0;
    const currentY = 'y' in markup ? Number((markup as { y: number }).y) : 0;
    const docX = typeof patch.x === 'number' ? patch.x : currentX / (geometry.renderScale || BASE_RENDER_SCALE);
    const docY = typeof patch.y === 'number' ? patch.y : currentY / (geometry.renderScale || BASE_RENDER_SCALE);
    const rendered = toRenderPoint({ x: docX, y: docY }, geometry);
    updates.x = rendered.x;
    updates.y = rendered.y;
  }

  if (typeof patch.width === 'number' || typeof patch.height === 'number') {
    const currentW = 'width' in markup ? Number((markup as { width: number }).width) : 0;
    const currentH = 'height' in markup ? Number((markup as { height: number }).height) : 0;
    const scale = geometry.renderScale || BASE_RENDER_SCALE;
    const docW = typeof patch.width === 'number' ? patch.width : currentW / scale;
    const docH = typeof patch.height === 'number' ? patch.height : currentH / scale;
    const sized = toRenderSize(docW, docH, geometry);
    updates.width = sized.width;
    updates.height = sized.height;
  }

  if (LINE_TYPES.has(type)) {
    const scale = geometry.renderScale || BASE_RENDER_SCALE;
    const line = markup as CanvasMarkup & {
      startX: number;
      startY: number;
      endX: number;
      endY: number;
    };
    if (typeof patch.startX === 'number' || typeof patch.startY === 'number') {
      const doc = {
        x: typeof patch.startX === 'number' ? patch.startX : line.startX / scale,
        y: typeof patch.startY === 'number' ? patch.startY : line.startY / scale,
      };
      const rendered = toRenderPoint(doc, geometry);
      updates.startX = rendered.x;
      updates.startY = rendered.y;
    }
    if (typeof patch.endX === 'number' || typeof patch.endY === 'number') {
      const doc = {
        x: typeof patch.endX === 'number' ? patch.endX : line.endX / scale,
        y: typeof patch.endY === 'number' ? patch.endY : line.endY / scale,
      };
      const rendered = toRenderPoint(doc, geometry);
      updates.endX = rendered.x;
      updates.endY = rendered.y;
    }
  }

  if (rejected.length > 0 && Object.keys(updates).length === 0) {
    return { ok: false, reason: rejected.join('; ') };
  }
  if (Object.keys(updates).length === 0) {
    return { ok: false, reason: rejected.length ? rejected.join('; ') : 'patch is empty' };
  }
  if (rejected.length > 0) {
    return { ok: false, reason: rejected.join('; ') };
  }

  return { ok: true, updates: updates as Partial<CanvasMarkup> };
}

export function executeDeleteMarkups(payload: unknown): {
  status: 'completed';
  deleted: number;
  notFound: number;
  results: MarkupMutationItemResult[];
  message: string;
} {
  const record = isPlainObject(payload) ? payload : {};
  const markupIds = Array.isArray(record.markupIds)
    ? record.markupIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : [];
  const preferredPage = typeof record.page === 'number' ? record.page : undefined;

  const results: MarkupMutationItemResult[] = [];
  const byPage = new Map<number, string[]>();

  for (const id of markupIds) {
    const found = findMarkupById(id, preferredPage);
    if (!found) {
      results.push({ id, status: 'not-found', reason: 'Markup id not found on active document' });
      continue;
    }
    const list = byPage.get(found.page) || [];
    list.push(id);
    byPage.set(found.page, list);
    results.push({ id, status: 'deleted', page: found.page });
  }

  const canvas = useCanvasStore.getState();
  for (const [page, ids] of byPage) {
    canvas.deleteMarkups(page, ids);
  }

  const deleted = results.filter(r => r.status === 'deleted').length;
  const notFound = results.filter(r => r.status === 'not-found').length;
  return {
    status: 'completed',
    deleted,
    notFound,
    results,
    message: `Deleted ${deleted} markup(s); ${notFound} not found.`,
  };
}

export function executeUpdateMarkups(payload: unknown): {
  status: 'completed';
  updated: number;
  rejected: number;
  notFound: number;
  results: MarkupMutationItemResult[];
  message: string;
} {
  const record = isPlainObject(payload) ? payload : {};
  const updates = Array.isArray(record.updates) ? record.updates : [];
  const results: MarkupMutationItemResult[] = [];

  for (const row of updates) {
    if (!isPlainObject(row) || typeof row.id !== 'string') {
      results.push({
        id: String((row as { id?: unknown })?.id || ''),
        status: 'rejected',
        reason: 'Update row must include string id and patch',
      });
      continue;
    }
    const preferredPage = typeof row.page === 'number' ? row.page : undefined;
    const patch = isPlainObject(row.patch) ? row.patch : null;
    if (!patch) {
      results.push({ id: row.id, status: 'rejected', reason: 'Missing patch object' });
      continue;
    }

    const found = findMarkupById(row.id, preferredPage);
    if (!found) {
      results.push({
        id: row.id,
        status: 'not-found',
        reason: 'Markup id not found on active document',
      });
      continue;
    }

    const validated = buildValidatedMarkupPatch(
      found.markup,
      patch,
      pageGeometryFor(found.page),
    );

    if (validated.ok === false) {
      results.push({
        id: row.id,
        status: 'rejected',
        page: found.page,
        reason: validated.reason,
      });
      continue;
    }

    useCanvasStore.getState().updateMarkup(found.page, row.id, validated.updates);
    results.push({ id: row.id, status: 'updated', page: found.page });
  }

  const updated = results.filter(r => r.status === 'updated').length;
  const rejected = results.filter(r => r.status === 'rejected').length;
  const notFound = results.filter(r => r.status === 'not-found').length;
  return {
    status: 'completed',
    updated,
    rejected,
    notFound,
    results,
    message: `Updated ${updated} markup(s); ${rejected} rejected; ${notFound} not found.`,
  };
}

/** Test helper: history depth after mutations. */
export function getHistoryPastCount(): number {
  return useHistoryStore.getState().past.length;
}
