import { useMemo, useState } from 'react';
import { Upload, FileText, Plus, Trash2 } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { useEditorStore } from '@/store/editorStore';
import { useCanvasStore } from '@/store/canvasStore';
import { uploadTrainingMaterial, type TrainingCountEntry } from '@/services/ai/trainingService';

interface TrainingMaterialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type TradeType = 'electrical' | 'plumbing' | 'hvac';
type PageScope = 'current' | 'all' | 'selection';

const emptyCount = (): TrainingCountEntry => ({ type: '', quantity: 1, notes: '' });

export function TrainingMaterialDialog({ open, onOpenChange }: TrainingMaterialDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const { documents, activeDocument } = useEditorStore();
  const { getOriginalPdfBytes } = useCanvasStore();

  const activeDoc = useMemo(
    () => documents.find(doc => doc.id === activeDocument),
    [documents, activeDocument]
  );

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [trade, setTrade] = useState<TradeType>('electrical');
  const [pageScope, setPageScope] = useState<PageScope>('current');
  const [projectName, setProjectName] = useState('');
  const [notes, setNotes] = useState('');
  const [counts, setCounts] = useState<TrainingCountEntry[]>([emptyCount()]);

  const resetForm = () => {
    setSelectedFile(null);
    setTrade('electrical');
    setPageScope('current');
    setProjectName('');
    setNotes('');
    setCounts([emptyCount()]);
  };

  const handleClose = () => {
    resetForm();
    onOpenChange(false);
  };

  const handleFileChange = (file?: File | null) => {
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      toast({ title: 'Unsupported file', description: 'Please select a PDF file.' });
      return;
    }
    setSelectedFile(file);
    if (!projectName) {
      setProjectName(file.name.replace(/\.pdf$/i, ''));
    }
  };

  const handleUseCurrentFile = () => {
    if (!activeDoc) {
      toast({ title: 'No document', description: 'Open a PDF on the canvas first.' });
      return;
    }
    const bytes = getOriginalPdfBytes(activeDoc.id);
    if (!bytes) {
      toast({ title: 'Unavailable', description: 'The current document data is not available.' });
      return;
    }
    const fileName = activeDoc.name.endsWith('.pdf') ? activeDoc.name : `${activeDoc.name}.pdf`;
    const file = new File([bytes], fileName, { type: 'application/pdf' });
    setSelectedFile(file);
    setProjectName(activeDoc.name);
  };

  const updateCount = (index: number, updates: Partial<TrainingCountEntry>) => {
    setCounts(current =>
      current.map((entry, idx) => (idx === index ? { ...entry, ...updates } : entry))
    );
  };

  const addCountRow = () => setCounts(current => [...current, emptyCount()]);
  const removeCountRow = (index: number) =>
    setCounts(current => current.filter((_, idx) => idx !== index));

  const handleSubmit = async () => {
    if (!user) {
      toast({ title: 'Sign in required', description: 'Please sign in to submit training data.' });
      return;
    }
    if (!selectedFile) {
      toast({ title: 'Missing file', description: 'Please attach a PDF or use the current canvas file.' });
      return;
    }
    const cleanedCounts = counts
      .map(entry => ({ ...entry, type: entry.type.trim() }))
      .filter(entry => entry.type && entry.quantity > 0);
    if (cleanedCounts.length === 0) {
      toast({ title: 'Add counts', description: 'Provide at least one fixture/count entry.' });
      return;
    }

    setIsSubmitting(true);
    try {
      await uploadTrainingMaterial({
        userId: user.id,
        file: selectedFile,
        projectName: projectName || selectedFile.name,
        pageScope,
        trade,
        counts: cleanedCounts,
        notes: notes.trim(),
      });
      toast({ title: 'Training saved', description: 'Thanks! Your data was sent for AI learning.' });
      handleClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to upload training data.';
      toast({ title: 'Upload failed', description: message });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>AI Training Material</DialogTitle>
          <DialogDescription>
            Provide a PDF and your verified counts to help the AI learn your standards.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Project name</Label>
              <Input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                placeholder="Project name"
              />
            </div>
            <div className="space-y-2">
              <Label>Trade</Label>
              <Select value={trade} onValueChange={(value: TradeType) => setTrade(value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select trade" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="electrical">Electrical</SelectItem>
                  <SelectItem value="plumbing">Plumbing</SelectItem>
                  <SelectItem value="hvac">HVAC</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Page scope</Label>
              <Select value={pageScope} onValueChange={(value: PageScope) => setPageScope(value)}>
                <SelectTrigger>
                  <SelectValue placeholder="Select scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">Current page</SelectItem>
                  <SelectItem value="all">All pages</SelectItem>
                  <SelectItem value="selection">Selected region</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Training PDF</Label>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => document.getElementById('ai-training-upload')?.click()}
                >
                  <Upload className="h-4 w-4 mr-2" />
                  Upload PDF
                </Button>
                <Button type="button" variant="outline" onClick={handleUseCurrentFile}>
                  <FileText className="h-4 w-4 mr-2" />
                  Use current file
                </Button>
              </div>
              <input
                id="ai-training-upload"
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(event) => handleFileChange(event.target.files?.[0])}
              />
              {selectedFile && (
                <p className="text-xs text-muted-foreground">
                  Selected: {selectedFile.name}
                </p>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Verified counts</Label>
              <Button type="button" variant="ghost" size="sm" onClick={addCountRow}>
                <Plus className="h-4 w-4 mr-1" />
                Add row
              </Button>
            </div>
            <div className="space-y-2">
              {counts.map((entry, index) => (
                <div key={index} className="grid gap-2 md:grid-cols-[1.5fr_0.6fr_1.5fr_auto] items-center">
                  <Input
                    value={entry.type}
                    onChange={(event) => updateCount(index, { type: event.target.value })}
                    placeholder="Type (e.g. A, B1, A/EM/NL)"
                  />
                  <Input
                    type="number"
                    min={1}
                    value={entry.quantity}
                    onChange={(event) => updateCount(index, { quantity: Number(event.target.value) || 0 })}
                    placeholder="Qty"
                  />
                  <Input
                    value={entry.notes || ''}
                    onChange={(event) => updateCount(index, { notes: event.target.value })}
                    placeholder="Notes (optional)"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={() => removeCountRow(index)}
                    disabled={counts.length === 1}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Additional notes</Label>
            <Textarea
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Optional context (schedule notes, symbol definitions, assumptions)"
              className="min-h-[90px]"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleClose} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button type="button" onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? 'Submitting…' : 'Submit training'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
