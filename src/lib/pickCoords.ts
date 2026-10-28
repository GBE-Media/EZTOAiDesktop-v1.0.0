/**
 * Question-card picks (points / keep-clear boxes) are stored as percent of the *displayed* page —
 * the same space the AI tools read (`page.pageWidth`/`pageHeight`, rotation included). The markup
 * overlay canvas is exactly the displayed page (rotated, at the render scale), so the conversion
 * is a plain ratio of the canvas size. Never route these through doc-point geometry: the canvas is
 * in render pixels (×1.5), which made every pick land 1.5× too far right/down and clipped boxes
 * outside the top-left two-thirds of the sheet.
 */
export interface PagePct { xPct: number; yPct: number }

const clampPct = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0);
const round1 = (v: number) => Math.round(v * 1000) / 1000;

export function canvasPointToPagePct(point: { x: number; y: number }, width: number, height: number): PagePct {
  if (!(width > 0) || !(height > 0)) return { xPct: 0, yPct: 0 };
  return { xPct: round1(clampPct((point.x / width) * 100)), yPct: round1(clampPct((point.y / height) * 100)) };
}

export function pagePctToCanvasPoint(pct: PagePct, width: number, height: number): { x: number; y: number } {
  return { x: (clampPct(pct.xPct) / 100) * width, y: (clampPct(pct.yPct) / 100) * height };
}

/** Dragged box (two canvas points) → page-percent box. */
export function canvasBoxToPagePct(
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  height: number,
): { xPct: number; yPct: number; wPct: number; hPct: number } {
  const p1 = canvasPointToPagePct({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y) }, width, height);
  const p2 = canvasPointToPagePct({ x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) }, width, height);
  return { xPct: p1.xPct, yPct: p1.yPct, wPct: round1(p2.xPct - p1.xPct), hPct: round1(p2.yPct - p1.yPct) };
}
