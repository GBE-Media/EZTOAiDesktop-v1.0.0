import { useEffect, useMemo, useState } from 'react';
import { Boxes, Box, Hash, Lock, Package, Plus, Ruler, Save, Trash2, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { useProductStore } from '@/store/productStore';
import { useCatalogStore } from '@/store/catalogStore';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useCatalogSync } from '@/components/catalog/CatalogSyncProvider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface ItemDraft {
  name: string;
  description: string;
  category: string;
  unit: string;
  unitPrice: string;
  laborCost: string;
  materialCost: string;
  supplier: string;
  sku: string;
  notes: string;
}

const emptyDraft: ItemDraft = {
  name: '',
  description: '',
  category: '',
  unit: 'each',
  unitPrice: '0',
  laborCost: '0',
  materialCost: '0',
  supplier: '',
  sku: '',
  notes: '',
};

const measurementTypeIcons = { length: Ruler, area: Box, count: Hash };

export function ProductDetailsPanel() {
  const { nodes, selectedNodeId, activeProductId, setActiveProduct } = useProductStore();
  const { products, assemblies, components } = useCatalogStore();
  const { queueMutation } = useCatalogSync();
  const activeDocument = useEditorStore((state) => state.activeDocument);
  const [draft, setDraft] = useState<ItemDraft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [componentType, setComponentType] = useState<'product' | 'labor'>('product');
  const [componentProductId, setComponentProductId] = useState('');
  const [componentDescription, setComponentDescription] = useState('');
  const [componentQuantity, setComponentQuantity] = useState('1');
  const [componentUnit, setComponentUnit] = useState('each');
  const [componentLaborRate, setComponentLaborRate] = useState('0');

  const selectedNode = selectedNodeId ? nodes[selectedNodeId] : null;
  const selectedProduct = selectedNode?.type === 'product' ? products[selectedNode.id] : null;
  const selectedAssembly = selectedNode?.type === 'assembly' ? assemblies[selectedNode.id] : null;
  const readOnly = Boolean(selectedProduct?.is_org_catalog);

  useEffect(() => {
    if (selectedProduct) {
      setDraft({
        name: selectedProduct.name,
        description: selectedProduct.description || '',
        category: selectedProduct.category || '',
        unit: selectedProduct.unit_of_measure,
        unitPrice: String(selectedProduct.unit_price),
        laborCost: String(selectedProduct.labor_cost),
        materialCost: String(selectedProduct.material_cost),
        supplier: selectedProduct.supplier || '',
        sku: selectedProduct.sku || '',
        notes: selectedProduct.notes || '',
      });
    } else if (selectedAssembly) {
      setDraft({
        ...emptyDraft,
        name: selectedAssembly.name,
        description: selectedAssembly.description || '',
        category: selectedAssembly.category || '',
        unit: selectedAssembly.unit_of_measure,
        sku: selectedAssembly.sku || '',
        notes: selectedAssembly.notes || '',
      });
    }
  }, [selectedAssembly, selectedProduct]);

  const assemblyComponents = useMemo(
    () =>
      selectedAssembly
        ? Object.values(components)
            .filter((component) => component.assembly_id === selectedAssembly.id)
            .sort((a, b) => a.sort_order - b.sort_order)
        : [],
    [components, selectedAssembly],
  );

  if (!selectedNode) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-4 text-center">
        <Package className="w-10 h-10 text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground">Select a catalog item to view details</p>
      </div>
    );
  }

  if (selectedNode.type === 'folder') {
    return (
      <div className="p-4">
        <h3 className="font-medium">{selectedNode.name}</h3>
        <p className="text-sm text-muted-foreground mt-2">
          Category containing {selectedNode.children.length} item(s)
        </p>
        {selectedNode.categoryPath && (
          <p className="text-xs text-muted-foreground mt-1">{selectedNode.categoryPath}</p>
        )}
      </div>
    );
  }

  if (!selectedProduct && !selectedAssembly) {
    return <div className="p-4 text-sm text-muted-foreground">This project item is not in the current catalog.</div>;
  }

  const measurements = (selectedNode.measurements || []).filter(
    (measurement) => activeDocument && measurement.documentId === activeDocument,
  );
  const isActive = activeProductId === selectedNode.id;

  const saveItem = async () => {
    setSaving(true);
    try {
      if (selectedProduct) {
        await queueMutation(
          'product_catalog',
          'update',
          {
            ...selectedProduct,
            name: draft.name.trim(),
            description: draft.description || null,
            category: draft.category || null,
            unit_of_measure: draft.unit,
            unit_price: Number(draft.unitPrice) || 0,
            labor_cost: Number(draft.laborCost) || 0,
            material_cost: Number(draft.materialCost) || 0,
            supplier: draft.supplier || null,
            sku: draft.sku || null,
            notes: draft.notes || null,
          },
          selectedProduct.updated_at,
        );
      } else if (selectedAssembly) {
        await queueMutation(
          'assemblies',
          'update',
          {
            ...selectedAssembly,
            name: draft.name.trim(),
            description: draft.description || null,
            category: draft.category || null,
            unit_of_measure: draft.unit,
            sku: draft.sku || null,
            notes: draft.notes || null,
          },
          selectedAssembly.updated_at,
        );
      }
      toast.success('Catalog item saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to save catalog item');
    } finally {
      setSaving(false);
    }
  };

  const addAssemblyComponent = async () => {
    if (!selectedAssembly || (componentType === 'product' && !componentProductId)) return;
    const now = new Date().toISOString();
    try {
      await queueMutation('assembly_components', 'insert', {
        id: crypto.randomUUID(),
        assembly_id: selectedAssembly.id,
        component_type: componentType,
        catalog_product_id: componentType === 'product' ? componentProductId : null,
        description: componentDescription || null,
        quantity: Number(componentQuantity) || 1,
        unit_of_measure: componentUnit,
        labor_rate: componentType === 'labor' ? Number(componentLaborRate) || 0 : 0,
        sort_order: assemblyComponents.length,
        created_at: now,
      });
      setComponentDescription('');
      setComponentQuantity('1');
      toast.success('Component added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to add component');
    }
  };

  const deleteAssemblyComponent = async (componentId: string) => {
    const component = components[componentId];
    if (!component) return;
    try {
      await queueMutation('assembly_components', 'delete', component);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to delete component');
    }
  };

  const setField = (field: keyof ItemDraft, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  return (
    <ScrollArea className="h-full">
      <div className="p-3 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {selectedNode.type === 'assembly' ? <Boxes className="w-5 h-5 text-violet-400" /> : <Package className="w-5 h-5 text-primary" />}
            <h3 className="font-medium">{selectedNode.type === 'assembly' ? 'Assembly' : 'Product'}</h3>
            {readOnly && <Lock className="w-3.5 h-3.5 text-muted-foreground" />}
          </div>
          <Button
            variant={isActive ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setActiveProduct(isActive ? null : selectedNode.id)}
          >
            {isActive ? 'Active' : 'Set Active'}
          </Button>
        </div>

        {readOnly && (
          <p className="text-xs rounded bg-muted px-2 py-1.5">Organization catalog items are read-only.</p>
        )}

        <div className="grid grid-cols-2 gap-2">
          <Field label="Name" value={draft.name} onChange={(value) => setField('name', value)} disabled={readOnly} />
          <Field label="Category path" value={draft.category} onChange={(value) => setField('category', value)} disabled={readOnly} />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Description</Label>
          <Textarea value={draft.description} onChange={(event) => setField('description', event.target.value)} disabled={readOnly} className="text-xs min-h-16" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Unit" value={draft.unit} onChange={(value) => setField('unit', value)} disabled={readOnly} />
          <Field label="SKU" value={draft.sku} onChange={(value) => setField('sku', value)} disabled={readOnly} />
          {selectedProduct && (
            <>
              <Field label="Unit price" type="number" value={draft.unitPrice} onChange={(value) => setField('unitPrice', value)} disabled={readOnly} />
              <Field label="Labor cost" type="number" value={draft.laborCost} onChange={(value) => setField('laborCost', value)} disabled={readOnly} />
              <Field label="Material cost" type="number" value={draft.materialCost} onChange={(value) => setField('materialCost', value)} disabled={readOnly} />
              <Field label="Supplier" value={draft.supplier} onChange={(value) => setField('supplier', value)} disabled={readOnly} />
            </>
          )}
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Notes</Label>
          <Textarea value={draft.notes} onChange={(event) => setField('notes', event.target.value)} disabled={readOnly} className="text-xs min-h-14" />
        </div>
        {!readOnly && (
          <Button className="w-full h-8" size="sm" disabled={saving || !draft.name.trim()} onClick={() => void saveItem()}>
            <Save className="w-3.5 h-3.5 mr-1" />
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        )}

        {selectedAssembly && (
          <div className="space-y-2 border-t pt-3">
            <Label className="text-xs">Assembly components</Label>
            {assemblyComponents.map((component) => (
              <div key={component.id} className="flex items-center gap-2 px-2 py-1.5 bg-secondary rounded text-xs">
                <span className="flex-1 truncate">
                  {component.catalog_product_id ? products[component.catalog_product_id]?.name || 'Missing product' : component.description || 'Labor'}
                </span>
                <span>{component.quantity} {component.unit_of_measure}</span>
                <button onClick={() => void deleteAssemblyComponent(component.id)} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
            <Select value={componentType} onValueChange={(value: 'product' | 'labor') => setComponentType(value)}>
              <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="product">Catalog product</SelectItem>
                <SelectItem value="labor">Labor</SelectItem>
              </SelectContent>
            </Select>
            {componentType === 'product' ? (
              <Select value={componentProductId} onValueChange={setComponentProductId}>
                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Choose product" /></SelectTrigger>
                <SelectContent>
                  {Object.values(products).map((product) => <SelectItem key={product.id} value={product.id}>{product.name}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input className="h-7 text-xs" placeholder="Labor description" value={componentDescription} onChange={(event) => setComponentDescription(event.target.value)} />
            )}
            <div className="grid grid-cols-3 gap-1">
              <Input className="h-7 text-xs" type="number" value={componentQuantity} onChange={(event) => setComponentQuantity(event.target.value)} placeholder="Qty" />
              <Input className="h-7 text-xs" value={componentUnit} onChange={(event) => setComponentUnit(event.target.value)} placeholder="Unit" />
              {componentType === 'labor' && <Input className="h-7 text-xs" type="number" value={componentLaborRate} onChange={(event) => setComponentLaborRate(event.target.value)} placeholder="Rate" />}
            </div>
            <Button variant="outline" size="sm" className="w-full h-7" onClick={() => void addAssemblyComponent()}>
              <Plus className="w-3.5 h-3.5 mr-1" /> Add component
            </Button>
          </div>
        )}

        <div className="space-y-2 border-t pt-3">
          <Label className="text-xs">Linked measurements ({measurements.length})</Label>
          {measurements.map((measurement) => {
            const Icon = measurementTypeIcons[measurement.type];
            return (
              <div key={measurement.id} className="flex items-center gap-2 px-2 py-1.5 bg-secondary rounded text-xs">
                <Icon className="w-3 h-3" />
                <span className="flex-1">{measurement.value.toFixed(measurement.type === 'count' ? 0 : 2)} {measurement.unit}</span>
                <button
                  title="Unlink measurement"
                  onClick={() => useCanvasStore.getState().deleteMarkupFromDocument(measurement.documentId, measurement.page, measurement.markupId)}
                >
                  <Unlink className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}

function Field({
  label,
  value,
  onChange,
  disabled,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  type?: string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        className={cn('h-7 text-xs', disabled && 'opacity-70')}
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
