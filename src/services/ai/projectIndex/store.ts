import Dexie, { type Table } from 'dexie';
import { CLASSIFIER_VERSION } from './classify';
import { documentFingerprint as fingerprintOf } from './fingerprint';
import type { IndexedPageRecord } from './types';
import { buildSearchPassages } from './searchIndex';

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
const memoryByDocId = new Map<string, IndexedPageRecord[]>();
const memoryByFp = new Map<string, IndexedPageRecord[]>();
let dexieWarnLogged = false;

export function documentFingerprint(pdf: { fingerprints?: string[]; numPages?: number } | null | undefined): string {
  return `${fingerprintOf(pdf)}:v${CLASSIFIER_VERSION}`;
}

function slimPage(page: IndexedPageRecord): IndexedPageRecord {
  const title = page.lines.filter(line =>
    (page.sheetNumber && line.text.includes(page.sheetNumber))
    || (page.specSection && line.text.includes(page.specSection))
    || (page.sheetTitle && line.text.includes(page.sheetTitle)),
  ).slice(0, 8);
  return {
    ...page,
    text: page.text || page.lines.map(line => line.text).join('\n'),
    lines: title.length ? title : page.lines.slice(0, 6),
    passages: page.passages?.length ? page.passages : buildSearchPassages(page.lines),
  };
}

export async function loadCachedPages(docFp: string): Promise<IndexedPageRecord[]> {
  const mem = memoryByFp.get(docFp);
  if (mem?.length && mem[0]?.classifierVersion === CLASSIFIER_VERSION) return mem;
  try {
    const rows = await projectIndexDb.pages.where('docFp').equals(docFp).toArray();
    const fresh = rows.filter(row => row.classifierVersion === CLASSIFIER_VERSION || !row.classifierVersion);
    if (fresh.length && fresh[0]?.classifierVersion === CLASSIFIER_VERSION) {
      memoryByFp.set(docFp, fresh);
      return fresh;
    }
    return [];
  } catch (error) {
    if (!dexieWarnLogged) {
      dexieWarnLogged = true;
      console.warn('[project-index] Dexie unavailable, using memory only', error);
    }
    return [];
  }
}

export function rebindCachedPages(
  docFp: string,
  docId: string,
  documentName: string,
  pages: IndexedPageRecord[],
): IndexedPageRecord[] {
  const rebound = pages.map(page => ({ ...page, docId, documentName, docFp }));
  memoryByFp.set(docFp, rebound);
  memoryByDocId.set(docId, rebound.map(slimPage));
  return rebound;
}

export async function saveIndexedPages(docFp: string, pages: IndexedPageRecord[], docId?: string): Promise<void> {
  memoryByFp.set(docFp, pages);
  if (docId) memoryByDocId.set(docId, pages.map(slimPage));
  else if (pages[0]?.docId) memoryByDocId.set(pages[0].docId, pages.map(slimPage));
  try {
    await projectIndexDb.pages.bulkPut(pages);
  } catch (error) {
    if (!dexieWarnLogged) {
      dexieWarnLogged = true;
      console.warn('[project-index] Dexie write failed, using memory only', error);
    }
  }
}

export function dropIndexedDocument(docId: string): void {
  memoryByDocId.delete(docId);
}

export function allIndexedPages(): IndexedPageRecord[] {
  return [...memoryByDocId.values()].flat();
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
  memoryByDocId.clear();
  memoryByFp.clear();
}
