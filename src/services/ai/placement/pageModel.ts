import { groupTextIntoLines, type TextItemWithBounds } from '@/lib/pdfLoader';
import { createPageGeometry, renderRectToDoc } from './coords';
import type { PageGeometry, PageLayoutModel, PageTextBlock } from './types';
import { DEFAULT_RENDER_SCALE } from './types';

/**
 * Build a page layout model from PDF text items.
 * If items were extracted at renderScale (default 1.5), convert bounds to document points.
 */
export function buildPageLayoutModel(options: {
  page: PageGeometry;
  textItems: TextItemWithBounds[];
  source?: PageLayoutModel['source'];
  /** Scale used when extracting textItems (1 = already doc space). */
  renderScaleUsed?: number;
}): PageLayoutModel {
  const renderScaleUsed = options.renderScaleUsed ?? DEFAULT_RENDER_SCALE;
  const page = options.page;

  const textBlocks: PageTextBlock[] = options.textItems
    .filter(item => item.str.trim())
    .map((item, index) => {
      const raw = {
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
      };
      const bounds = renderScaleUsed === 1
        ? raw
        : renderRectToDoc(raw, { ...page, renderScale: renderScaleUsed });
      return {
        id: `text_${index}`,
        text: item.str,
        bounds,
      };
    });

  const lines = groupTextIntoLines(
    options.textItems.map(item => ({
      ...item,
      // group helper uses item coords as-is; use converted blocks for line output
    })),
  ).map((line, index) => {
    const raw = { x: line.x, y: line.y, width: line.width, height: line.height };
    const bounds = renderScaleUsed === 1
      ? raw
      : renderRectToDoc(raw, { ...page, renderScale: renderScaleUsed });
    return {
      id: `line_${index}`,
      text: line.items.map(item => item.str).join(' ').trim(),
      bounds,
    };
  }).filter(line => line.text);

  return {
    page: createPageGeometry(page),
    textBlocks,
    lines,
    extractedAt: new Date().toISOString(),
    source: options.source || 'native',
    renderScaleUsed,
  };
}
