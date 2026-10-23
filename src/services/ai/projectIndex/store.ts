import Dexie, { type Table } from 'dexie';
import type { IndexedPageRecord } from './types';

class ProjectIndexDb extends Dexie {
  pages!: Table<IndexedPageRecord, [string, number]>;

  constructor() {
    super('bidveraai-project-index');
    this.version(1).stores({
      pages: '[docFp+page], docFp, docId, kind, discipline, specSection',
    });
  }
}

export const projectIndexDb = new ProjectIndexDb();
const memory = new Map<string, IndexedPageRecord[]>();

export function documentFingerprint(pdf: { fingerprints?: string[]; numPages?: number } | null | undefined): string {
  const fp = pdf?.fingerprints?.[0] || 'unknown';
  return `${fp}:${pdf?.numPages || 0}`;
}

export async function loadCachedPages(docFp: string): Promise<IndexedPageRecord[]> {
  const mem = memory.get(docFp);
  if (mem?.length) return mem;
  try {
    const rows = await projectIndexDb.pages.where('docFp').equals(docFp).toArray();
    if (rows.length) memory.set(docFp, rows);
    return rows;
  } catch {
    return [];
  }
}

export async function saveIndexedPages(docFp: string, pages: IndexedPageRecord[]): Promise<void> {
  memory.set(docFp, pages);
  try {
    await projectIndexDb.pages.bulkPut(pages);
  } catch {
    /* tests without IDB */
  }
}

export function allIndexedPages(): IndexedPageRecord[] {
  return [...memory.values()].flat();
}

export function indexStatus(): { indexed: number; totalHint: number; needsOcr: number } {
  const pages = allIndexedPages();
  return {
    indexed: pages.length,
    totalHint: pages.length,
    needsOcr: pages.filter(p => p.needsOcr).length,
  };
}

export function clearIndexMemory(): void {
  memory.clear();
}
