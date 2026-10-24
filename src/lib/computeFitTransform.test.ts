import { describe, expect, it } from 'vitest';
import {
  computeFitTransform,
  panDeltaKeepingCenter,
  visualPageCenter,
} from './computeFitTransform';

function expectCentered(
  containerW: number,
  containerH: number,
  pageW: number,
  pageH: number,
  rotation: number,
  padding = 64,
) {
  const fit = computeFitTransform({ containerW, containerH, pageW, pageH, rotation, padding });
  expect(fit).not.toBeNull();
  const center = visualPageCenter(pageW, pageH, fit!.offsetX, fit!.offsetY);
  expect(Math.abs(center.x - containerW / 2)).toBeLessThanOrEqual(1);
  expect(Math.abs(center.y - containerH / 2)).toBeLessThanOrEqual(1);
  const swapped = rotation === 90 || rotation === 270;
  const dispW = swapped ? pageH : pageW;
  const dispH = swapped ? pageW : pageH;
  expect(dispW * fit!.scale).toBeLessThanOrEqual(containerW - 2 * padding + 0.01);
  expect(dispH * fit!.scale).toBeLessThanOrEqual(containerH - 2 * padding + 0.01);
}

describe('computeFitTransform', () => {
  it('centers a portrait page', () => {
    expectCentered(1200, 800, 918, 1188, 0);
  });

  it('centers a landscape page', () => {
    expectCentered(1200, 800, 1188, 918, 0);
  });

  it('centers at rotation 0/90/180/270', () => {
    for (const rotation of [0, 90, 180, 270]) {
      expectCentered(1000, 700, 612 * 1.5, 792 * 1.5, rotation);
    }
  });

  it('fits a page larger than the container', () => {
    const fit = computeFitTransform({
      containerW: 400,
      containerH: 300,
      pageW: 1800,
      pageH: 2400,
      rotation: 0,
      padding: 40,
    });
    expect(fit).not.toBeNull();
    expect(fit!.scale).toBeLessThan(1);
    const center = visualPageCenter(1800, 2400, fit!.offsetX, fit!.offsetY);
    expect(Math.abs(center.x - 200)).toBeLessThanOrEqual(1);
    expect(Math.abs(center.y - 150)).toBeLessThanOrEqual(1);
  });

  it('fits a page much smaller than the container (scale up)', () => {
    const fit = computeFitTransform({
      containerW: 1600,
      containerH: 1200,
      pageW: 200,
      pageH: 200,
      rotation: 0,
      padding: 80,
    });
    expect(fit).not.toBeNull();
    expect(fit!.scale).toBeGreaterThan(1);
    const center = visualPageCenter(200, 200, fit!.offsetX, fit!.offsetY);
    expect(Math.abs(center.x - 800)).toBeLessThanOrEqual(1);
    expect(Math.abs(center.y - 600)).toBeLessThanOrEqual(1);
  });

  it('honors padding when computing scale', () => {
    const tight = computeFitTransform({
      containerW: 1000, containerH: 1000, pageW: 500, pageH: 500, rotation: 0, padding: 0,
    });
    const padded = computeFitTransform({
      containerW: 1000, containerH: 1000, pageW: 500, pageH: 500, rotation: 0, padding: 100,
    });
    expect(tight!.scale).toBeCloseTo(2, 5);
    expect(padded!.scale).toBeCloseTo(1.6, 5);
  });

  it('does not produce a fit when the container size is 0', () => {
    expect(computeFitTransform({
      containerW: 0, containerH: 800, pageW: 612, pageH: 792, rotation: 0,
    })).toBeNull();
    expect(computeFitTransform({
      containerW: 800, containerH: 0, pageW: 612, pageH: 792, rotation: 0,
    })).toBeNull();
  });

  it('does not produce a fit when the page size is 0', () => {
    expect(computeFitTransform({
      containerW: 800, containerH: 600, pageW: 0, pageH: 792, rotation: 0,
    })).toBeNull();
  });

  it('keeps the view-center document point when the container resizes', () => {
    const delta = panDeltaKeepingCenter(1000, 800, 1400, 800);
    expect(delta.x).toBe(200);
    expect(delta.y).toBe(0);
  });
});
