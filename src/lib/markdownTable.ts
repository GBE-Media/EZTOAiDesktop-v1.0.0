const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*(:?-{2,}:?\s*)?\|?\s*$/;

export function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

/** GFM pipe table starting at `start` (header row + separator row + body rows). */
export function readMarkdownTable(
  lines: string[],
  start: number,
): { header: string[]; rows: string[][]; endIndex: number } | null {
  if (!TABLE_ROW_RE.test(lines[start] || '') || !TABLE_SEPARATOR_RE.test(lines[start + 1] || '')) return null;
  const header = splitTableRow(lines[start]);
  const rows: string[][] = [];
  let end = start + 1;
  while (end + 1 < lines.length && TABLE_ROW_RE.test(lines[end + 1])) {
    end += 1;
    rows.push(splitTableRow(lines[end]));
  }
  return { header, rows, endIndex: end };
}

