export type IndexPageKind = 'drawing' | 'spec' | 'other';

export type IndexedLine = {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
};

export type IndexedPageRecord = {
  docId: string;
  docFp: string;
  documentName: string;
  page: number;
  label?: string;
  lines: IndexedLine[];
  kind: IndexPageKind;
  sheetNumber?: string;
  sheetTitle?: string;
  discipline?: string;
  specSection?: string;
  articles?: Array<{ id: string; text: string }>;
  needsOcr: boolean;
};

export type SearchHit = {
  documentId: string;
  documentName: string;
  page: number;
  pageLabel?: string;
  sheetNumber?: string;
  specSection?: string;
  snippet: string;
  bounds?: { x: number; y: number; width: number; height: number };
  score: number;
};
