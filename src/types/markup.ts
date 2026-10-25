export type MarkupType = 
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'cloud'
  | 'polygon'
  | 'polyline'
  | 'text'
  | 'callout'
  | 'highlight'
  | 'freehand'
  | 'stamp'
  | 'count-marker'
  | 'measurement-length'
  | 'measurement-area';

export type StampPreset = 'approved' | 'rejected' | 'draft' | 'reviewed' | 'confidential' | 'void';

export interface Point {
  x: number;
  y: number;
}

export interface MarkupStyle {
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  opacity: number;
  fontSize?: number;
  fontFamily?: string;
}

export interface BaseMarkup {
  id: string;
  type: MarkupType;
  page: number;
  style: MarkupStyle;
  locked: boolean;
  author: string;
  createdAt: string;
  label?: string;
  
  // AI-generated markup fields
  aiGenerated?: boolean;      // True if created by AI
  aiNote?: string;            // AI explanation or code reference
  aiPending?: boolean;        // True if awaiting user confirmation
  /** Unconfirmed AI review marker: drawn pending, excluded from confirmed counts. */
  reviewMarker?: boolean;
  aiConfidence?: number;      // AI confidence score (0-1)
  aiLinkedItemId?: string;    // Links to AI detected item
  calloutRef?: number;        // Numbered chat mention [N]
  messageId?: string;         // Assistant message that proposed this callout
  /** Suggested-run overlay data (home runs / branch circuitry / keep-out areas). */
  aiRun?: AiRunMeta;
}

/** Circuit data a suggested run needs to re-size itself after the user drags its points. */
export interface AiRunCircuit {
  id: string;
  label?: string;
  loadAmps?: number;
  loadVA?: number;
  voltage: number;
  phase: 1 | 3;
  continuous?: boolean;
  ocpdAmps?: number;
  /** Branch length beyond the home run to this circuit's farthest device, feet. */
  branchFt: number;
  /**
   * Distance from the home-run device to the circuit's load centre (fixtures spread along the
   * branch), feet — what voltage drop is computed on.
   */
  vdBranchFt?: number;
}

export interface AiRunMeta {
  runId: string;
  kind: 'homerun' | 'branch' | 'keepout' | 'panel';
  /** Panel this run belongs to (from the engineer's circuit tags or the user). */
  panel?: string;
  /** Home run continues to a panel on another sheet. */
  offSheet?: boolean;
  /**
   * Branch drawn as a Revit-style arc through its middle point (points = [start, mid, end]).
   * Footage = drawn arc length × footageFactor (the routed path between the two fixtures).
   */
  curve?: boolean;
  footageFactor?: number;
  /** What each foot of the run is made of (linked to a product on placement). */
  assembly?: { key: string; name: string; materials: Array<{ name: string; unit: 'ft'; perFt: number }> };
  /** Feet per document point used for lengths. */
  ftPerPt: number;
  lengthFt: number;
  circuits?: AiRunCircuit[];
  settings?: {
    wiringMethod: 'EMT' | 'PVC40' | 'RMC' | 'MC';
    material: 'cu' | 'al';
    vdTargetPct: number;
    verticalFt: number;
    necEdition: number;
  };
  /** Latest computed summary (shown as the run label). */
  summary?: string;
  vdPct?: number;
}

export interface RectangleMarkup extends BaseMarkup {
  type: 'rectangle' | 'ellipse' | 'highlight';
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LineMarkup extends BaseMarkup {
  type: 'line' | 'arrow';
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface PolygonMarkup extends BaseMarkup {
  type: 'polygon' | 'polyline' | 'cloud' | 'freehand';
  points: Point[];
}

export interface TextMarkup extends BaseMarkup {
  type: 'text' | 'callout';
  x: number;
  y: number;
  width: number;
  height: number;
  content: string;
  leaderPoints?: Point[]; // For callout
}

export interface StampMarkup extends BaseMarkup {
  type: 'stamp';
  x: number;
  y: number;
  width: number;
  height: number;
  preset: StampPreset;
}

export interface CountMarkerMarkup extends BaseMarkup {
  type: 'count-marker';
  x: number;
  y: number;
  number: number;
  groupId: string; // Groups related count markers
  productId?: string;
}

export interface MeasurementMarkup extends BaseMarkup {
  type: 'measurement-length' | 'measurement-area';
  points: Point[];
  value: number;
  unit: string;
  scaledValue: number;
  productId?: string;
  /** False when page has no PageCalibration — scaledValue is raw units only. */
  calibrated?: boolean;
}

export type CanvasMarkup = 
  | RectangleMarkup 
  | LineMarkup 
  | PolygonMarkup 
  | TextMarkup 
  | StampMarkup
  | CountMarkerMarkup
  | MeasurementMarkup;

export interface SelectionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapPoint {
  x: number;
  y: number;
  type: 'corner' | 'midpoint' | 'center' | 'endpoint' | 'grid' | 'document-endpoint' | 'document-line' | 'intersection';
}
