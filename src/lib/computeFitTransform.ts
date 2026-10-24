/**
 * Viewport fit/center math for the PDF canvas.
 *
 * Layout model (must match Canvas.tsx):
 * - The page box is positioned at the container origin (0, 0).
 * - CSS transform is `translate(offsetX, offsetY) scale(scale) rotate(rotation)`
 *   with `transform-origin: center center`.
 * - Scale and rotation therefore do not move the page's layout center.
 * - Visual center = (pageW/2 + offsetX, pageH/2 + offsetY).
 *
 * Coordinates are CSS pixels of the rendered page box (already includes the
 * 1.5 base render scale). devicePixelRatio is not part of this math.
 */

export const FIT_PADDING_PX = 64;
export const FIT_ZOOM_MIN = 25;
export const FIT_ZOOM_MAX = 400;

export type FitTransformInput = {
  containerW: number;
  containerH: number;
  pageW: number;
  pageH: number;
  rotation?: number;
  padding?: number;
};

export type FitTransform = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

function normalizedRotation(rotation: number | undefined): number {
  const raw = Number.isFinite(rotation) ? Number(rotation) : 0;
  return ((Math.round(raw) % 360) + 360) % 360;
}

function displaySize(pageW: number, pageH: number, rotationDeg: number): { w: number; h: number } {
  const swapped = rotationDeg === 90 || rotationDeg === 270;
  return swapped ? { w: pageH, h: pageW } : { w: pageW, h: pageH };
}

/** Returns null when the container or page has no usable size (do not apply a fit). */
export function computeFitTransform(input: FitTransformInput): FitTransform | null {
  const containerW = input.containerW;
  const containerH = input.containerH;
  const pageW = input.pageW;
  const pageH = input.pageH;
  if (!(containerW > 0) || !(containerH > 0) || !(pageW > 0) || !(pageH > 0)) {
    return null;
  }

  const padding = input.padding ?? FIT_PADDING_PX;
  const rotationDeg = normalizedRotation(input.rotation);
  const displayed = displaySize(pageW, pageH, rotationDeg);
  const availW = Math.max(1, containerW - 2 * padding);
  const availH = Math.max(1, containerH - 2 * padding);
  const scale = Math.min(availW / displayed.w, availH / displayed.h);
  if (!Number.isFinite(scale) || scale <= 0) return null;

  return {
    scale,
    offsetX: (containerW - pageW) / 2,
    offsetY: (containerH - pageH) / 2,
  };
}

export function fitScaleToZoomPercent(scale: number): number {
  return Math.max(FIT_ZOOM_MIN, Math.min(FIT_ZOOM_MAX, Math.round(scale * 100)));
}

/** Screen-pixel pan delta so the document point at the view center stays put. */
export function panDeltaKeepingCenter(
  oldContainerW: number,
  oldContainerH: number,
  newContainerW: number,
  newContainerH: number,
): { x: number; y: number } {
  return {
    x: (newContainerW - oldContainerW) / 2,
    y: (newContainerH - oldContainerH) / 2,
  };
}

export function visualPageCenter(pageW: number, pageH: number, offsetX: number, offsetY: number): { x: number; y: number } {
  return {
    x: pageW / 2 + offsetX,
    y: pageH / 2 + offsetY,
  };
}
