export type IndexPageKind = 'drawing' | 'spec' | 'other';

export type IndexedLine = {
  text: string;
  bbox: { x: number; y: number; width: number; height: number };
  fontHeight?: number;
};

export type SearchPassage = {
  text: string;
  lower: string;
  bounds?: { x: number; y: number; width: number; height: number };
  tokens?: string[];
};

export type IndexedPageRecord = {
  docId: string;
  docFp: string;
  documentName: string;
  page: number;
  label?: string;
  lines: IndexedLine[];
  /** Full page text for spec reads; kept in memory when line bboxes are slimmed. */
  text?: string;
  /** Text above a mid-page SECTION start; belongs to the previous section. */
  headText?: string;
  kind: IndexPageKind;
  sheetNumber?: string;
  sheetTitle?: string;
  discipline?: string;
  specSection?: string;
  articles?: Array<{ id: string; text: string }>;
  needsOcr: boolean;
  classifierVersion?: string;
  passages?: SearchPassage[];
  zones?: import('../detection/pageZones').PageZone[];
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
