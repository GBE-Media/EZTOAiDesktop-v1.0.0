// Product can be a folder or an item
export interface ProductNode {
  id: string;
  name: string;
  type: 'folder' | 'product' | 'assembly';
  parentId: string | null;
  children: string[]; // Child node IDs for folders
  expanded: boolean;
  
  // Only for type: 'product'
  description?: string;
  unitOfMeasure?: string;
  components?: ProductComponent[];
  measurements?: LinkedMeasurement[];
  categoryPath?: string | null;
  updatedAt?: string;
  readOnly?: boolean;
  unitPrice?: number;
  laborCost?: number;
  materialCost?: number;
  supplier?: string | null;
  sku?: string | null;
  notes?: string | null;
  catalogCategoryId?: string;
}

export interface ProductComponent {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
  componentType?: 'product' | 'labor';
  catalogProductId?: string | null;
  laborRate?: number;
  sortOrder?: number;
}

export interface LinkedMeasurement {
  id: string;
  markupId: string;
  documentId: string;
  page: number;
  type: 'length' | 'area' | 'count';
  value: number;
  unit: string;
  createdAt: string;
  groupId?: string; // Groups measurements taken in the same session
  groupLabel?: string; // Optional label for the group
}

export interface ProductsState {
  nodes: Record<string, ProductNode>;
  rootIds: string[]; // Top-level folder/product IDs
  activeProductId: string | null; // Currently selected for measurements
  selectedNodeId: string | null; // Selected in tree for editing
}

// Export payload for API integration
export interface ExportPayload {
  projectName: string;
  exportDate: string;
  products: ExportProduct[];
}

export interface ExportProduct {
  id: string;
  name: string;
  path: string; // "Electrical/Lighting/EM1"
  description: string;
  unitOfMeasure: string;
  components: Array<{
    name: string;
    quantity: number;
    unit: string;
  }>;
  measurements: {
    totalLength: number;
    totalArea: number;
    totalCount: number;
    details: Array<{
      type: 'length' | 'area' | 'count';
      value: number;
      unit: string;
      documentName: string;
      page: number;
    }>;
  };
}
