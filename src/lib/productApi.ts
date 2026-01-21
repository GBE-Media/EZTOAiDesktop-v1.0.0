import { ProductNode, ProductComponent, LinkedMeasurement } from '@/types/product';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

interface DbFolder {
  id: string;
  user_id: string;
  name: string;
  parent_id: string | null;
  expanded: boolean;
}

interface DbProduct {
  id: string;
  user_id: string;
  folder_id: string | null;
  name: string;
  description: string;
  unit_of_measure: string;
}

interface DbComponent {
  id: string;
  product_id: string;
  name: string;
  quantity: number;
  unit: string;
  notes: string;
}

interface DbMeasurement {
  id: string;
  product_id: string;
  markup_id: string;
  document_id: string;
  page: number;
  measurement_type: string;
  value: number;
  unit: string;
  created_at?: string;
  group_id?: string;
  group_label?: string;
}

interface LoadResponse {
  folders: DbFolder[];
  products: DbProduct[];
  components: DbComponent[];
  measurements: DbMeasurement[];
}

export interface ProductStoreData {
  nodes: Record<string, ProductNode>;
  rootIds: string[];
}

export async function loadUserProducts(accessToken: string): Promise<ProductStoreData | null> {
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-products`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Failed to load products:', error);
      return null;
    }

    const data: LoadResponse = await response.json();
    return transformDbToStore(data);
  } catch (error) {
    console.error('Error loading products:', error);
    return null;
  }
}

export async function syncProductsToDb(
  accessToken: string,
  nodes: Record<string, ProductNode>,
  rootIds: string[]
): Promise<boolean> {
  try {
    const payload = transformStoreToDb(nodes, rootIds);
    
    const response = await fetch(`${SUPABASE_URL}/functions/v1/sync-products`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Failed to sync products:', error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error syncing products:', error);
    return false;
  }
}

function transformDbToStore(data: LoadResponse): ProductStoreData {
  const nodes: Record<string, ProductNode> = {};
  const rootIds: string[] = [];
  
  // Create folder nodes
  for (const folder of data.folders) {
    nodes[folder.id] = {
      id: folder.id,
      name: folder.name,
      type: 'folder',
      parentId: folder.parent_id,
      children: [],
      expanded: folder.expanded,
    };
  }
  
  // Create product nodes
  for (const product of data.products) {
    const components: ProductComponent[] = data.components
      .filter(c => c.product_id === product.id)
      .map(c => ({
        id: c.id,
        name: c.name,
        quantity: c.quantity,
        unit: c.unit,
        notes: c.notes,
      }));
    
    const measurements: LinkedMeasurement[] = data.measurements
      .filter(m => m.product_id === product.id)
      .map(m => ({
        id: m.id,
        markupId: m.markup_id,
        documentId: m.document_id,
        page: m.page,
        type: m.measurement_type as 'length' | 'area' | 'count',
        value: m.value,
        unit: m.unit,
        createdAt: m.created_at || new Date().toISOString(),
        groupId: m.group_id,
        groupLabel: m.group_label,
      }));
    
    nodes[product.id] = {
      id: product.id,
      name: product.name,
      type: 'product',
      parentId: product.folder_id,
      children: [],
      expanded: false,
      description: product.description,
      unitOfMeasure: product.unit_of_measure as 'length' | 'area' | 'count' | 'each',
      components,
      measurements,
    };
  }
  
  // Build children arrays and identify root nodes
  for (const nodeId in nodes) {
    const node = nodes[nodeId];
    if (node.parentId) {
      const parent = nodes[node.parentId];
      if (parent) {
        parent.children.push(nodeId);
      } else {
        // Parent doesn't exist, treat as root
        rootIds.push(nodeId);
      }
    } else {
      rootIds.push(nodeId);
    }
  }
  
  return { nodes, rootIds };
}

function transformStoreToDb(nodes: Record<string, ProductNode>, rootIds: string[]) {
  const folders: Array<{
    id: string;
    name: string;
    parentId: string | null;
    expanded: boolean;
  }> = [];
  
  const products: Array<{
    id: string;
    name: string;
    folderId: string | null;
    description: string;
    unitOfMeasure: string;
    components: ProductComponent[];
    measurements: Array<{
      id: string;
      markupId: string;
      documentId: string;
      page: number;
      type: string;
      value: number;
      unit: string;
      groupId?: string;
      groupLabel?: string;
    }>;
  }> = [];
  
  for (const nodeId in nodes) {
    const node = nodes[nodeId];
    
    if (node.type === 'folder') {
      folders.push({
        id: node.id,
        name: node.name,
        parentId: node.parentId,
        expanded: node.expanded ?? true,
      });
    } else {
      products.push({
        id: node.id,
        name: node.name,
        folderId: node.parentId,
        description: node.description || '',
        unitOfMeasure: node.unitOfMeasure || 'each',
        components: node.components || [],
        measurements: (node.measurements || []).map(m => ({
          id: m.id,
          markupId: m.markupId,
          documentId: m.documentId,
          page: m.page,
          type: m.type,
          value: m.value,
          unit: m.unit,
          groupId: m.groupId,
          groupLabel: m.groupLabel,
        })),
      });
    }
  }
  
  return { folders, products };
}
