import { normalizeCsiSection } from './csi';
import type { IndexedPageRecord } from './types';

const PAGE_CHARS = 6000;

export function readSpecSection(
  pages: IndexedPageRecord[],
  options: { section: string; part?: string | number; article?: string; cursor?: string },
): { text: string; nextCursor?: string; section: string } {
  const section = normalizeCsiSection(options.section);
  const matching = pages
    .filter(p => p.kind === 'spec' && p.specSection === section)
    .sort((a, b) => a.page - b.page);
  let text = matching.map(p => p.lines.map(l => l.text).join('\n')).join('\n\n');
  if (options.part != null) {
    const part = String(options.part).replace(/^part\s+/i, '');
    const re = new RegExp(`PART\\s+${part}\\b[\\s\\S]*?(?=PART\\s+[123]\\b|$)`, 'i');
    const slice = text.match(re);
    if (slice) text = slice[0];
  }
  if (options.article) {
    const id = options.article.trim();
    const lines = text.split('\n');
    const start = lines.findIndex(line => line.trim().startsWith(id));
    if (start >= 0) {
      const rest = lines.slice(start);
      const end = rest.findIndex((line, i) => i > 0 && /^\d+\.\d+/.test(line.trim()));
      text = (end > 0 ? rest.slice(0, end) : rest).join('\n');
    }
  }
  const offset = options.cursor ? Number(options.cursor) || 0 : 0;
  const next = offset + PAGE_CHARS;
  const chunk = text.slice(offset, next);
  return {
    text: chunk,
    nextCursor: next < text.length ? String(next) : undefined,
    section,
  };
}
