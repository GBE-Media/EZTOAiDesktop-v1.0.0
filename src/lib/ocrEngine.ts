import Tesseract from 'tesseract.js';

export interface OcrWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface OcrResult {
  text: string;
  words: OcrWord[];
  confidence: number;
}

/**
 * Preprocess an image canvas for better OCR accuracy.
 * Applies grayscale conversion, contrast enhancement, and adaptive thresholding.
 */
function preprocessImage(canvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  
  // First pass: Convert to grayscale
  const grayscale = new Uint8Array(data.length / 4);
  for (let i = 0; i < data.length; i += 4) {
    // Use luminance formula for better perception
    grayscale[i / 4] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  
  // Calculate histogram for Otsu's thresholding
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < grayscale.length; i++) {
    histogram[grayscale[i]]++;
  }
  
  // Otsu's method to find optimal threshold
  const total = grayscale.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += i * histogram[i];
  }
  
  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let threshold = 0;
  
  for (let i = 0; i < 256; i++) {
    wB += histogram[i];
    if (wB === 0) continue;
    
    const wF = total - wB;
    if (wF === 0) break;
    
    sumB += i * histogram[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const variance = wB * wF * (mB - mF) * (mB - mF);
    
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = i;
    }
  }
  
  // Apply contrast enhancement and thresholding
  for (let i = 0; i < grayscale.length; i++) {
    // Enhance contrast before thresholding
    let value = grayscale[i];
    
    // Contrast stretch
    value = Math.min(255, Math.max(0, (value - 128) * 1.2 + 128));
    
    // Apply threshold with slight bias for cleaner text
    const binarized = value > threshold ? 255 : 0;
    
    const idx = i * 4;
    data[idx] = binarized;
    data[idx + 1] = binarized;
    data[idx + 2] = binarized;
    // Keep alpha unchanged
  }
  
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Perform OCR on a canvas using Tesseract.js.
 * Returns extracted text with word-level bounding boxes.
 */
export async function performOcr(
  canvas: HTMLCanvasElement,
  onProgress?: (progress: number) => void
): Promise<OcrResult> {
  // Create a copy for preprocessing to avoid mutating original
  const processedCanvas = document.createElement('canvas');
  processedCanvas.width = canvas.width;
  processedCanvas.height = canvas.height;
  const ctx = processedCanvas.getContext('2d');
  if (ctx) {
    ctx.drawImage(canvas, 0, 0);
  }
  
  // Preprocess for better accuracy
  preprocessImage(processedCanvas);
  
  try {
    let tessdataPath = import.meta.env.VITE_TESSDATA_URL as string | undefined;
    if (typeof window !== 'undefined') {
      const api = (window as any).electronAPI;
      if (api?.getTessdataPath) {
        try {
          tessdataPath = await api.getTessdataPath();
        } catch (error) {
          console.warn('Failed to resolve tessdata path from Electron:', error);
        }
      }
    }
    const result = await Tesseract.recognize(
      processedCanvas,
      'eng', // Default to English
      {
        logger: (m) => {
          if (m.status === 'recognizing text' && onProgress) {
            onProgress(Math.round(m.progress * 100));
          }
        },
        ...(tessdataPath ? { langPath: tessdataPath } : {}),
      }
    );
    
    // Extract words from the nested structure: blocks → paragraphs → lines → words
    const words: OcrWord[] = [];
    const blocks = result.data.blocks;
    
    if (blocks) {
      for (const block of blocks) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            for (const word of line.words) {
              words.push({
                text: word.text,
                x: word.bbox.x0,
                y: word.bbox.y0,
                width: word.bbox.x1 - word.bbox.x0,
                height: word.bbox.y1 - word.bbox.y0,
                confidence: word.confidence,
              });
            }
          }
        }
      }
    }
    
    return {
      text: result.data.text,
      words,
      confidence: result.data.confidence,
    };
  } catch (error) {
    console.error('Tesseract OCR error:', error);
    throw error;
  }
}

/**
 * Check if text content appears to be from a scanned document
 * (i.e., very little or no extractable text from PDF.js)
 */
export function isScannedDocument(textItemCount: number, pageArea: number): boolean {
  // If there are very few text items relative to page size, it's likely scanned
  const textDensity = textItemCount / (pageArea / 10000);
  return textDensity < 0.1;
}
