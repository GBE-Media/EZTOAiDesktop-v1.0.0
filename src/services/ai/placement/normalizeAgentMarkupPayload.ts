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
import {
  describeMissingCoordinates,
  parseChatMarkupPointerRow,
  readDocPointsArray,
} from './parseChatMarkupPointer';
import { resolvePageAnchors } from './resolvePageAnchors';
import { CONFIDENCE_REVIEW, type GeometryAnchor, type PageCalibration, type PageGeometry, type VerificationResult } from './types';
import { verifyPlacementMarkupsByPage } from './verifyPlacementsByPage';
import { useCanvasStore } from '@/store/canvasStore';
import { nonePageCalibration } from './pageCalibration';

function cacheLoadedPageGeometries(geometryByPage: Map<number, PageGeometry>): void {
  const canvas = useCanvasStore.getState();
  if (typeof canvas.cachePageGeometries === 'function') {
    canvas.cachePageGeometries(geometryByPage);
  }
}

/** Logged/reported when a pointer is dropped because legacy pct needs page size. */
export const POINTER_REJECTED_MISSING_PAGE_SIZE_NOTE =
  'could not determine placement — missing page size';

export type NormalizeDroppedRow = { index: number; reason: string };

export type NormalizeAgentMarkupResult = {
  markups: Array<{ page: number; markup: CanvasMarkup }>;
  dropped: NormalizeDroppedRow[];
  inputCount: number;
};

const PLACEMENT_TYPES = new Set<PlacementMarkup['type']>([
  'count-marker',
  'rectangle',
  'measurement-length',
  'measurement-area',
  'polyline',
  'polygon',
  'text',
  'callout',
]);

function isLegacyMarkupPair(item: unknown): item is { page: number; markup: CanvasMarkup } {
  if (!item || typeof item !== 'object') return false;
  const row = item as { markup?: unknown };
  return !!row.markup && typeof row.markup === 'object';
}

function looksLikePlacementMarkupRow(row: Record<string, unknown>): boolean {
  return Array.isArray(row.points);
}

function coercePlacementType(raw: unknown): PlacementMarkup['type'] {
  if (typeof raw === 'string' && PLACEMENT_TYPES.has(raw as PlacementMarkup['type'])) {
    return raw as PlacementMarkup['type'];
  }
  return 'count-marker';
}

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
  ) => Promise<{ width: number; height: number; rotationDeg?: import('./types').PageRotationDeg }>;
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
    options.geometryByPage,
    buildCalibrationByPage(options.markups, options.resolveCalibration),
  );
}

function buildCalibrationByPage(
  markups: PlacementMarkup[],
  resolveCalibration?: (pageNumber: number) => PageCalibration | null,
): Map<number, PageCalibration | null> {
  const map = new Map<number, PageCalibration | null>();
  const pages = new Set(markups.map(m => m.page || 1));
  for (const pageNumber of pages) {
    map.set(
      pageNumber,
      resolveCalibration?.(pageNumber) ?? resolveCalibrationForPage(pageNumber),
    );
  }
  return map;
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
    undefined,
    buildCalibrationByPage(annotated),
  );
}

/**
 * Normalize agent/pipeline approval payloads into page+markup pairs with
 * per-page verification. Legacy [{page, markup}] and pointer rows that carry
 * their own page are grouped and verified against each page's real geometry.
 */
export async function normalizeAgentMarkupPayload(
  options: NormalizeAgentMarkupOptions,
): Promise<NormalizeAgentMarkupResult> {
  const empty: NormalizeAgentMarkupResult = { markups: [], dropped: [], inputCount: 0 };
  const raw = options.payload;
  if (!raw) return empty;

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

  if (!asArray || asArray.length === 0) return empty;

  const resolveAnchors = options.resolveAnchors
    || ((page: PageGeometry, pageNumber: number) => resolvePageAnchors({ page, pageNumber }));

  const dropped: NormalizeDroppedRow[] = [];
  const wrap = (markups: Array<{ page: number; markup: CanvasMarkup }>): NormalizeAgentMarkupResult => ({
    markups,
    dropped,
    inputCount: asArray.length,
  });

  if (asArray.every(isLegacyMarkupPair)) {
    const legacy = asArray as Array<{ page: number; markup: CanvasMarkup }>;
    if (legacy.length > 0) {
      const pageNumbers = legacy.map(item => item.page || item.markup.page || options.page);
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
      cacheLoadedPageGeometries(geometryByPage);

      const placementMarkups = legacy
        .map((item) => {
          const page = item.page || item.markup.page || options.page;
          return canvasMarkupToPlacementMarkup(
            page,
            {
              ...item.markup,
              page,
            } as CanvasMarkup,
            BASE_RENDER_SCALE,
            geometryByPage.get(page) || null,
          );
        })
        .filter((item): item is PlacementMarkup => !!item);

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
      return wrap(withMessageId(converted, options.messageId));
    }
  }

  const rawPointerRows: Array<{ row: Record<string, unknown>; index: number; pageNumber: number }> = [];
  for (let index = 0; index < asArray.length; index += 1) {
    const item = asArray[index];
    if (!item || typeof item !== 'object') {
      dropped.push({ index, reason: 'row is not an object' });
      continue;
    }
    const row = item as Record<string, unknown>;
    const pageRaw = row.page;
    const pageNumber = typeof pageRaw === 'number' && Number.isFinite(pageRaw) && pageRaw > 0
      ? pageRaw
      : options.page;
    rawPointerRows.push({ row, index, pageNumber });
  }

  if (rawPointerRows.length === 0) return wrap([]);

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
  cacheLoadedPageGeometries(geometryByPage);

  const verifiablePointers: ChatMarkupPointer[] = [];
  const unverifiablePointers: ChatMarkupPointer[] = [];
  const directPlacements: PlacementMarkup[] = [];
  const unverifiableDirect: PlacementMarkup[] = [];

  const defaultStyle: PlacementMarkup['style'] = {
    strokeColor: options.defaultStyle.strokeColor,
    fillColor: options.defaultStyle.fillColor,
    strokeWidth: options.defaultStyle.strokeWidth,
    fontSize: options.defaultStyle.fontSize,
    fontFamily: options.defaultStyle.fontFamily,
  };

  const rejectRow = (index: number, reason: string) => {
    dropped.push({ index, reason });
    console.warn('[normalizeAgentMarkupPayload]', `row ${index + 1}: ${reason}`);
  };

  const toDirectPlacement = (
    row: Record<string, unknown>,
    index: number,
    pageNumber: number,
    points: NonNullable<ReturnType<typeof readDocPointsArray>>,
  ): PlacementMarkup => ({
    id: typeof row.id === 'string' && row.id.trim()
      ? row.id
      : `${options.idPrefix}_${coercePlacementType(row.type)}_${index + 1}`,
    type: coercePlacementType(row.type),
    page: pageNumber,
    points,
    style: defaultStyle,
    label: typeof row.label === 'string' ? row.label : undefined,
    content: typeof row.content === 'string' ? row.content : undefined,
    productId: typeof row.productId === 'string' && row.productId.trim() ? row.productId : undefined,
    linkedItemId: typeof row.linkedItemId === 'string' ? row.linkedItemId : undefined,
    confidence: typeof row.confidence === 'number' && Number.isFinite(row.confidence)
      ? Math.max(0, Math.min(1, row.confidence))
      : 0.85,
    pending: false,
    aiNote: typeof row.aiNote === 'string' ? row.aiNote : undefined,
  });

  for (const { row, index, pageNumber } of rawPointerRows) {
    const geometryFailed = failedPages.has(pageNumber) || !geometryByPage.has(pageNumber);

    if (looksLikePlacementMarkupRow(row)) {
      const points = readDocPointsArray(row.points);
      if (!points) {
        rejectRow(index, describeMissingCoordinates(row));
        continue;
      }
      const placement = toDirectPlacement(row, index, pageNumber, points);
      if (geometryFailed) {
        unverifiableDirect.push({
          ...placement,
          aiNote: appendGeometryFailureNote(placement.aiNote),
          confidence: geometryFailureConfidence(CONFIDENCE_REVIEW),
          pending: true,
        });
      } else {
        directPlacements.push(placement);
      }
      continue;
    }

    if (geometryFailed) {
      const parsed = parseChatMarkupPointerRow(row, { defaultRef: index + 1 });
      if (!parsed) {
        rejectRow(index, describeMissingCoordinates(row));
        continue;
      }
      unverifiablePointers.push({
        ...parsed,
        page: parsed.page ?? pageNumber,
        label: parsed.label || (typeof row.label === 'string' ? row.label : `Callout ${parsed.ref}`),
        note: parsed.note || (typeof row.note === 'string' ? row.note : undefined),
      });
      continue;
    }

    const page = geometryByPage.get(pageNumber)!;
    const parsed = parseChatMarkupPointerRow(row, {
      defaultRef: index + 1,
      pageWidth: page.docWidth,
      pageHeight: page.docHeight,
    });
    if (!parsed) {
      rejectRow(index, describeMissingCoordinates(row));
      continue;
    }
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

  const placementMarkups: PlacementMarkup[] = [...directPlacements];
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

  // Geometry load failed but pointer had real DocPoints: review-only stub.
  // Rejected/null parses are already dropped above — never fabricate (0,0) for those.
  const unverifiableMarkups: PlacementMarkup[] = [...unverifiableDirect];
  for (const pointer of unverifiablePointers) {
    const pageNumber = pointer.page ?? options.page;
    // Without trusted page size, do not invent placement from page-1 dims.
    // DocPoint identity is preserved in label/ref; geometry stays empty so convert
    // does not paint a fabricated origin box (see convertPlacements callout path).
    unverifiableMarkups.push({
      id: `${options.idPrefix}_callout_${pointer.ref}`,
      type: 'callout',
      page: pageNumber,
      points: [],
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

  return wrap(withMessageId(converted, options.messageId));
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
  ) => Promise<{ width: number; height: number; rotationDeg?: import('./types').PageRotationDeg }>;
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
  cacheLoadedPageGeometries(geometryByPage);

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
    geometryByPage,
    buildCalibrationByPage(verifiable),
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
