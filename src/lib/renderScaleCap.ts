/** Cap backing-store pixels so a 24x36 at high DPR cannot allocate unbounded canvases. */

export const MAX_RENDER_PIXELS = 16_777_216;
export const MAX_RENDER_EDGE = 8192;

export function capRenderScale(
  requestedScale: number,
  pageWidthPts: number,
  pageHeightPts: number,
): number {
  if (!(requestedScale > 0) || !(pageWidthPts > 0) || !(pageHeightPts > 0)) {
    return requestedScale;
  }
  const rawW = pageWidthPts * requestedScale;
  const rawH = pageHeightPts * requestedScale;
  const edge = Math.max(rawW, rawH);
  const pixels = rawW * rawH;
  const edgeScale = edge > MAX_RENDER_EDGE ? MAX_RENDER_EDGE / edge : 1;
  const pixelScale = pixels > MAX_RENDER_PIXELS ? Math.sqrt(MAX_RENDER_PIXELS / pixels) : 1;
  return requestedScale * Math.min(1, edgeScale, pixelScale);
}

/** CSS-pixel size used for markup mapping — always the uncapped requested scale. */
export function cssPageSize(requestedScale: number, pageWidthPts: number, pageHeightPts: number): {
  width: number;
  height: number;
} {
  return {
    width: pageWidthPts * requestedScale,
    height: pageHeightPts * requestedScale,
  };
}

export function mapCssPointToPage(
  cssX: number,
  cssY: number,
  cssWidth: number,
  cssHeight: number,
): { x: number; y: number } {
  return {
    x: cssWidth === 0 ? 0 : (cssX / cssWidth) * cssWidth,
    y: cssHeight === 0 ? 0 : (cssY / cssHeight) * cssHeight,
  };
}
