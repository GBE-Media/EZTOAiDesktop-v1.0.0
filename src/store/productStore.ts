import { create } from 'zustand';
import { ProductNode, ProductComponent, LinkedMeasurement, ExportPayload, ExportProduct } from '@/types/product';

interface ProductStore {
  nodes: Record<string, ProductNode>;
  rootIds: string[];
  activeProductId: string | null;
  selectedNodeId: string | null;
  
  // Active group tracking for session grouping
  activeCountGroupId: string | null;
  activeMeasurementGroupId: string | null;
  
  // Database sync actions
  loadFromDatabase: (nodes: Record<string, ProductNode>, rootIds: string[]) => void;
  clearStore: () => void;
  clearProductCounts: () => void; // Clear all measurements and counts but keep product structure
  
  // Actions
  addFolder: (parentId: string | null, name: string) => string;
  addProduct: (parentId: string | null, name: string) => string;
  deleteNode: (id: string) => void;
  renameNode: (id: string, name: string) => void;
  moveNode: (id: string, newParentId: string | null) => void;
  setActiveProduct: (id: string | null) => void;
  setSelectedNode: (id: string | null) => void;
  toggleExpanded: (id: string) => void;
  
  // Product-specific actions
  updateProductDescription: (id: string, description: string) => void;
  updateProductUnitOfMeasure: (id: string, unit: 'length' | 'area' | 'count' | 'each') => void;
  addComponent: (productId: string, component: Omit<ProductComponent, 'id'>) => void;
  updateComponent: (productId: string, componentId: string, updates: Partial<ProductComponent>) => void;
  deleteComponent: (productId: string, componentId: string) => void;
  
  // Measurement linking
  linkMeasurement: (productId: string, measurement: Omit<LinkedMeasurement, 'id' | 'createdAt'>) => void;
  unlinkMeasurement: (productId: string, measurementId: string) => void;
  unlinkMeasurementByMarkupId: (markupId: string) => LinkedMeasurement | null; // Returns the unlinked measurement for cascading
  getMeasurementByMarkupId: (markupId: string) => { productId: string; measurement: LinkedMeasurement } | null;
  updateMeasurementValueByMarkupId: (markupId: string, newValue: number) => void; // Update measurement value when count is renumbered
  
  // Group management
  setActiveCountGroup: (groupId: string | null) => void;
  setActiveMeasurementGroup: (groupId: string | null) => void;
  getOrCreateCountGroup: () => string; // Returns existing or creates new group ID
  getOrCreateMeasurementGroup: () => string;
  
  // Export
  getProductPath: (id: string) => string;
  exportProducts: (projectName: string) => ExportPayload;
  
  // Helpers
  getNode: (id: string) => ProductNode | undefined;
  getChildren: (parentId: string | null) => ProductNode[];
}

const generateId = () => crypto.randomUUID();

export const useProductStore = create<ProductStore>()(
  (set, get) => ({
    nodes: {},
    rootIds: [],
    activeProductId: null,
    selectedNodeId: null,
    activeCountGroupId: null,
    activeMeasurementGroupId: null,
    
    loadFromDatabase: (nodes, rootIds) => {
      set({ nodes, rootIds, activeProductId: null, selectedNodeId: null, activeCountGroupId: null, activeMeasurementGroupId: null });
    },
    
    clearStore: () => {
      set({ nodes: {}, rootIds: [], activeProductId: null, selectedNodeId: null, activeCountGroupId: null, activeMeasurementGroupId: null });
    },
    
    clearProductCounts: () => {
      // Clear all measurements from products but keep the product structure
      const state = get();
      const clearedNodes: Record<string, ProductNode> = {};
      
      Object.entries(state.nodes).forEach(([id, node]) => {
        if (node.type === 'product') {
          // Clear measurements but keep everything else
          clearedNodes[id] = {
            ...node,
            measurements: [],
          };
        } else {
          // Keep folders as-is
          clearedNodes[id] = node;
        }
      });
      
      set({ 
        nodes: clearedNodes,
        activeCountGroupId: null,
        activeMeasurementGroupId: null,
      });
    },
    
    addFolder: (parentId, name) => {
        const id = generateId();
        const node: ProductNode = {
          id,
          name,
          type: 'folder',
          parentId,
          children: [],
          expanded: true,
        };
        
        set((state) => {
          const newNodes = { ...state.nodes, [id]: node };
          let newRootIds = state.rootIds;
          
          if (parentId) {
            const parent = state.nodes[parentId];
            if (parent) {
              newNodes[parentId] = {
                ...parent,
                children: [...parent.children, id],
              };
            }
          } else {
            newRootIds = [...state.rootIds, id];
          }
          
          return { nodes: newNodes, rootIds: newRootIds };
        });
        
        return id;
      },
      
      addProduct: (parentId, name) => {
        const id = generateId();
        const node: ProductNode = {
          id,
          name,
          type: 'product',
          parentId,
          children: [],
          expanded: false,
          description: '',
          unitOfMeasure: 'each',
          components: [],
          measurements: [],
        };
        
        set((state) => {
          const newNodes = { ...state.nodes, [id]: node };
          let newRootIds = state.rootIds;
          
          if (parentId) {
            const parent = state.nodes[parentId];
            if (parent) {
              newNodes[parentId] = {
                ...parent,
                children: [...parent.children, id],
              };
            }
          } else {
            newRootIds = [...state.rootIds, id];
          }
          
          return { nodes: newNodes, rootIds: newRootIds };
        });
        
        return id;
      },
      
      deleteNode: (id) => {
        set((state) => {
          const node = state.nodes[id];
          if (!node) return state;
          
          // Recursively collect all descendant IDs
          const collectDescendants = (nodeId: string): string[] => {
            const n = state.nodes[nodeId];
            if (!n) return [nodeId];
            return [nodeId, ...n.children.flatMap(collectDescendants)];
          };
          
          const idsToDelete = new Set(collectDescendants(id));
          
          const newNodes = { ...state.nodes };
          idsToDelete.forEach((nodeId) => delete newNodes[nodeId]);
          
          // Remove from parent's children
          if (node.parentId && newNodes[node.parentId]) {
            newNodes[node.parentId] = {
              ...newNodes[node.parentId],
              children: newNodes[node.parentId].children.filter((cid) => cid !== id),
            };
          }
          
          // Remove from rootIds if it's a root node
          const newRootIds = state.rootIds.filter((rid) => rid !== id);
          
          // Clear selection if deleted node was selected
          const newSelectedId = idsToDelete.has(state.selectedNodeId || '') ? null : state.selectedNodeId;
          const newActiveId = idsToDelete.has(state.activeProductId || '') ? null : state.activeProductId;
          
          return {
            nodes: newNodes,
            rootIds: newRootIds,
            selectedNodeId: newSelectedId,
            activeProductId: newActiveId,
          };
        });
      },
      
      renameNode: (id, name) => {
        set((state) => {
          const node = state.nodes[id];
          if (!node) return state;
          return {
            nodes: {
              ...state.nodes,
              [id]: { ...node, name },
            },
          };
        });
      },
      
      moveNode: (id, newParentId) => {
        set((state) => {
          const node = state.nodes[id];
          if (!node) return state;
          
          // Prevent moving a node into itself or its descendants
          if (newParentId) {
            let current = state.nodes[newParentId];
            while (current) {
              if (current.id === id) return state;
              current = current.parentId ? state.nodes[current.parentId] : undefined;
            }
          }
          
          const newNodes = { ...state.nodes };
          
          // Remove from old parent
          if (node.parentId && newNodes[node.parentId]) {
            newNodes[node.parentId] = {
              ...newNodes[node.parentId],
              children: newNodes[node.parentId].children.filter((cid) => cid !== id),
            };
          }
          
          // Add to new parent
          if (newParentId && newNodes[newParentId]) {
            newNodes[newParentId] = {
              ...newNodes[newParentId],
              children: [...newNodes[newParentId].children, id],
            };
          }
          
          // Update node's parentId
          newNodes[id] = { ...node, parentId: newParentId };
          
          // Update rootIds
          let newRootIds = state.rootIds.filter((rid) => rid !== id);
          if (!newParentId) {
            newRootIds = [...newRootIds, id];
          }
          
          return { nodes: newNodes, rootIds: newRootIds };
        });
      },
      
      setActiveProduct: (id) => {
        set({ activeProductId: id });
      },
      
      setSelectedNode: (id) => {
        set({ selectedNodeId: id });
      },
      
      toggleExpanded: (id) => {
        set((state) => {
          const node = state.nodes[id];
          if (!node) return state;
          return {
            nodes: {
              ...state.nodes,
              [id]: { ...node, expanded: !node.expanded },
            },
          };
        });
      },
      
      updateProductDescription: (id, description) => {
        set((state) => {
          const node = state.nodes[id];
          if (!node || node.type !== 'product') return state;
          return {
            nodes: {
              ...state.nodes,
              [id]: { ...node, description },
            },
          };
        });
      },
      
      updateProductUnitOfMeasure: (id, unit) => {
        set((state) => {
          const node = state.nodes[id];
          if (!node || node.type !== 'product') return state;
          return {
            nodes: {
              ...state.nodes,
              [id]: { ...node, unitOfMeasure: unit },
            },
          };
        });
      },
      
      addComponent: (productId, component) => {
        set((state) => {
          const node = state.nodes[productId];
          if (!node || node.type !== 'product') return state;
          
          const newComponent: ProductComponent = {
            ...component,
            id: generateId(),
          };
          
          return {
            nodes: {
              ...state.nodes,
              [productId]: {
                ...node,
                components: [...(node.components || []), newComponent],
              },
            },
          };
        });
      },
      
      updateComponent: (productId, componentId, updates) => {
        set((state) => {
          const node = state.nodes[productId];
          if (!node || node.type !== 'product') return state;
          
          return {
            nodes: {
              ...state.nodes,
              [productId]: {
                ...node,
                components: (node.components || []).map((c) =>
                  c.id === componentId ? { ...c, ...updates } : c
                ),
              },
            },
          };
        });
      },
      
      deleteComponent: (productId, componentId) => {
        set((state) => {
          const node = state.nodes[productId];
          if (!node || node.type !== 'product') return state;
          
          return {
            nodes: {
              ...state.nodes,
              [productId]: {
                ...node,
                components: (node.components || []).filter((c) => c.id !== componentId),
              },
            },
          };
        });
      },
      
      linkMeasurement: (productId, measurement) => {
        set((state) => {
          const node = state.nodes[productId];
          if (!node || node.type !== 'product') return state;
          
          const newMeasurement: LinkedMeasurement = {
            ...measurement,
            id: generateId(),
            createdAt: new Date().toISOString(),
          };
          
          return {
            nodes: {
              ...state.nodes,
              [productId]: {
                ...node,
                measurements: [...(node.measurements || []), newMeasurement],
              },
            },
          };
        });
      },
      
      unlinkMeasurement: (productId, measurementId) => {
        set((state) => {
          const node = state.nodes[productId];
          if (!node || node.type !== 'product') return state;
          
          return {
            nodes: {
              ...state.nodes,
              [productId]: {
                ...node,
                measurements: (node.measurements || []).filter((m) => m.id !== measurementId),
              },
            },
          };
        });
      },
      
      unlinkMeasurementByMarkupId: (markupId) => {
        const state = get();
        let unlinkedMeasurement: LinkedMeasurement | null = null;
        
        // Find the measurement by markupId across all products
        for (const nodeId of Object.keys(state.nodes)) {
          const node = state.nodes[nodeId];
          if (node.type !== 'product') continue;
          
          const measurement = (node.measurements || []).find((m) => m.markupId === markupId);
          if (measurement) {
            unlinkedMeasurement = measurement;
            // Remove it from this product
            set((s) => ({
              nodes: {
                ...s.nodes,
                [nodeId]: {
                  ...s.nodes[nodeId],
                  measurements: (s.nodes[nodeId].measurements || []).filter((m) => m.markupId !== markupId),
                },
              },
            }));
            break;
          }
        }
        
        return unlinkedMeasurement;
      },
      
      getMeasurementByMarkupId: (markupId) => {
        const { nodes } = get();
        
        for (const nodeId of Object.keys(nodes)) {
          const node = nodes[nodeId];
          if (node.type !== 'product') continue;
          
          const measurement = (node.measurements || []).find((m) => m.markupId === markupId);
          if (measurement) {
            return { productId: nodeId, measurement };
          }
        }
        
        return null;
      },
      
      updateMeasurementValueByMarkupId: (markupId, newValue) => {
        const state = get();
        
        // Find the product containing this measurement
        for (const nodeId of Object.keys(state.nodes)) {
          const node = state.nodes[nodeId];
          if (node.type !== 'product') continue;
          
          const measurementIndex = (node.measurements || []).findIndex((m) => m.markupId === markupId);
          if (measurementIndex !== -1) {
            // Update the measurement value
            const updatedMeasurements = [...(node.measurements || [])];
            updatedMeasurements[measurementIndex] = {
              ...updatedMeasurements[measurementIndex],
              value: newValue,
            };
            
            set({
              nodes: {
                ...state.nodes,
                [nodeId]: {
                  ...node,
                  measurements: updatedMeasurements,
                },
              },
            });
            return;
          }
        }
      },
      
      setActiveCountGroup: (groupId) => {
        set({ activeCountGroupId: groupId });
      },
      
      setActiveMeasurementGroup: (groupId) => {
        set({ activeMeasurementGroupId: groupId });
      },
      
      getOrCreateCountGroup: () => {
        const state = get();
        if (state.activeCountGroupId) {
          return state.activeCountGroupId;
        }
        const newGroupId = generateId();
        set({ activeCountGroupId: newGroupId });
        return newGroupId;
      },
      
      getOrCreateMeasurementGroup: () => {
        const state = get();
        if (state.activeMeasurementGroupId) {
          return state.activeMeasurementGroupId;
        }
        const newGroupId = generateId();
        set({ activeMeasurementGroupId: newGroupId });
        return newGroupId;
      },
      
      getProductPath: (id) => {
        const { nodes } = get();
        const path: string[] = [];
        let current = nodes[id];
        
        while (current) {
          path.unshift(current.name);
          current = current.parentId ? nodes[current.parentId] : undefined;
        }
        
        return path.join('/');
      },
      
      exportProducts: (projectName) => {
        const { nodes, getProductPath } = get();
        
        // Only export products that have measurements (footages, areas, or counts applied)
        const products: ExportProduct[] = Object.values(nodes)
          .filter((node) => node.type === 'product' && (node.measurements?.length || 0) > 0)
          .map((node) => {
            const measurements = node.measurements || [];
            
            return {
              id: node.id,
              name: node.name,
              path: getProductPath(node.id),
              description: node.description || '',
              unitOfMeasure: node.unitOfMeasure || 'each',
              components: (node.components || []).map((c) => ({
                name: c.name,
                quantity: c.quantity,
                unit: c.unit,
              })),
              measurements: {
                totalLength: measurements
                  .filter((m) => m.type === 'length')
                  .reduce((sum, m) => sum + m.value, 0),
                totalArea: measurements
                  .filter((m) => m.type === 'area')
                  .reduce((sum, m) => sum + m.value, 0),
                totalCount: measurements
                  .filter((m) => m.type === 'count')
                  .reduce((sum, m) => sum + m.value, 0),
                details: measurements.map((m) => ({
                  type: m.type,
                  value: m.value,
                  unit: m.unit,
                  documentName: m.documentId,
                  page: m.page,
                })),
              },
            };
          });
        
        return {
          projectName,
          exportDate: new Date().toISOString(),
          products,
        };
      },
      
      getNode: (id) => get().nodes[id],
      
      getChildren: (parentId) => {
        const { nodes, rootIds } = get();
        if (parentId === null) {
          return rootIds.map((id) => nodes[id]).filter(Boolean);
        }
        const parent = nodes[parentId];
        if (!parent) return [];
      return parent.children.map((id) => nodes[id]).filter(Boolean);
    },
  })
);
