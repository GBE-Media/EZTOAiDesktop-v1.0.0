export type CatalogItemType = 'product' | 'assembly';
export type CatalogMutationOperation = 'insert' | 'update' | 'delete';
export type CatalogTable =
  | 'product_catalog'
  | 'product_categories'
  | 'assemblies'
  | 'assembly_components';

export interface CatalogProduct {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  category: string | null;
  unit_of_measure: string;
  unit_price: number;
  labor_cost: number;
  material_cost: number;
  supplier: string | null;
  sku: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  organization_id: string | null;
  is_org_catalog: boolean;
}

export interface CatalogCategory {
  id: string;
  user_id: string;
  path: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface CatalogAssembly {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  category: string | null;
  unit_of_measure: string;
  sku: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssemblyComponent {
  id: string;
  assembly_id: string;
  component_type: 'product' | 'labor';
  catalog_product_id: string | null;
  description: string | null;
  quantity: number;
  unit_of_measure: string;
  labor_rate: number;
  sort_order: number;
  created_at: string;
}

export interface CatalogSyncResponse {
  serverTime: string;
  products: CatalogProduct[];
  categories: CatalogCategory[];
  assemblies: CatalogAssembly[];
  components: AssemblyComponent[];
  deletedIds: {
    products: string[];
    assemblies: string[];
    categories: string[];
  };
}

export interface CatalogSyncMeta {
  userId: string;
  lastSyncAt: string | null;
}

export interface CatalogMutation {
  id: string;
  userId: string;
  table: CatalogTable;
  operation: CatalogMutationOperation;
  entityId: string;
  payload: Record<string, unknown> | null;
  knownUpdatedAt: string | null;
  createdAt: string;
  attempts: number;
  lastError?: string;
}

export interface CachedCatalogProduct extends CatalogProduct {
  cache_key: string;
  cache_user_id: string;
}

export interface CachedCatalogCategory extends CatalogCategory {
  cache_key: string;
  cache_user_id: string;
}

export interface CachedCatalogAssembly extends CatalogAssembly {
  cache_key: string;
  cache_user_id: string;
}

export interface CachedAssemblyComponent extends AssemblyComponent {
  cache_key: string;
  cache_user_id: string;
}

export interface CatalogSnapshot {
  products: CatalogProduct[];
  categories: CatalogCategory[];
  assemblies: CatalogAssembly[];
  components: AssemblyComponent[];
}
