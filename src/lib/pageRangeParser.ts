/**
 * Parse a Bluebeam-style page range string into an array of 0-indexed page numbers.
 * Examples:
 * - "1-5" → [0, 1, 2, 3, 4]
 * - "1, 3, 5" → [0, 2, 4]
 * - "1-3, 7, 10-12" → [0, 1, 2, 6, 9, 10, 11]
 * 
 * @param input - Page range string (1-indexed, as users would enter)
 * @param totalPages - Total number of pages in the document
 * @returns Array of 0-indexed page numbers, sorted and deduplicated
 */
export function parsePageRange(input: string, totalPages: number): number[] {
  if (!input.trim()) return [];
  
  const result: Set<number> = new Set();
  const parts = input.split(',').map(p => p.trim()).filter(Boolean);
  
  for (const part of parts) {
    if (part.includes('-')) {
      const [startStr, endStr] = part.split('-').map(s => s.trim());
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      
      if (isNaN(start) || isNaN(end)) continue;
      if (start < 1 || end > totalPages || start > end) continue;
      
      for (let i = start; i <= end; i++) {
        result.add(i - 1); // Convert to 0-indexed
      }
    } else {
      const page = parseInt(part, 10);
      if (isNaN(page) || page < 1 || page > totalPages) continue;
      result.add(page - 1); // Convert to 0-indexed
    }
  }
  
  return Array.from(result).sort((a, b) => a - b);
}

/**
 * Validate a page range string.
 * 
 * @param input - Page range string to validate
 * @param totalPages - Total number of pages in the document
 * @returns Error message if invalid, null if valid
 */
export function validatePageRange(input: string, totalPages: number): string | null {
  if (!input.trim()) {
    return 'Please enter a page range';
  }
  
  const parts = input.split(',').map(p => p.trim()).filter(Boolean);
  
  for (const part of parts) {
    if (part.includes('-')) {
      const segments = part.split('-').map(s => s.trim());
      if (segments.length !== 2) {
        return `Invalid range format: "${part}"`;
      }
      
      const [startStr, endStr] = segments;
      const start = parseInt(startStr, 10);
      const end = parseInt(endStr, 10);
      
      if (isNaN(start) || isNaN(end)) {
        return `Invalid numbers in range: "${part}"`;
      }
      if (start < 1) {
        return `Page number must be at least 1: "${start}"`;
      }
      if (end > totalPages) {
        return `Page number exceeds document length (${totalPages}): "${end}"`;
      }
      if (start > end) {
        return `Start page cannot be greater than end page: "${part}"`;
      }
    } else {
      const page = parseInt(part, 10);
      if (isNaN(page)) {
        return `Invalid page number: "${part}"`;
      }
      if (page < 1) {
        return `Page number must be at least 1: "${page}"`;
      }
      if (page > totalPages) {
        return `Page number exceeds document length (${totalPages}): "${page}"`;
      }
    }
  }
  
  return null;
}

/**
 * Format an array of 0-indexed page numbers back to a user-friendly string.
 * 
 * @param indices - Array of 0-indexed page numbers
 * @returns Formatted string (1-indexed)
 */
export function formatPageRange(indices: number[]): string {
  if (indices.length === 0) return '';
  
  const sorted = [...indices].sort((a, b) => a - b);
  const ranges: string[] = [];
  let rangeStart = sorted[0];
  let rangeEnd = sorted[0];
  
  for (let i = 1; i <= sorted.length; i++) {
    if (i < sorted.length && sorted[i] === rangeEnd + 1) {
      rangeEnd = sorted[i];
    } else {
      if (rangeStart === rangeEnd) {
        ranges.push((rangeStart + 1).toString());
      } else {
        ranges.push(`${rangeStart + 1}-${rangeEnd + 1}`);
      }
      if (i < sorted.length) {
        rangeStart = sorted[i];
        rangeEnd = sorted[i];
      }
    }
  }
  
  return ranges.join(', ');
}

/**
 * Get even page indices (0-indexed).
 */
export function getEvenPages(totalPages: number): number[] {
  const result: number[] = [];
  for (let i = 1; i < totalPages; i += 2) { // 0-indexed: page 2 is index 1
    result.push(i);
  }
  return result;
}

/**
 * Get odd page indices (0-indexed).
 */
export function getOddPages(totalPages: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < totalPages; i += 2) { // 0-indexed: page 1 is index 0
    result.push(i);
  }
  return result;
}

/**
 * Get all page indices (0-indexed).
 */
export function getAllPages(totalPages: number): number[] {
  return Array.from({ length: totalPages }, (_, i) => i);
}
