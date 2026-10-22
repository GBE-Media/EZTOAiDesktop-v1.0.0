export type PageAnalysisRef = {
  docId: string;
  page: number;
  revision: number;
  analyzedAt: string;
};

export function isPageAnalysisRef(value: unknown): value is PageAnalysisRef {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return typeof rec.docId === 'string' && rec.docId.trim().length > 0
    && typeof rec.page === 'number' && Number.isInteger(rec.page) && rec.page > 0
    && typeof rec.revision === 'number' && Number.isInteger(rec.revision) && rec.revision >= 0
    && typeof rec.analyzedAt === 'string' && rec.analyzedAt.trim().length > 0;
}
