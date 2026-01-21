// Product can be a folder or an item
export interface ProductNode {
  id: string;
  name: string;
  type: 'folder' | 'product';
  parentId: string | null;
  children: string[]; // Child node IDs for folders
  expanded: boolean;
  
  // Only for type: 'product'
  description?: string;
  unitOfMeasure?: 'length' | 'area' | 'count' | 'each';
  components?: ProductComponent[];
  measurements?: LinkedMeasurement[];
}

export interface ProductComponent {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
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
