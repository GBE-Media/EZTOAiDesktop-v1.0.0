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
const droppedDocIds = new Set<string>();
let dexieWarnLogged = false;

export function documentFingerprint(pdf: { fingerprints?: string[]; numPages?: number } | null | undefined): string {
  return `${fingerprintOf(pdf)}:v${CLASSIFIER_VERSION}`;
}

export function markDocumentIndexing(docId: string): void {
  droppedDocIds.delete(docId);
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

export async function loadCachedPages(docFp: string, numPages = 0): Promise<IndexedPageRecord[]> {
  const mem = memoryByFp.get(docFp);
  if (mem?.length && mem[0]?.classifierVersion === CLASSIFIER_VERSION && mem.length >= numPages) return mem;
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

export function rememberIndexedPages(
  docId: string,
  documentName: string,
  docFp: string,
  pages: IndexedPageRecord[],
): IndexedPageRecord[] {
  return rebindCachedPages(docFp, docId, documentName, pages);
}

export function rebindCachedPages(
  docFp: string,
  docId: string,
  documentName: string,
  pages: IndexedPageRecord[],
): IndexedPageRecord[] {
  const rebound = pages.map(page => ({ ...page, docId, documentName, docFp }));
  const slim = rebound.map(slimPage);
  memoryByFp.set(docFp, slim);
  memoryByDocId.set(docId, slim);
  return rebound;
}

export async function saveIndexedPages(
  docFp: string,
  pages: IndexedPageRecord[],
  docId?: string,
  rowsToWrite: IndexedPageRecord[] = pages,
): Promise<void> {
  const slim = pages.map(slimPage);
  memoryByFp.set(docFp, slim);
  const id = docId || pages[0]?.docId;
  if (id && !droppedDocIds.has(id)) memoryByDocId.set(id, slim);
  try {
    if (rowsToWrite.length && !dexieWarnLogged) await projectIndexDb.pages.bulkPut(rowsToWrite);
  } catch (error) {
    if (!dexieWarnLogged) {
      dexieWarnLogged = true;
      console.warn('[project-index] Dexie write failed, using memory only', error);
    }
  }
}

export function dropIndexedDocument(docId: string): void {
  droppedDocIds.add(docId);
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
  droppedDocIds.clear();
  dexieWarnLogged = false;
}
