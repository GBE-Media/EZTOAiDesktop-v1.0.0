import { normalizeCsiSection } from './csi';
import type { IndexedLine, IndexedPageRecord, SearchHit, SearchPassage } from './types';

export function buildSearchPassages(lines: IndexedLine[]): SearchPassage[] {
  const passages: SearchPassage[] = [];
  for (let i = 0; i < lines.length; i += 4) {
    const group = lines.slice(i, i + 5);
    const text = group.map(l => l.text).join(' ').trim();
    if (!text) continue;
    passages.push({
      text: text.slice(0, 300),
      lower: text.toLowerCase(),
      bounds: group[0]?.bbox,
    });
  }
  return passages;
}

function queryParts(query: string): { tokens: string[]; codes: string[]; phrase?: string; csi?: string } {
  const phrase = query.match(/"([^"]+)"/)?.[1]?.toLowerCase();
  const codes = (query.match(/[A-Za-z]{1,4}[-.]?\d[\w.-]*/g) || []).map(c => c.toLowerCase());
  const csi = normalizeCsiSection(query);
  const tokens = query
    .toLowerCase()
    .replace(/[“”"']/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(tok => tok.length > 1);
  if (csi && /\d/.test(csi)) {
    tokens.push(...csi.toLowerCase().split(/\s+/).filter(t => t.length > 1));
    tokens.push(csi.replace(/\s+/g, ''));
  }
  return { tokens: [...new Set(tokens)], codes: [...new Set(codes)], phrase, csi: csi || undefined };
}

type CompiledPage = {
  hay: string;
  snippet: string;
  bounds?: SearchPassage['bounds'];
  tokens: Set<string>;
};

const compiledCache = new WeakMap<IndexedPageRecord, CompiledPage>();

function compilePage(page: IndexedPageRecord): CompiledPage {
  const cached = compiledCache.get(page);
  if (cached) return cached;
  const passages = page.passages?.length ? page.passages : buildSearchPassages(page.lines || []);
  const hay = passages.map(p => p.lower).join(' ')
    || (page.lines || []).map(l => l.text).join(' ').toLowerCase();
  const tokens = new Set(hay.split(/[^a-z0-9]+/).filter(t => t.length > 1));
  for (const code of hay.match(/[a-z]{1,4}[-.]?\d[\w.-]*/g) || []) tokens.add(code);
  const compiled: CompiledPage = {
    hay,
    snippet: (passages[0]?.text || hay).slice(0, 300),
    bounds: passages[0]?.bounds || page.lines?.[0]?.bbox,
    tokens,
  };
  compiledCache.set(page, compiled);
  return compiled;
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
  const parts = queryParts(options.query);
  const section = options.section ? normalizeCsiSection(options.section) : undefined;
  const scored: SearchHit[] = [];

  for (const page of pages) {
    if (options.kind && page.kind !== options.kind) continue;
    if (options.discipline && page.discipline !== options.discipline) continue;
    if (options.documentIds?.length && !options.documentIds.includes(page.docId)) continue;
    if (section && page.specSection !== section && page.sheetNumber !== options.section) {
      const hay = page.passages?.map(p => p.lower).join(' ')
        || (page.lines || []).map(l => l.text).join(' ').toLowerCase();
      if (!hay.includes(section.toLowerCase()) && !hay.includes(section.replace(/\s+/g, ''))) continue;
    }

    if (page.passages?.length) {
      let score = 0;
      let snippet = page.passages[0].text.slice(0, 300);
      let bounds = page.passages[0].bounds;
      let best = 0;
      for (const passage of page.passages) {
        let local = 0;
        for (const token of parts.tokens) if (passage.lower.includes(token)) local += 1;
        for (const code of parts.codes) if (passage.lower.includes(code)) local += 10;
        if (parts.phrase && passage.lower.includes(parts.phrase)) local += 12;
        if (local > best) {
          best = local;
          snippet = passage.text.slice(0, 300);
          bounds = passage.bounds;
        }
        score += local;
      }
      if (page.sheetNumber && options.query.toUpperCase().includes(page.sheetNumber)) score += 8;
      if (score <= 0) continue;
      scored.push({
        documentId: page.docId,
        documentName: page.documentName,
        page: page.page,
        pageLabel: page.label,
        sheetNumber: page.sheetNumber,
        specSection: page.specSection,
        snippet,
        bounds,
        score,
      });
      continue;
    }

    let compiled: CompiledPage;
    if (parts.codes.length && !page.passages?.length) {
      const needles = parts.codes;
      let snippetLine: IndexedLine | undefined;
      for (const line of page.lines || []) {
        const lower = line.text.toLowerCase();
        if (needles.some(code => lower.includes(code))) {
          snippetLine = line;
          break;
        }
      }
      if (!snippetLine) continue;
      compiled = {
        hay: snippetLine.text.toLowerCase(),
        snippet: snippetLine.text.slice(0, 300),
        bounds: snippetLine.bbox,
        tokens: new Set(needles),
      };
    } else {
      compiled = compilePage(page);
    }
    let score = 0;
    let snippet = compiled.snippet;
    let bounds = compiled.bounds;
    for (const token of parts.tokens) {
      if (compiled.tokens.has(token) || compiled.hay.includes(token)) score += 1;
    }
    for (const code of parts.codes) {
      if (compiled.hay.includes(code) || compiled.tokens.has(code)) score += 10;
    }
    if (parts.phrase && compiled.hay.includes(parts.phrase)) score += 12;
    if (page.sheetNumber && options.query.toUpperCase().includes(page.sheetNumber)) score += 8;
    if (score <= 0) continue;

    if (page.passages?.length) {
      let best = 0;
      for (const passage of page.passages) {
        let local = 0;
        for (const token of parts.tokens) if (passage.lower.includes(token)) local += 1;
        for (const code of parts.codes) if (passage.lower.includes(code)) local += 10;
        if (local > best) {
          best = local;
          snippet = passage.text.slice(0, 300);
          bounds = passage.bounds;
        }
      }
    }

    scored.push({
      documentId: page.docId,
      documentName: page.documentName,
      page: page.page,
      pageLabel: page.label,
      sheetNumber: page.sheetNumber,
      specSection: page.specSection,
      snippet: snippet.slice(0, 300),
      bounds,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
