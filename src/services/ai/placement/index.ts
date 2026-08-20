export { BASE_RENDER_SCALE, createPageGeometry, docToRender, docRectToRender, renderToDoc, renderRectToDoc, pctToDoc, pctRectToDoc, docToPct, clampDocRect, isRectInPage, rectCenter, roundTripStable } from './coords';
export type {
  DocPoint,
  DocRect,
  PageGeometry,
  PageCalibration,
  PageLayoutModel,
  PageTextBlock,
  GeometryAnchor,
  GeometryAnchorType,
  MarkupProposal,
  MarkupPlacementMode,
  VerificationIssue,
  VerificationResult,
  PageRotationDeg,
} from './types';
export {
  DEFAULT_RENDER_SCALE,
  CONFIDENCE_AUTO,
  CONFIDENCE_REVIEW,
} from './types';
export { buildPageLayoutModel } from './pageModel';
export { anchorsFromLayout, anchorsFromVectorSnap } from './anchors';
export { resolvePageAnchors } from './resolvePageAnchors';
export { snapProposalToAnchors } from './snap';
export {
  confidencePlacementBand,
  partitionMarkupsByConfidence,
  commitMarkupsByConfidence,
  type ConfidencePlacementBand,
  type PageMarkupPair,
} from './confidenceGate';
export { verifyMarkupProposal, type VerifyContext } from './verify';
export { verifyPlacementMarkupsByPage } from './verifyPlacementsByPage';
export { proposalsFromChatPointers, proposalsFromPlacementMarkups } from './proposals';
export {
  convertPlacementsToMarkups,
  isUsableVerifiedBox,
  reattachLeaderToVerifiedBox,
  type PlacementVerificationMeta,
} from './convertPlacements';
export {
  loadPageGeometries,
  GEOMETRY_FAILURE_NOTE,
  geometryFailureConfidence,
  type PageGeometryLoadResult,
  type PdfDocumentLike,
} from './loadPageGeometries';
export { canvasMarkupToPlacementMarkup } from './canvasMarkupToPlacement';
export {
  normalizeAgentMarkupPayload,
  verifyPlacementMarkupsWithGeometryGate,
  type NormalizeAgentMarkupOptions,
} from './normalizeAgentMarkupPayload';
export {
  usePlacementDebugStore,
  applyDebugSceneUpdate,
  type PlacementDebugState,
} from './debugStore';
export { activatePlacementDebugForPage } from './activateDebug';
