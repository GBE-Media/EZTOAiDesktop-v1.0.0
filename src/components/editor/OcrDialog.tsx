import { useState, useCallback, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { CheckCircle2, FileText } from 'lucide-react';

interface OcrDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  totalPages: number;
  currentPage: number;
  onRunOcr: (pageRange: number[]) => Promise<void>;
  ocrProgress: number;
  ocrStatus: 'none' | 'running' | 'completed' | 'failed';
}

type PageRangeOption = 'all' | 'current' | 'custom';

function parsePageRange(input: string, maxPages: number): number[] {
  const pages: Set<number> = new Set();
  const parts = input.split(',').map(p => p.trim());
  
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(n => parseInt(n.trim(), 10));
      if (!isNaN(start) && !isNaN(end)) {
        for (let i = Math.max(1, start); i <= Math.min(maxPages, end); i++) {
          pages.add(i);
        }
      }
    } else {
      const page = parseInt(part, 10);
      if (!isNaN(page) && page >= 1 && page <= maxPages) {
        pages.add(page);
      }
    }
  }
  
  return Array.from(pages).sort((a, b) => a - b);
}

export function OcrDialog({
  open,
  onOpenChange,
  totalPages,
  currentPage,
  onRunOcr,
  ocrProgress,
  ocrStatus,
}: OcrDialogProps) {
  const [pageRangeOption, setPageRangeOption] = useState<PageRangeOption>('all');
  const [customRange, setCustomRange] = useState('');
  const [processingPage, setProcessingPage] = useState(0);
  const [totalToProcess, setTotalToProcess] = useState(0);
  const [isRunning, setIsRunning] = useState(false);

  // Reset state when dialog opens
  useEffect(() => {
    if (open && ocrStatus !== 'running') {
      setIsRunning(false);
      setProcessingPage(0);
      setTotalToProcess(0);
    }
  }, [open, ocrStatus]);

  // Update processing info from progress
  useEffect(() => {
    if (ocrStatus === 'running') {
      setIsRunning(true);
    } else if (ocrStatus === 'completed' || ocrStatus === 'failed') {
      setIsRunning(false);
    }
  }, [ocrStatus]);

  const getPageRange = useCallback((): number[] => {
    switch (pageRangeOption) {
      case 'all':
        return Array.from({ length: totalPages }, (_, i) => i + 1);
      case 'current':
        return [currentPage];
      case 'custom':
        return parsePageRange(customRange, totalPages);
      default:
        return [];
    }
  }, [pageRangeOption, totalPages, currentPage, customRange]);

  const handleRunOcr = useCallback(async () => {
    const pages = getPageRange();
    if (pages.length === 0) return;
    
    setTotalToProcess(pages.length);
    setProcessingPage(0);
    setIsRunning(true);
    
    await onRunOcr(pages);
  }, [getPageRange, onRunOcr]);

  const isCustomRangeValid = pageRangeOption !== 'custom' || parsePageRange(customRange, totalPages).length > 0;

  // Calculate current processing page from progress
  const currentProcessingPage = Math.ceil((ocrProgress / 100) * totalToProcess);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Recognize Text (OCR)
          </DialogTitle>
          <DialogDescription>
            Extract text from PDF pages to enable text-selection highlighting.
          </DialogDescription>
        </DialogHeader>

        {ocrStatus === 'completed' ? (
          // Completed state
          <div className="flex flex-col items-center py-8 gap-4">
            <CheckCircle2 className="h-16 w-16 text-green-500" />
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">OCR Complete!</p>
              <p className="text-sm text-muted-foreground mt-1">
                Text recognition finished successfully. The highlight tool will now snap to text.
              </p>
            </div>
          </div>
        ) : isRunning || ocrStatus === 'running' ? (
          // Running state with progress
          <div className="py-6 space-y-4">
            <div className="text-center space-y-1">
              <p className="text-sm font-medium text-foreground">
                Analyzing text...
              </p>
              <p className="text-xs text-muted-foreground">
                Processing page {currentProcessingPage || 1} of {totalToProcess || totalPages}
              </p>
              <p className="text-xs text-muted-foreground/70">
                Using AI-powered text recognition for scanned pages
              </p>
            </div>
            <Progress value={ocrProgress} className="h-2" />
            <p className="text-center text-xs text-muted-foreground">
              {ocrProgress}% complete
            </p>
          </div>
        ) : (
          // Selection state
          <div className="py-4">
            <RadioGroup
              value={pageRangeOption}
              onValueChange={(value) => setPageRangeOption(value as PageRangeOption)}
              className="space-y-3"
            >
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="all" id="all" />
                <Label htmlFor="all" className="cursor-pointer">
                  All pages <span className="text-muted-foreground">(1-{totalPages})</span>
                </Label>
              </div>
              
              <div className="flex items-center space-x-3">
                <RadioGroupItem value="current" id="current" />
                <Label htmlFor="current" className="cursor-pointer">
                  Current page only <span className="text-muted-foreground">(Page {currentPage})</span>
                </Label>
              </div>
              
              <div className="flex items-start space-x-3">
                <RadioGroupItem value="custom" id="custom" className="mt-0.5" />
                <div className="flex-1 space-y-2">
                  <Label htmlFor="custom" className="cursor-pointer">
                    Custom range
                  </Label>
                  {pageRangeOption === 'custom' && (
                    <Input
                      type="text"
                      placeholder="e.g., 1-5, 8, 10-15"
                      value={customRange}
                      onChange={(e) => setCustomRange(e.target.value)}
                      className="h-8 text-sm"
                    />
                  )}
                </div>
              </div>
            </RadioGroup>
            
            {pageRangeOption === 'custom' && customRange && (
              <p className="mt-3 text-xs text-muted-foreground">
                {parsePageRange(customRange, totalPages).length} page(s) will be processed
              </p>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {ocrStatus === 'completed' ? (
            <Button onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : isRunning || ocrStatus === 'running' ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Run in Background
            </Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button 
                onClick={handleRunOcr}
                disabled={!isCustomRangeValid}
              >
                Run OCR
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
