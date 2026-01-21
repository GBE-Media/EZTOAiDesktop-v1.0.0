import { PDFDocument, degrees, PageSizes } from 'pdf-lib';

/**
 * Available page sizes for blank page insertion
 */
export const PAGE_SIZES = {
  'Letter': PageSizes.Letter,
  'Legal': PageSizes.Legal,
  'Tabloid': PageSizes.Tabloid,
  'A3': PageSizes.A3,
  'A4': PageSizes.A4,
  'A5': PageSizes.A5,
} as const;

export type PageSizeName = keyof typeof PAGE_SIZES;

/**
 * Insert a blank page into a PDF document.
 * 
 * @param pdfBytes - The PDF file bytes
 * @param insertAtIndex - 0-based index where to insert the blank page
 * @param pageSize - Page dimensions [width, height] in points
 * @param count - Number of blank pages to insert
 * @returns The modified PDF bytes
 */
export async function insertBlankPage(
  pdfBytes: ArrayBuffer,
  insertAtIndex: number,
  pageSize: [number, number] = PageSizes.Letter,
  count: number = 1
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(pdfBytes));
  
  for (let i = 0; i < count; i++) {
    pdfDoc.insertPage(insertAtIndex + i, pageSize);
  }
  
  return pdfDoc.save();
}

/**
 * Insert pages from a source PDF into a target PDF at a specific position.
 * 
 * @param targetPdfBytes - The target PDF file bytes
 * @param sourcePdfBytes - The source PDF file bytes to insert from
 * @param insertAtIndex - 0-based index where to insert pages (inserts before this page)
 * @param sourcePageIndices - 0-based indices of pages to copy from source
 * @returns The modified PDF bytes
 */
export async function insertPages(
  targetPdfBytes: ArrayBuffer,
  sourcePdfBytes: ArrayBuffer,
  insertAtIndex: number,
  sourcePageIndices: number[]
): Promise<Uint8Array> {
  const targetDoc = await PDFDocument.load(new Uint8Array(targetPdfBytes));
  const sourceDoc = await PDFDocument.load(new Uint8Array(sourcePdfBytes));
  
  // Copy pages from source
  const copiedPages = await targetDoc.copyPages(sourceDoc, sourcePageIndices);
  
  // Insert pages at the specified position
  copiedPages.forEach((page, index) => {
    targetDoc.insertPage(insertAtIndex + index, page);
  });
  
  return targetDoc.save();
}

/**
 * Extract specific pages to a new PDF document.
 * 
 * @param pdfBytes - The source PDF file bytes
 * @param pageIndices - 0-based indices of pages to extract
 * @returns The new PDF bytes containing only the extracted pages
 */
export async function extractPages(
  pdfBytes: ArrayBuffer,
  pageIndices: number[]
): Promise<Uint8Array> {
  const sourceDoc = await PDFDocument.load(new Uint8Array(pdfBytes));
  const newDoc = await PDFDocument.create();
  
  // Copy selected pages to new document
  const copiedPages = await newDoc.copyPages(sourceDoc, pageIndices);
  copiedPages.forEach(page => {
    newDoc.addPage(page);
  });
  
  return newDoc.save();
}

/**
 * Delete specific pages from a PDF document.
 * 
 * @param pdfBytes - The PDF file bytes
 * @param pageIndicesToDelete - 0-based indices of pages to delete
 * @returns The modified PDF bytes
 */
export async function deletePages(
  pdfBytes: ArrayBuffer,
  pageIndicesToDelete: number[]
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(pdfBytes));
  
  // Sort indices in descending order to delete from the end first
  // This prevents index shifting issues
  const sortedIndices = [...pageIndicesToDelete].sort((a, b) => b - a);
  
  for (const index of sortedIndices) {
    if (index >= 0 && index < pdfDoc.getPageCount()) {
      pdfDoc.removePage(index);
    }
  }
  
  return pdfDoc.save();
}

/**
 * Rotate specific pages in a PDF document.
 * 
 * @param pdfBytes - The PDF file bytes
 * @param pageIndices - 0-based indices of pages to rotate
 * @param rotationDegrees - Rotation amount: 90, 180, or 270 (clockwise)
 * @returns The modified PDF bytes
 */
export async function rotatePages(
  pdfBytes: ArrayBuffer,
  pageIndices: number[],
  rotationDegrees: 90 | 180 | 270
): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(pdfBytes));
  const pages = pdfDoc.getPages();
  
  for (const index of pageIndices) {
    if (index >= 0 && index < pages.length) {
      const page = pages[index];
      const currentRotation = page.getRotation().angle;
      page.setRotation(degrees((currentRotation + rotationDegrees) % 360));
    }
  }
  
  return pdfDoc.save();
}

/**
 * Get the page count from a PDF document.
 * 
 * @param pdfBytes - The PDF file bytes
 * @returns The number of pages
 */
export async function getPageCount(pdfBytes: ArrayBuffer): Promise<number> {
  const pdfDoc = await PDFDocument.load(new Uint8Array(pdfBytes));
  return pdfDoc.getPageCount();
}
