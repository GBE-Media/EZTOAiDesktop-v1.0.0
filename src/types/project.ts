import type { Document } from './editor';
import type { LinkedMeasurement, ProductNode } from './product';

export interface ProjectFileRef {
  relPath: string;
  sha256: string;
  byteLength: number;
}

export interface ProjectFile {
  version: string;
  name: string;
  createdAt: string;
  modifiedAt: string;
  documents: ProjectDocument[];
  // Legacy 1.0 catalog snapshot. Read-only compatibility for older projects.
  products?: {
    nodes: Record<string, ProductNode>;
    rootIds: string[];
  };
  // Version 1.1+ stores only catalog references/snapshots used by this project.
  catalog?: {
    itemSnapshots: Record<string, ProductNode>;
    measurementLinks: Record<string, LinkedMeasurement[]>;
    activeItemId: string | null;
  };
  settings: ProjectSettings;
}

export interface ProjectDocument {
  id: string;
  name: string;
  originalPath?: string; // Path to original PDF
  /** Legacy v1: base64 original PDF. Absent on v2 when fileRef is set. */
  pdfData?: string;
  fileRef?: ProjectFileRef;
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
