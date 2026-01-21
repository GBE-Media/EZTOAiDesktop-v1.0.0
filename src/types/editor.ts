import type { StampPreset } from './markup';

export type ToolType = 
  | 'select'
  | 'pan'
  | 'text'
  | 'highlight'
  | 'cloud'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'polyline'
  | 'polygon'
  | 'callout'
  | 'stamp'
  | 'freehand'
  | 'eraser'
  | 'count'
  | 'measure-length'
  | 'measure-area';

export interface Markup {
  id: string;
  type: ToolType;
  label: string;
  page: number;
  author: string;
  date: string;
  color: string;
  status: 'pending' | 'accepted' | 'rejected';
  locked: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  content?: string;
}

export interface Measurement {
  id: string;
  type: 'length' | 'area' | 'volume' | 'count';
  label: string;
  value: number;
  unit: string;
  page: number;
  date: string;
}

export interface Document {
  id: string;
  name: string;
  path: string;
  pages: number;
  currentPage: number;
  zoom: number;
  modified: boolean;
  markups: Markup[];
  measurements: Measurement[];
}

export interface EditorState {
  activeTool: ToolType;
  activeDocument: string | null;
  documents: Document[];
  selectedMarkups: string[];
  scale: number | null;
  scaleUnit: string;
  snapEnabled: boolean;
  gridEnabled: boolean;
  selectedStamp: StampPreset;
}

export interface ToolProperties {
  color: string;
  fillColor: string;
  opacity: number;
  lineWidth: number;
  fontSize: number;
  fontFamily: string;
}
