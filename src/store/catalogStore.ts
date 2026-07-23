import { create } from 'zustand';
import type {
  AssemblyComponent,
  CatalogAssembly,
  CatalogCategory,
  CatalogProduct,
  CatalogSnapshot,
} from '@/types/catalog';

interface CatalogStore {
  products: Record<string, CatalogProduct>;
  categories: Record<string, CatalogCategory>;
  assemblies: Record<string, CatalogAssembly>;
  components: Record<string, AssemblyComponent>;
  hydratedUserId: string | null;
  setSnapshot: (userId: string, snapshot: CatalogSnapshot) => void;
  clearMemory: () => void;
}

const indexById = <T extends { id: string }>(rows: T[]): Record<string, T> =>
  Object.fromEntries(rows.map((row) => [row.id, row]));

export const useCatalogStore = create<CatalogStore>((set) => ({
  products: {},
  categories: {},
  assemblies: {},
  components: {},
  hydratedUserId: null,
  setSnapshot: (userId, snapshot) =>
    set({
      products: indexById(snapshot.products),
      categories: indexById(snapshot.categories),
      assemblies: indexById(snapshot.assemblies),
      components: indexById(snapshot.components),
      hydratedUserId: userId,
    }),
  clearMemory: () =>
    set({
      products: {},
      categories: {},
      assemblies: {},
      components: {},
      hydratedUserId: null,
    }),
}));
