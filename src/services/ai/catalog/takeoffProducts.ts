/**
 * Allocate AI takeoff quantities to the user's product library: find the user's product for a
 * fixture type / conduit / wire / cable, or create it (under "AI Takeoff") when they don't have it.
 * Markups then carry productId so counts and footages roll up like manual takeoff.
 */
import { useProductStore } from '@/store/productStore';
import type { ProductComponent, ProductNode } from '@/types/product';
import { useCatalogStore } from '@/store/catalogStore';
import { getCatalogPersister } from './catalogPersister';

export interface TakeoffProductSpec {
  /** Stable key, e.g. "fixture:A" or "run:3/4\" EMT – 2#12, 1#12G". */
  key: string;
  name: string;
  /** Folder under "AI Takeoff" (e.g. "Lighting Fixtures"). */
  folder: string;
  unit: 'ea' | 'ft';
  description?: string;
  /** Per-unit components (e.g. per foot of home run: 1 ft conduit + 3 ft #12). */
  components?: Array<Omit<ProductComponent, 'id'>>;
  /** Extra names to match an existing user product (e.g. "Type A", "Fixture A"). */
  aliases?: string[];
}

const ROOT_FOLDER = 'AI Takeoff';
const KEY_PREFIX = 'bidvera-key:';

function norm(text: string): string {
  return text.toLowerCase().replace(/["”″]/g, 'in').replace(/[^a-z0-9]+/g, ' ').trim();
}

function keyOf(node: ProductNode): string | null {
  const line = (node.notes || '').split('\n').find(l => l.startsWith(KEY_PREFIX));
  return line ? line.slice(KEY_PREFIX.length).trim() : null;
}

/** Find the user's existing product for this spec (key, exact name, or alias). */
export function findTakeoffProduct(spec: TakeoffProductSpec, nodes: Record<string, ProductNode> = useProductStore.getState().nodes): ProductNode | null {
  const products = Object.values(nodes).filter(node => node.type === 'product');
  const byKey = products.find(node => keyOf(node) === spec.key);
  if (byKey) return byKey;
  const names = [spec.name, ...(spec.aliases || [])].map(norm).filter(Boolean);
  const byName = products.find(node => names.includes(norm(node.name)));
  return byName || null;
}

function ensureFolder(parentId: string | null, name: string): string {
  const store = useProductStore.getState();
  const siblings = parentId ? (store.nodes[parentId]?.children || []).map(id => store.nodes[id]) : store.rootIds.map(id => store.nodes[id]);
  const existing = siblings.find(node => node && node.type === 'folder' && norm(node.name) === norm(name));
  return existing ? existing.id : store.addFolder(parentId, name);
}

/** Return the productId for this spec, creating the product (and folders) when missing. */
export function ensureTakeoffProduct(spec: TakeoffProductSpec): { productId: string; created: boolean } {
  const found = findTakeoffProduct(spec);
  if (found) return { productId: found.id, created: false };
  const root = ensureFolder(null, ROOT_FOLDER);
  const folder = ensureFolder(root, spec.folder);
  const store = useProductStore.getState();
  const id = store.addProduct(folder, spec.name);
  store.updateProductUnitOfMeasure(id, spec.unit);
  if (spec.description) store.updateProductDescription(id, spec.description);
  for (const component of spec.components || []) store.addComponent(id, component);
  const notes = `${KEY_PREFIX}${spec.key}\nCreated by BidveraAi from the drawings.`;
  const categoryPath = `${ROOT_FOLDER}/${spec.folder}`;
  const persister = getCatalogPersister();
  useProductStore.setState(state => ({
    nodes: {
      ...state.nodes,
      [id]: { ...state.nodes[id], notes, categoryPath, ...(persister ? { pendingCatalog: true } : {}) },
    },
  }));
  persistTakeoffProduct(id, spec, notes, categoryPath);
  return { productId: id, created: true };
}

const savedPaths = new Set<string>();
let saveChain: Promise<void> = Promise.resolve();

/**
 * Save an AI-created product to the user's catalog (same id as the local node, so linked counts
 * and footages carry over when the catalog sync rebuilds the product tree).
 */
function persistTakeoffProduct(id: string, spec: TakeoffProductSpec, notes: string, categoryPath: string): void {
  const persister = getCatalogPersister();
  if (!persister) return;
  const description = [
    spec.description || '',
    ...(spec.components?.length ? [`Per ${spec.unit}: ${spec.components.map(c => `${c.quantity} ${c.unit} ${c.name}`).join(', ')}`] : []),
  ].filter(Boolean).join('\n');
  saveChain = saveChain.then(async () => {
    const now = new Date().toISOString();
    const existingPaths = new Set(Object.values(useCatalogStore.getState().categories).map(c => c.path));
    for (const path of [ROOT_FOLDER, categoryPath]) {
      if (existingPaths.has(path) || savedPaths.has(path)) continue;
      savedPaths.add(path);
      await persister.queue('product_categories', 'insert', {
        id: crypto.randomUUID(), user_id: persister.userId, path, sort_order: 0, created_at: now, updated_at: now,
      });
    }
    if (useCatalogStore.getState().products[id]) return;
    await persister.queue('product_catalog', 'insert', {
      id,
      user_id: persister.userId,
      name: spec.name,
      description,
      category: categoryPath,
      unit_of_measure: spec.unit === 'ea' ? 'each' : 'ft',
      unit_price: 0,
      labor_cost: 0,
      material_cost: 0,
      supplier: null,
      sku: null,
      notes,
      created_at: now,
      updated_at: now,
      organization_id: null,
      is_org_catalog: false,
    });
  }).catch(error => {
    console.warn('[takeoffProducts] could not save product to the catalog', error);
  });
}

/** Test hook: wait for queued catalog saves. */
export function flushTakeoffProductSaves(): Promise<void> {
  return saveChain;
}

/** Product spec for a counted fixture / device type. */
export function fixtureProductSpec(typeCode: string, description?: string, trade = 'electrical'): TakeoffProductSpec {
  const code = typeCode.trim();
  const desc = (description || '').trim();
  const short = desc && norm(desc) !== norm(code) ? ` – ${desc.slice(0, 60)}` : '';
  return {
    key: `fixture:${code.toUpperCase()}`,
    name: `Type ${code}${short}`,
    folder: trade === 'electrical' ? 'Lighting & Devices' : 'Counted Items',
    unit: 'ea',
    description: desc || undefined,
    aliases: [`Type ${code}`, `Fixture ${code}`, `Fixture Type ${code}`, code],
  };
}
