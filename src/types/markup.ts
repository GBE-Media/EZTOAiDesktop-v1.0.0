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
