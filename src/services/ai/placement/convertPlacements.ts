import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import type { CanvasPlacement, PlacementMarkup } from '../providers/types';
import { BASE_RENDER_SCALE } from './coords';
import type { DocRect } from './types';

export type PlacementVerificationMeta = {
  id: string;
  pending: boolean;
  confidence: number;
  /** Document-space corrected box from verifyMarkupProposal; used when usable. */
  boundingBox?: DocRect;
};

export function isUsableVerifiedBox(
  box: PlacementVerificationMeta['boundingBox'],
): box is DocRect {
  return Boolean(
    box
    && Number.isFinite(box.x)
    && Number.isFinite(box.y)
    && Number.isFinite(box.width)
    && Number.isFinite(box.height)
    && box.width > 0
    && box.height > 0
  );
}

function pointsAabb(points: Array<{ x: number; y: number }> | undefined) {
  const list = points || [];
  if (list.length === 0) return null;
  const xs = list.map(p => p.x);
  const ys = list.map(p => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
  };
}

/** Reattach leader start to the verified bubble edge toward the existing leader end. */
export function reattachLeaderToVerifiedBox(
  box: DocRect,
  leaderPoints: Array<{ x: number; y: number }> | undefined,
): Array<{ x: number; y: number }> {
  const existing = leaderPoints || [];
  if (existing.length === 0) return existing;
  const leaderEnd = existing[existing.length - 1];
  const attach = {
    x: box.x + (leaderEnd.x < box.x + box.width / 2 ? 0 : box.width),
    y: box.y + (leaderEnd.y < box.y + box.height / 2 ? 0 : box.height),
  };
  return [attach, ...existing.slice(1)];
}

/**
 * Convert pipeline/agent placements into canvas markups.
 * When verification metadata includes a usable boundingBox, that corrected
 * geometry is applied instead of raw placement.points (per item; invalid boxes fall back).
 */
export function convertPlacementsToMarkups(
  placements: CanvasPlacement,
  defaultStyle: MarkupStyle,
  groupId: string,
  scaleX: number = BASE_RENDER_SCALE,
  scaleY: number = BASE_RENDER_SCALE,
  verificationById?: PlacementVerificationMeta[],
): Array<{ page: number; markup: CanvasMarkup }> {
  const now = new Date().toISOString();
  const markups: Array<{ page: number; markup: CanvasMarkup }> = [];
  const verificationMap = new Map(
    (verificationById || []).map(item => [item.id, item]),
  );

  const buildStyle = (placementStyle?: PlacementMarkup['style']): MarkupStyle => ({
    strokeColor: placementStyle?.strokeColor || defaultStyle.strokeColor,
    fillColor: placementStyle?.fillColor || defaultStyle.fillColor,
    strokeWidth: placementStyle?.strokeWidth || defaultStyle.strokeWidth,
    opacity: 100,
    fontSize: defaultStyle.fontSize,
    fontFamily: defaultStyle.fontFamily,
  });

  placements.markups.forEach((placement, index) => {
    const style = buildStyle(placement.style);
    const verification = verificationMap.get(placement.id || '')
      || verificationMap.get(`proposal_pl_${index}`)
      || verificationMap.get(`proposal_ptr_${placement.calloutRef || index + 1}`);
    const pending = verification?.pending ?? placement.pending;
    const confidence = verification?.confidence ?? placement.confidence;
    const boxCandidate = verification?.boundingBox;
    const verifiedBox = isUsableVerifiedBox(boxCandidate) ? boxCandidate : null;
    const base = {
      id: placement.id || `ai_${Date.now()}_${index}`,
      type: placement.type,
      page: placement.page,
      style,
      locked: false,
      author: 'AI',
      createdAt: now,
      label: placement.label,
      aiGenerated: true,
      aiPending: pending,
      aiNote: placement.aiNote,
      aiConfidence: confidence,
      aiLinkedItemId: placement.linkedItemId,
      calloutRef: placement.calloutRef,
    } as const;

    if (placement.type === 'rectangle') {
      const start = placement.points?.[0] || { x: 0, y: 0 };
      const end = placement.points?.[1] || start;
      const x = verifiedBox ? verifiedBox.x : Math.min(start.x, end.x);
      const y = verifiedBox ? verifiedBox.y : Math.min(start.y, end.y);
      const width = verifiedBox ? verifiedBox.width : Math.abs(end.x - start.x);
      const height = verifiedBox ? verifiedBox.height : Math.abs(end.y - start.y);
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'rectangle',
          x: x * scaleX,
          y: y * scaleY,
          width: width * scaleX,
          height: height * scaleY,
        },
      });
      return;
    }

    if (placement.type === 'count-marker') {
      const point = placement.points?.[0] || { x: 0, y: 0 };
      const x = verifiedBox ? verifiedBox.x + verifiedBox.width / 2 : point.x;
      const y = verifiedBox ? verifiedBox.y + verifiedBox.height / 2 : point.y;
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'count-marker',
          x: x * scaleX,
          y: y * scaleY,
          number: 1,
          groupId,
        },
      });
      return;
    }

    if (placement.type === 'measurement-length' || placement.type === 'measurement-area') {
      const original = pointsAabb(placement.points);
      const dx = verifiedBox && original ? (verifiedBox.x + verifiedBox.width / 2) - original.centerX : 0;
      const dy = verifiedBox && original ? (verifiedBox.y + verifiedBox.height / 2) - original.centerY : 0;
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: placement.type,
          points: (placement.points || []).map((point) => ({
            x: (point.x + dx) * scaleX,
            y: (point.y + dy) * scaleY,
          })),
          value: 0,
          scaledValue: 0,
          unit: 'ft',
        },
      });
      return;
    }

    if (placement.type === 'polyline' || placement.type === 'polygon') {
      const original = pointsAabb(placement.points);
      const dx = verifiedBox && original ? (verifiedBox.x + verifiedBox.width / 2) - original.centerX : 0;
      const dy = verifiedBox && original ? (verifiedBox.y + verifiedBox.height / 2) - original.centerY : 0;
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: placement.type,
          points: (placement.points || []).map((point) => ({
            x: (point.x + dx) * scaleX,
            y: (point.y + dy) * scaleY,
          })),
        },
      });
      return;
    }

    if (placement.type === 'text') {
      const point = placement.points?.[0] || { x: 0, y: 0 };
      const x = verifiedBox ? verifiedBox.x + verifiedBox.width / 2 : point.x;
      const y = verifiedBox ? verifiedBox.y + verifiedBox.height / 2 : point.y;
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'text',
          x: x * scaleX,
          y: y * scaleY,
          width: 200,
          height: 50,
          content: placement.label || placement.aiNote || 'AI Note',
        },
      });
      return;
    }

    if (placement.type === 'callout') {
      const pts = placement.points || [];
      const hasTrustedPoints = pts.length >= 1;
      const ref = placement.calloutRef || index + 1;

      // Geometry-less review entry: keep identity for the queue, do not invent (0,0).
      if (!verifiedBox && !hasTrustedPoints) {
        markups.push({
          page: placement.page,
          markup: {
            ...base,
            type: 'callout',
            x: Number.NaN,
            y: Number.NaN,
            width: 0,
            height: 0,
            content: placement.content || `[${ref}] ${placement.label || 'Callout'}`,
            leaderPoints: [],
            calloutRef: ref,
          },
        });
        return;
      }

      const start = pts[0] || { x: 0, y: 0 };
      const end = pts[1] || {
        x: start.x + 120,
        y: start.y + 36,
      };
      const bubbleX = verifiedBox ? verifiedBox.x : Math.min(start.x, end.x);
      const bubbleY = verifiedBox ? verifiedBox.y : Math.min(start.y, end.y);
      const bubbleW = verifiedBox ? verifiedBox.width : Math.abs(end.x - start.x);
      const bubbleH = verifiedBox ? verifiedBox.height : Math.abs(end.y - start.y);
      const leaderSource = verifiedBox
        ? reattachLeaderToVerifiedBox(verifiedBox, placement.leaderPoints)
        : (placement.leaderPoints || []);
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'callout',
          x: bubbleX * scaleX,
          y: bubbleY * scaleY,
          width: Math.max(bubbleW * scaleX, 72),
          height: Math.max(bubbleH * scaleY, 28),
          content: placement.content || `[${ref}] ${placement.label || 'Callout'}`,
          leaderPoints: leaderSource.map((point) => ({
            x: point.x * scaleX,
            y: point.y * scaleY,
          })),
          calloutRef: ref,
        },
      });
    }
  });

  return markups;
}
