/**
 * Vision results keyed by exactly what the model was shown: the rendered image, the full prompt,
 * the model, and the prompt version. Re-counting an unchanged sheet reuses the earlier answer, so
 * the same drawing gives the same count every time (and only failed tiles are asked again).
 * Kept in memory and, best-effort, in localStorage so a restart doesn't change a count.
 */
import type { BlueprintAnalysisResult } from './providers/types';

/** Bump when the tile/overview prompts or the result normalisation change meaningfully. */
export const VISION_PROMPT_VERSION = 'v1';

const MEMORY_MAX = 400;
const STORAGE_PREFIX = 'eztoai.vision.v1.';
const STORAGE_MAX = 300;
const STORAGE_INDEX = `${STORAGE_PREFIX}index`;

const memory = new Map<string, BlueprintAnalysisResult>();

// Off under the unit-test runner unless a test turns it on (tests reuse images with new mocks).
let enabled = !(typeof process !== 'undefined' && process.env?.VITEST);
export function setVisionCacheEnabled(on: boolean): void { enabled = on; }
export function visionCacheEnabled(): boolean { return enabled; }

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

async function sha256(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // FNV-1a fallback (no WebCrypto): still deterministic, just weaker.
  let h1 = 0x811c9dc5; let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}${text.length.toString(16)}`;
}

export async function visionCacheKey(parts: { image: string; prompt: string; model: string; trade: string; page: number }): Promise<string> {
  return sha256([VISION_PROMPT_VERSION, parts.model, parts.trade, parts.page, parts.prompt, parts.image].join('\u0000'));
}

const clone = (value: BlueprintAnalysisResult): BlueprintAnalysisResult => JSON.parse(JSON.stringify(value));

export function getCachedVision(key: string): BlueprintAnalysisResult | null {
  const hit = memory.get(key);
  if (hit) {
    memory.delete(key);
    memory.set(key, hit);
    return clone(hit);
  }
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const value = JSON.parse(raw) as BlueprintAnalysisResult;
    remember(key, value);
    return clone(value);
  } catch {
    return null;
  }
}

function remember(key: string, value: BlueprintAnalysisResult) {
  memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string);
}

export function setCachedVision(key: string, value: BlueprintAnalysisResult): void {
  const copy = clone(value);
  remember(key, copy);
  const store = storage();
  if (!store) return;
  try {
    const index: string[] = JSON.parse(store.getItem(STORAGE_INDEX) || '[]');
    const next = [...index.filter(k => k !== key), key];
    while (next.length > STORAGE_MAX) {
      const old = next.shift();
      if (old) store.removeItem(STORAGE_PREFIX + old);
    }
    store.setItem(STORAGE_PREFIX + key, JSON.stringify(copy));
    store.setItem(STORAGE_INDEX, JSON.stringify(next));
  } catch {
    // Storage full or unavailable: the in-memory copy still keeps this session repeatable.
  }
}

export function clearVisionCache(): void {
  memory.clear();
  const store = storage();
  if (!store) return;
  try {
    const index: string[] = JSON.parse(store.getItem(STORAGE_INDEX) || '[]');
    for (const key of index) store.removeItem(STORAGE_PREFIX + key);
    store.removeItem(STORAGE_INDEX);
  } catch {
    // ignore
  }
}
