import type { Document } from './editor';
import type { ProductNode } from './product';

export interface ProjectFile {
  version: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  documents: ProjectDocument[];
  products: {
    nodes: Record<string, ProductNode>;
    rootIds: string[];
  };
  settings: ProjectSettings;
}

export interface ProjectDocument {
  id: string;
  name: string;
  originalPath?: string; // Path to original PDF
  pdfData: string; // Base64 encoded ORIGINAL PDF (no markups baked in)
  pages: number;
  currentPage: number;
  zoom: number;
  markups: any[]; // Separate editable markup data
  measurements: any[]; // Separate editable measurement data
}

export interface ProjectSettings {
  scale: number | null;
  scaleUnit: string;
  snapEnabled: boolean;
  gridEnabled: boolean;
}

export interface SaveProjectResult {
  success: boolean;
  path?: string;
  name?: string;
  error?: string;
  canceled?: boolean;
}
