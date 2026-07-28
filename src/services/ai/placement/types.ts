import { BASE_RENDER_SCALE } from '@/lib/coordinateUtils';

/** Document-point space: PDF page points at scale 1, top-left origin. */
export type DocPoint = { x: number; y: number };
export type DocRect = { x: number; y: number; width: number; height: number };

export type PageRotationDeg = 0 | 90 | 180 | 270;

export interface PageGeometry {
  pageNumber: number;
  docWidth: number;
  docHeight: number;
  renderScale: number;
  rotationDeg: PageRotationDeg;
}

export interface PageCalibration {
  pageNumber: number;
  method: 'manual' | 'scale_bar' | 'inferred' | 'none';
  /** Document points per real-world unit. */
  pixelsPerUnit: number | null;
  unit: string | null;
  confidence: number;
  source?: { pointA: DocPoint; pointB: DocPoint; knownDistance: number };
}

export interface PageTextBlock {
  id: string;
  text: string;
  bounds: DocRect;
  confidence?: number;
}

export interface PageLayoutModel {
  page: PageGeometry;
  textBlocks: PageTextBlock[];
  lines?: Array<{ id: string; text: string; bounds: DocRect }>;
  extractedAt: string;
  source: 'native' | 'ocr' | 'mixed';
  renderScaleUsed: number;
}

export type GeometryAnchorType =
  | 'text'
  | 'corner'
  | 'edge'
  | 'endpoint'
  | 'midpoint'
  | 'intersection'
  | 'symbol'
  | 'vector'
  | 'manual';

export interface GeometryAnchor {
  id: string;
  type: GeometryAnchorType;
  point?: DocPoint;
  segment?: { a: DocPoint; b: DocPoint };
  bounds?: DocRect;
  label?: string;
  confidence: number;
  source: 'pdf_vector' | 'ocr' | 'vision' | 'user' | 'native';
}

export type MarkupPlacementMode = 'exact' | 'snap_adjusted' | 'estimated' | 'needs_review';

export interface MarkupProposal {
  id: string;
  pageNumber: number;
  markupType: string;
  boundingBox: DocRect;
  anchor?: { type: GeometryAnchorType; refId?: string };
  confidence: number;
  placementMode: MarkupPlacementMode;
  rationale: string;
  sourceSignals: string[];
}

export interface VerificationIssue {
  code: 'out_of_bounds' | 'transform_unstable' | 'low_confidence' | 'missing_calibration' | 'duplicate' | 'other';
  message: string;
  severity: 'error' | 'warning';
}

export interface VerificationResult {
  ok: boolean;
  proposal: MarkupProposal;
  issues: VerificationIssue[];
  /** True when confidence/mode requires user confirmation before commit. */
  requiresConfirmation: boolean;
}

export const DEFAULT_RENDER_SCALE = BASE_RENDER_SCALE;

export const CONFIDENCE_AUTO = 0.75;
export const CONFIDENCE_REVIEW = 0.45;
