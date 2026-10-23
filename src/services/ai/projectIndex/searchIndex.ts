import { normalizeCsiSection } from './csi';
import type { IndexedPageRecord, SearchHit } from './types';

function tokenize(query: string): string[] {
  const raw = query.toLowerCase().replace(/[“”"']/g, ' ');
  const base = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const codes = query.match(/[A-Za-z]{1,4}[-.]?\d[\w.-]*/g) || [];
  for (const code of codes) base.push(code.toLowerCase());
  const csi = normalizeCsiSection(query);
  if (csi && (/\d{6}/.test(csi.replace(/\s/g, '')) || csi !== query.trim())) {
    base.push(...csi.toLowerCase().split(/\s+/));
    base.push(csi.replace(/\s+/g, ''));
  }
  return [...new Set(base)];
}

export function searchIndexedPages(
  pages: IndexedPageRecord[],
  options: {
    query: string;
    kind?: string;
    discipline?: string;
    section?: string;
    documentIds?: string[];
    limit?: number;
  },
): SearchHit[] {
  const limit = Math.min(40, Math.max(1, options.limit ?? 10));
  const tokens = tokenize(options.query);
  const phrase = options.query.match(/"([^"]+)"/)?.[1]?.toLowerCase();
  const section = options.section ? normalizeCsiSection(options.section) : undefined;
  const scored: SearchHit[] = [];

  for (const page of pages) {
    if (options.kind && page.kind !== options.kind) continue;
    if (options.discipline && page.discipline !== options.discipline) continue;
    if (options.documentIds?.length && !options.documentIds.includes(page.docId)) continue;
    if (section && page.specSection !== section && page.sheetNumber !== options.section) {
      const hay = page.lines.map(l => l.text).join(' ').toLowerCase();
      if (!hay.includes(section.toLowerCase()) && !hay.includes(section.replace(/\s+/g, ''))) continue;
    }

    const passages: string[] = [];
    for (let i = 0; i < page.lines.length; i += 1) {
      const chunk = page.lines.slice(i, i + 5).map(l => l.text).join(' ');
      if (chunk.trim()) passages.push(chunk);
    }
    if (!passages.length && !page.needsOcr) continue;

    let best = 0;
    let snippet = passages[0] || '';
    let bounds = page.lines[0]?.bbox;
    for (let i = 0; i < page.lines.length; i++) {
      const group = page.lines.slice(i, i + 5);
      const text = group.map(l => l.text).join(' ');
      const lower = text.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (!token) continue;
        if (lower.includes(token)) score += token.includes('-') || /\d/.test(token) ? 8 : 1;
      }
      if (phrase && lower.includes(phrase)) score += 12;
      if (page.sheetNumber && options.query.toUpperCase().includes(page.sheetNumber)) score += 10;
      if (score > best) {
        best = score;
        snippet = text.slice(0, 300);
        bounds = group[0]?.bbox;
      }
    }
    if (best <= 0) continue;
    scored.push({
      documentId: page.docId,
      documentName: page.documentName,
      page: page.page,
      pageLabel: page.label,
      sheetNumber: page.sheetNumber,
      specSection: page.specSection,
      snippet,
      bounds,
      score: best,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
