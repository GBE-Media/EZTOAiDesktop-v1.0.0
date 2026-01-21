/**
 * PDF Vector Extractor
 * Extracts vector paths (lines, rectangles, curves) from PDF pages using PDF.js operator list.
 * Used for Bluebeam-style "Snap to Content" functionality.
 */

import * as pdfjsLib from 'pdfjs-dist';
import type { Point } from '@/types/markup';

export interface DocumentLine {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface DocumentSnapData {
  lines: DocumentLine[];
  endpoints: Point[];
  intersections: Point[];
}

// Minimum line length to consider (in PDF points, ~72 DPI)
const MIN_LINE_LENGTH = 3;

// Maximum number of lines to extract per page (performance limit)
const MAX_LINES_PER_PAGE = 5000;

// Sample points for bezier curves
const CURVE_SAMPLE_POINTS = 4;

/**
 * Calculate the distance between two points
 */
function distance(p1: Point, p2: Point): number {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
}

/**
 * Check if two points are approximately equal
 */
function pointsEqual(p1: Point, p2: Point, tolerance: number = 0.5): boolean {
  return Math.abs(p1.x - p2.x) < tolerance && Math.abs(p1.y - p2.y) < tolerance;
}

/**
 * Calculate line intersection point (if any)
 */
function lineIntersection(
  line1: DocumentLine,
  line2: DocumentLine
): Point | null {
  const x1 = line1.startX, y1 = line1.startY;
  const x2 = line1.endX, y2 = line1.endY;
  const x3 = line2.startX, y3 = line2.startY;
  const x4 = line2.endX, y4 = line2.endY;

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(denom) < 0.0001) return null; // Lines are parallel

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;

  // Check if intersection is within both line segments
  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      x: x1 + t * (x2 - x1),
      y: y1 + t * (y2 - y1),
    };
  }

  return null;
}

/**
 * Sample a cubic bezier curve into line segments
 */
function sampleCubicBezier(
  start: Point,
  cp1: Point,
  cp2: Point,
  end: Point,
  numSamples: number = CURVE_SAMPLE_POINTS
): Point[] {
  const points: Point[] = [start];
  
  for (let i = 1; i <= numSamples; i++) {
    const t = i / numSamples;
    const t2 = t * t;
    const t3 = t2 * t;
    const mt = 1 - t;
    const mt2 = mt * mt;
    const mt3 = mt2 * mt;
    
    points.push({
      x: mt3 * start.x + 3 * mt2 * t * cp1.x + 3 * mt * t2 * cp2.x + t3 * end.x,
      y: mt3 * start.y + 3 * mt2 * t * cp1.y + 3 * mt * t2 * cp2.y + t3 * end.y,
    });
  }
  
  return points;
}

/**
 * Sample a quadratic bezier curve into line segments
 */
function sampleQuadraticBezier(
  start: Point,
  cp: Point,
  end: Point,
  numSamples: number = CURVE_SAMPLE_POINTS
): Point[] {
  const points: Point[] = [start];
  
  for (let i = 1; i <= numSamples; i++) {
    const t = i / numSamples;
    const mt = 1 - t;
    
    points.push({
      x: mt * mt * start.x + 2 * mt * t * cp.x + t * t * end.x,
      y: mt * mt * start.y + 2 * mt * t * cp.y + t * t * end.y,
    });
  }
  
  return points;
}

/**
 * Apply transformation matrix to a point
 */
function transformPoint(point: Point, transform: number[]): Point {
  const [a, b, c, d, e, f] = transform;
  return {
    x: a * point.x + c * point.y + e,
    y: b * point.x + d * point.y + f,
  };
}

/**
 * Extract vector paths from a PDF page
 */
export async function extractVectorPaths(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNumber: number
): Promise<DocumentSnapData> {
  const page = await pdfDoc.getPage(pageNumber);
  const operatorList = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  
  const lines: DocumentLine[] = [];
  const endpointSet = new Map<string, Point>();
  
  // Transformation matrix stack
  const transformStack: number[][] = [[1, 0, 0, 1, 0, 0]];
  
  // Current path state
  let currentPath: Point[] = [];
  let currentPoint: Point = { x: 0, y: 0 };
  
  const getCurrentTransform = (): number[] => transformStack[transformStack.length - 1];
  
  const addLine = (start: Point, end: Point) => {
    if (lines.length >= MAX_LINES_PER_PAGE) return;
    
    const len = distance(start, end);
    if (len < MIN_LINE_LENGTH) return;
    
    // Flip Y coordinate (PDF coordinate system has origin at bottom-left)
    const line: DocumentLine = {
      startX: start.x,
      startY: viewport.height - start.y,
      endX: end.x,
      endY: viewport.height - end.y,
    };
    
    lines.push(line);
    
    // Add endpoints
    const startKey = `${line.startX.toFixed(1)},${line.startY.toFixed(1)}`;
    const endKey = `${line.endX.toFixed(1)},${line.endY.toFixed(1)}`;
    
    if (!endpointSet.has(startKey)) {
      endpointSet.set(startKey, { x: line.startX, y: line.startY });
    }
    if (!endpointSet.has(endKey)) {
      endpointSet.set(endKey, { x: line.endX, y: line.endY });
    }
  };
  
  // Process operator list
  for (let i = 0; i < operatorList.fnArray.length; i++) {
    const fn = operatorList.fnArray[i];
    const args = operatorList.argsArray[i];
    
    switch (fn) {
      case pdfjsLib.OPS.save:
        transformStack.push([...getCurrentTransform()]);
        break;
        
      case pdfjsLib.OPS.restore:
        if (transformStack.length > 1) {
          transformStack.pop();
        }
        break;
        
      case pdfjsLib.OPS.transform:
        if (args && args.length >= 6) {
          const [a, b, c, d, e, f] = args;
          const current = getCurrentTransform();
          const [ca, cb, cc, cd, ce, cf] = current;
          
          // Matrix multiplication
          transformStack[transformStack.length - 1] = [
            ca * a + cc * b,
            cb * a + cd * b,
            ca * c + cc * d,
            cb * c + cd * d,
            ca * e + cc * f + ce,
            cb * e + cd * f + cf,
          ];
        }
        break;
        
      case pdfjsLib.OPS.moveTo:
        if (args && args.length >= 2) {
          const rawPoint = { x: args[0], y: args[1] };
          currentPoint = transformPoint(rawPoint, getCurrentTransform());
          currentPath = [currentPoint];
        }
        break;
        
      case pdfjsLib.OPS.lineTo:
        if (args && args.length >= 2) {
          const rawPoint = { x: args[0], y: args[1] };
          const newPoint = transformPoint(rawPoint, getCurrentTransform());
          addLine(currentPoint, newPoint);
          currentPoint = newPoint;
          currentPath.push(currentPoint);
        }
        break;
        
      case pdfjsLib.OPS.curveTo:
        if (args && args.length >= 6) {
          const cp1 = transformPoint({ x: args[0], y: args[1] }, getCurrentTransform());
          const cp2 = transformPoint({ x: args[2], y: args[3] }, getCurrentTransform());
          const end = transformPoint({ x: args[4], y: args[5] }, getCurrentTransform());
          
          const samples = sampleCubicBezier(currentPoint, cp1, cp2, end);
          for (let j = 0; j < samples.length - 1; j++) {
            addLine(samples[j], samples[j + 1]);
          }
          
          currentPoint = end;
          currentPath.push(currentPoint);
        }
        break;
        
      case pdfjsLib.OPS.curveTo2:
        if (args && args.length >= 4) {
          // curveTo2 uses current point as first control point
          const cp2 = transformPoint({ x: args[0], y: args[1] }, getCurrentTransform());
          const end = transformPoint({ x: args[2], y: args[3] }, getCurrentTransform());
          
          const samples = sampleCubicBezier(currentPoint, currentPoint, cp2, end);
          for (let j = 0; j < samples.length - 1; j++) {
            addLine(samples[j], samples[j + 1]);
          }
          
          currentPoint = end;
          currentPath.push(currentPoint);
        }
        break;
        
      case pdfjsLib.OPS.curveTo3:
        if (args && args.length >= 4) {
          // curveTo3 uses end point as second control point
          const cp1 = transformPoint({ x: args[0], y: args[1] }, getCurrentTransform());
          const end = transformPoint({ x: args[2], y: args[3] }, getCurrentTransform());
          
          const samples = sampleCubicBezier(currentPoint, cp1, end, end);
          for (let j = 0; j < samples.length - 1; j++) {
            addLine(samples[j], samples[j + 1]);
          }
          
          currentPoint = end;
          currentPath.push(currentPoint);
        }
        break;
        
      case pdfjsLib.OPS.rectangle:
        if (args && args.length >= 4) {
          const [rx, ry, rw, rh] = args;
          const transform = getCurrentTransform();
          
          const p1 = transformPoint({ x: rx, y: ry }, transform);
          const p2 = transformPoint({ x: rx + rw, y: ry }, transform);
          const p3 = transformPoint({ x: rx + rw, y: ry + rh }, transform);
          const p4 = transformPoint({ x: rx, y: ry + rh }, transform);
          
          addLine(p1, p2);
          addLine(p2, p3);
          addLine(p3, p4);
          addLine(p4, p1);
          
          currentPoint = p1;
          currentPath = [p1, p2, p3, p4, p1];
        }
        break;
        
      case pdfjsLib.OPS.closePath:
        if (currentPath.length > 1) {
          addLine(currentPoint, currentPath[0]);
          currentPoint = currentPath[0];
        }
        break;
        
      case pdfjsLib.OPS.endPath:
        currentPath = [];
        break;
    }
  }
  
  // Calculate intersections (limit to avoid performance issues)
  const intersections: Point[] = [];
  const intersectionSet = new Map<string, Point>();
  const maxIntersectionChecks = Math.min(lines.length, 500);
  
  for (let i = 0; i < maxIntersectionChecks && intersections.length < 1000; i++) {
    for (let j = i + 1; j < maxIntersectionChecks && intersections.length < 1000; j++) {
      const intersection = lineIntersection(lines[i], lines[j]);
      if (intersection) {
        const key = `${intersection.x.toFixed(1)},${intersection.y.toFixed(1)}`;
        if (!intersectionSet.has(key) && !endpointSet.has(key)) {
          intersectionSet.set(key, intersection);
          intersections.push(intersection);
        }
      }
    }
  }
  
  return {
    lines,
    endpoints: Array.from(endpointSet.values()),
    intersections,
  };
}

/**
 * Find the nearest point on a line segment to a given point
 */
export function nearestPointOnLine(point: Point, line: DocumentLine): Point {
  const { startX, startY, endX, endY } = line;
  
  const dx = endX - startX;
  const dy = endY - startY;
  const lengthSq = dx * dx + dy * dy;
  
  if (lengthSq === 0) {
    return { x: startX, y: startY };
  }
  
  // Project point onto line, clamping to segment
  let t = ((point.x - startX) * dx + (point.y - startY) * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  
  return {
    x: startX + t * dx,
    y: startY + t * dy,
  };
}

/**
 * Calculate distance from a point to a line segment
 */
export function distanceToLine(point: Point, line: DocumentLine): number {
  const nearest = nearestPointOnLine(point, line);
  return distance(point, nearest);
}
