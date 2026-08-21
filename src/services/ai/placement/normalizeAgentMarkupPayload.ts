import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import type { ChatMarkupPointer, PlacementMarkup } from '../providers/types';
import { chatPointersToGreenPlacements } from '../callouts';
import { BASE_RENDER_SCALE } from './coords';
import { convertPlacementsToMarkups, type PlacementVerificationMeta } from './convertPlacements';
import { canvasMarkupToPlacementMarkup } from './canvasMarkupToPlacement';
import {
  GEOMETRY_FAILURE_NOTE,
  geometryFailureConfidence,
  loadPageGeometries,
  type PdfDocumentLike,
} from './loadPageGeometries';
import { parseChatMarkupPointerRow } from './parseChatMarkupPointer';
import { resolvePageAnchors } from './resolvePageAnchors';
import { CONFIDENCE_REVIEW, type GeometryAnchor, type PageCalibration, type PageGeometry, type VerificationResult } from './types';
import { verifyPlacementMarkupsByPage } from './verifyPlacementsByPage';
import { useCanvasStore } from '@/store/canvasStore';
import { nonePageCalibration } from './pageCalibration';

export type NormalizeAgentMarkupOptions = {
  payload: unknown;
  page: number;
  pageWidth: number;
  pageHeight: number;
  idPrefix: string;
  messageId: string;
  defaultStyle: MarkupStyle;
  pdfDocument?: PdfDocumentLike | null;
  resolveAnchors?: (page: PageGeometry, pageNumber: number) => GeometryAnchor[];
  getPageDimensions?: (
    document: PdfDocumentLike,
    pageNumber: number,
  ) => Promise<{ width: number; height: number }>;
};

function appendGeometryFailureNote(existing?: string): string {
  if (!existing?.trim()) return GEOMETRY_FAILURE_NOTE;
  if (existing.includes(GEOMETRY_FAILURE_NOTE)) return existing;
  return `${existing} (${GEOMETRY_FAILURE_NOTE})`;
}

function verificationMetaFromResults(
  verified: VerificationResult[],
): PlacementVerificationMeta[] {
  return verified.map(item => ({
    id: item.proposal.id,
    pending: item.requiresConfirmation,
    confidence: item.proposal.confidence,
    boundingBox: item.proposal.boundingBox,
  }));
}

function failureVerificationMeta(markups: PlacementMarkup[]): PlacementVerificationMeta[] {
  const confidence = geometryFailureConfidence(CONFIDENCE_REVIEW);
  return markups.map((markup, index) => ({
    id: markup.id || `proposal_pl_${index}`,
    pending: true,
    confidence,
    // Intentionally omit boundingBox — do not invent corrected geometry.
  }));
}

function withMessageId(
  pairs: Array<{ page: number; markup: CanvasMarkup }>,
  messageId: string,
): Array<{ page: number; markup: CanvasMarkup }> {
  return pairs.map(({ page, markup }) => ({
    page,
    markup: { ...markup, messageId } as CanvasMarkup,
  }));
}

function resolveCalibrationForPage(pageNumber: number): PageCalibration {
  const getPageCalibration = useCanvasStore.getState().getPageCalibration;
  if (typeof getPageCalibration !== 'function') {
    return nonePageCalibration(pageNumber);
  }
  return getPageCalibration(pageNumber);
}

function convertVerifiedBatch(options: {
  markups: PlacementMarkup[];
  geometryByPage: Map<number, PageGeometry>;
  defaultStyle: MarkupStyle;
  idPrefix: string;
  resolveAnchors: (page: PageGeometry, pageNumber: number) => GeometryAnchor[];
  resolveCalibration?: (pageNumber: number) => PageCalibration | null;
}): Array<{ page: number; markup: CanvasMarkup }> {
  if (options.markups.length === 0) return [];

  const verified = verifyPlacementMarkupsByPage({
    markups: options.markups,
    enableSnap: true,
    resolvePageContext: (pageNumber) => {
      const page = options.geometryByPage.get(pageNumber);
      if (!page) {
        throw new Error(`Missing page geometry for page ${pageNumber}`);
      }
      return {
        page,
        anchors: options.resolveAnchors(page, pageNumber),
        calibration: options.resolveCalibration?.(pageNumber) ?? null,
      };
    },
  });

  return convertPlacementsToMarkups(
    { markups: options.markups, notes: [] },
    options.defaultStyle,
    options.idPrefix,
    BASE_RENDER_SCALE,
    BASE_RENDER_SCALE,
    verificationMetaFromResults(verified),
  );
}

function convertUnverifiableBatch(options: {
  markups: PlacementMarkup[];
  defaultStyle: MarkupStyle;
  idPrefix: string;
}): Array<{ page: number; markup: CanvasMarkup }> {
  if (options.markups.length === 0) return [];
  const annotated = options.markups.map(markup => ({
    ...markup,
    aiNote: appendGeometryFailureNote(markup.aiNote),
    confidence: geometryFailureConfidence(CONFIDENCE_REVIEW),
    pending: true,
  }));
  return convertPlacementsToMarkups(
    { markups: annotated, notes: [] },
    options.defaultStyle,
    options.idPrefix,
    BASE_RENDER_SCALE,
    BASE_RENDER_SCALE,
    failureVerificationMeta(annotated),
  );
}

/**
 * Normalize agent/pipeline approval payloads into page+markup pairs with
 * per-page verification. Legacy [{page, markup}] and pointer rows that carry
 * their own page are grouped and verified against each page's real geometry.
 */
export async function normalizeAgentMarkupPayload(
  options: NormalizeAgentMarkupOptions,
): Promise<Array<{ page: number; markup: CanvasMarkup }>> {
  const raw = options.payload;
  if (!raw) return [];

  const asArray = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { payload?: unknown }).payload)
      ? (raw as { payload: unknown[] }).payload
      : Array.isArray((raw as { markups?: unknown[] }).markups)
        ? (raw as { markups: unknown[] }).markups
        : Array.isArray((raw as { callouts?: unknown[] }).callouts)
          ? (raw as { callouts: unknown[] }).callouts
          : Array.isArray((raw as { pointers?: unknown[] }).pointers)
            ? (raw as { pointers: unknown[] }).pointers
            : null;

  if (!asArray || asArray.length === 0) return [];

  const resolveAnchors = options.resolveAnchors
    || ((page: PageGeometry, pageNumber: number) => resolvePageAnchors({ page, pageNumber }));

  const first = asArray[0] as Record<string, unknown>;
  if (first && typeof first === 'object' && first.markup) {
    const legacy = asArray.filter((item): item is { page: number; markup: CanvasMarkup } => {
      const row = item as { page?: number; markup?: CanvasMarkup };
      return !!row?.markup;
    });
    if (legacy.length > 0) {
      const placementMarkups = legacy
        .map((item) => {
          const page = item.page || item.markup.page || options.page;
          return canvasMarkupToPlacementMarkup(page, {
            ...item.markup,
            page,
          } as CanvasMarkup);
        })
        .filter((item): item is PlacementMarkup => !!item);

      const pageNumbers = placementMarkups.map(markup => markup.page || options.page);
      const { geometryByPage, failedPages } = await loadPageGeometries({
        pageNumbers,
        pdfDocument: options.pdfDocument,
        singlePageFallback: {
          pageNumber: options.page,
          width: options.pageWidth,
          height: options.pageHeight,
        },
        getPageDimensions: options.getPageDimensions,
      });

      const verifiable = placementMarkups.filter(
        markup => !failedPages.has(markup.page || options.page),
      );
      const unverifiable = placementMarkups.filter(
        markup => failedPages.has(markup.page || options.page),
      );

      const converted = [
        ...convertVerifiedBatch({
          markups: verifiable,
          geometryByPage,
          defaultStyle: options.defaultStyle,
          idPrefix: options.idPrefix,
          resolveAnchors,
          resolveCalibration: resolveCalibrationForPage,
        }),
        ...convertUnverifiableBatch({
          markups: unverifiable,
          defaultStyle: options.defaultStyle,
          idPrefix: options.idPrefix,
        }),
      ];
      return withMessageId(converted, options.messageId);
    }
  }

  const rawPointerRows = asArray
    .map((item, index) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const pageRaw = row.page;
      const pageNumber = typeof pageRaw === 'number' && Number.isFinite(pageRaw) && pageRaw > 0
        ? pageRaw
        : options.page;
      return { row, index, pageNumber };
    })
    .filter((item): item is { row: Record<string, unknown>; index: number; pageNumber: number } => !!item);

  if (rawPointerRows.length === 0) return [];

  const pageNumbers = rawPointerRows.map(item => item.pageNumber);
  const { geometryByPage, failedPages } = await loadPageGeometries({
    pageNumbers,
    pdfDocument: options.pdfDocument,
    singlePageFallback: {
      pageNumber: options.page,
      width: options.pageWidth,
      height: options.pageHeight,
    },
    getPageDimensions: options.getPageDimensions,
  });

  const verifiablePointers: ChatMarkupPointer[] = [];
  const unverifiablePointers: ChatMarkupPointer[] = [];

  for (const { row, index, pageNumber } of rawPointerRows) {
    if (failedPages.has(pageNumber) || !geometryByPage.has(pageNumber)) {
      // Still try DocPoint-native parse without page clamp for review stub identity.
      const parsed = parseChatMarkupPointerRow(row, { defaultRef: index + 1 });
      unverifiablePointers.push({
        type: (parsed?.type || 'callout'),
        ref: parsed?.ref || index + 1,
        point: parsed?.point || { x: 0, y: 0 },
        bounds: parsed?.bounds,
        page: pageNumber,
        label: parsed?.label || (typeof row.label === 'string' ? row.label : `Callout ${index + 1}`),
        note: parsed?.note || (typeof row.note === 'string' ? row.note : undefined),
        confidence: parsed?.confidence,
      });
      continue;
    }

    const page = geometryByPage.get(pageNumber)!;
    const parsed = parseChatMarkupPointerRow(row, {
      defaultRef: index + 1,
      pageWidth: page.docWidth,
      pageHeight: page.docHeight,
    });
    if (!parsed) continue;
    verifiablePointers.push({
      ...parsed,
      page: parsed.page ?? pageNumber,
      label: parsed.label || `Callout ${parsed.ref}`,
    });
  }

  const byPage = new Map<number, ChatMarkupPointer[]>();
  for (const pointer of verifiablePointers) {
    const pageNumber = pointer.page ?? options.page;
    const group = byPage.get(pageNumber) || [];
    group.push(pointer);
    byPage.set(pageNumber, group);
  }

  const placementMarkups: PlacementMarkup[] = [];
  for (const [pageNumber, group] of byPage) {
    const page = geometryByPage.get(pageNumber)!;
    const placements = chatPointersToGreenPlacements({
      pointers: group,
      page: pageNumber,
      pageWidth: page.docWidth,
      pageHeight: page.docHeight,
      idPrefix: options.idPrefix,
    });
    placementMarkups.push(...placements.markups);
  }

  const unverifiableMarkups: PlacementMarkup[] = [];
  for (const pointer of unverifiablePointers) {
    const pageNumber = pointer.page ?? options.page;
    // Without trusted page size, do not invent placement geometry from page-1 dims.
    // Emit a review-only stub anchored at the origin for the review queue.
    unverifiableMarkups.push({
      id: `${options.idPrefix}_callout_${pointer.ref}`,
      type: 'callout',
      page: pageNumber,
      points: [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      style: {
        strokeColor: '#10b981',
        fillColor: 'rgba(16, 185, 129, 0.18)',
        strokeWidth: 2,
        fontSize: 12,
        fontFamily: 'Arial',
      },
      label: pointer.label,
      content: `[${pointer.ref}] ${pointer.label || `Callout ${pointer.ref}`}`,
      calloutRef: pointer.ref,
      aiNote: appendGeometryFailureNote(pointer.note),
      confidence: geometryFailureConfidence(CONFIDENCE_REVIEW),
      pending: true,
    });
  }

  const converted = [
    ...convertVerifiedBatch({
      markups: placementMarkups,
      geometryByPage,
      defaultStyle: options.defaultStyle,
      idPrefix: options.idPrefix,
      resolveAnchors,
      resolveCalibration: resolveCalibrationForPage,
    }),
    ...convertUnverifiableBatch({
      markups: unverifiableMarkups,
      defaultStyle: options.defaultStyle,
      idPrefix: options.idPrefix,
    }),
  ];

  return withMessageId(converted, options.messageId);
}

/**
 * Split placement markups into verified canvas pairs vs geometry-failure review pairs.
 * Used by Path A (pipeline placements) when per-page dimension lookup fails.
 */
export async function verifyPlacementMarkupsWithGeometryGate(options: {
  markups: PlacementMarkup[];
  pdfDocument?: PdfDocumentLike | null;
  defaultStyle: MarkupStyle;
  idPrefix: string;
  resolveAnchors?: (page: PageGeometry, pageNumber: number) => GeometryAnchor[];
  getPageDimensions?: (
    document: PdfDocumentLike,
    pageNumber: number,
  ) => Promise<{ width: number; height: number }>;
}): Promise<{
  verified: Array<{ page: number; markup: CanvasMarkup }>;
  reviewOnly: Array<{ page: number; markup: CanvasMarkup }>;
  geometryByPage: Map<number, PageGeometry>;
  failedPages: Set<number>;
  verifiedResults: VerificationResult[];
}> {
  const pageNumbers = options.markups.map(markup => markup.page || 1);
  const { geometryByPage, failedPages } = await loadPageGeometries({
    pageNumbers,
    pdfDocument: options.pdfDocument,
    // Path A must never fall back to document-wide page-1 dimensions.
    getPageDimensions: options.getPageDimensions,
  });

  const resolveAnchors = options.resolveAnchors
    || ((page: PageGeometry, pageNumber: number) => resolvePageAnchors({ page, pageNumber }));

  const verifiable = options.markups.filter(
    markup => !failedPages.has(markup.page || 1),
  );
  const unverifiable = options.markups.filter(
    markup => failedPages.has(markup.page || 1),
  );

  const verifiedResults = verifiable.length > 0
    ? verifyPlacementMarkupsByPage({
      markups: verifiable,
      enableSnap: true,
      resolvePageContext: (pageNumber) => {
        const page = geometryByPage.get(pageNumber);
        if (!page) {
          throw new Error(`Missing page geometry for page ${pageNumber}`);
        }
        return {
          page,
          anchors: resolveAnchors(page, pageNumber),
          calibration: resolveCalibrationForPage(pageNumber),
        };
      },
    })
    : [];

  const verified = convertPlacementsToMarkups(
    { markups: verifiable, notes: [] },
    options.defaultStyle,
    options.idPrefix,
    BASE_RENDER_SCALE,
    BASE_RENDER_SCALE,
    verificationMetaFromResults(verifiedResults),
  );

  const reviewOnly = convertUnverifiableBatch({
    markups: unverifiable,
    defaultStyle: options.defaultStyle,
    idPrefix: options.idPrefix,
  });

  return {
    verified,
    reviewOnly,
    geometryByPage,
    failedPages,
    verifiedResults,
  };
}
