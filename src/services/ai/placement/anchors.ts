import type { DocumentSnapData } from '@/lib/pdfVectorExtractor';
import { rectCenter } from './coords';
import type { GeometryAnchor, PageLayoutModel } from './types';

/** Build text + corner anchors from a page layout model (document space). */
export function anchorsFromLayout(layout: PageLayoutModel): GeometryAnchor[] {
  const anchors: GeometryAnchor[] = [];

  for (const block of layout.textBlocks) {
    const center = rectCenter(block.bounds);
    anchors.push({
      id: `${block.id}_center`,
      type: 'text',
      point: center,
      bounds: block.bounds,
      label: block.text.slice(0, 80),
      confidence: block.confidence ?? 0.7,
      source: layout.source === 'ocr' ? 'ocr' : 'native',
    });
    anchors.push({
      id: `${block.id}_tl`,
      type: 'corner',
      point: { x: block.bounds.x, y: block.bounds.y },
      bounds: block.bounds,
      label: block.text.slice(0, 40),
      confidence: 0.55,
      source: layout.source === 'ocr' ? 'ocr' : 'native',
    });
  }

  return anchors;
}

/** Build endpoint / intersection anchors from PDF vector snap data (must already be doc space). */
export function anchorsFromVectorSnap(snap: DocumentSnapData, pageNumber: number): GeometryAnchor[] {
  const anchors: GeometryAnchor[] = [];

  snap.endpoints.forEach((point, index) => {
    anchors.push({
      id: `vec_ep_${pageNumber}_${index}`,
      type: 'endpoint',
      point,
      confidence: 0.8,
      source: 'pdf_vector',
    });
  });

  snap.intersections.forEach((point, index) => {
    anchors.push({
      id: `vec_ix_${pageNumber}_${index}`,
      type: 'intersection',
      point,
      confidence: 0.85,
      source: 'pdf_vector',
    });
  });

  snap.lines.slice(0, 500).forEach((line, index) => {
    anchors.push({
      id: `vec_mid_${pageNumber}_${index}`,
      type: 'midpoint',
      point: {
        x: (line.startX + line.endX) / 2,
        y: (line.startY + line.endY) / 2,
      },
      segment: {
        a: { x: line.startX, y: line.startY },
        b: { x: line.endX, y: line.endY },
      },
      confidence: 0.65,
      source: 'pdf_vector',
    });
  });

  return anchors;
}
