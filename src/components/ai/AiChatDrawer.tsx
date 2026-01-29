/**
 * AI Chat Drawer Component
 * Floating slide-out panel for AI interaction
 */

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { X, Bot, Sparkles, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAIChatStore } from '@/store/aiChatStore';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { useEditorStore } from '@/store/editorStore';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AiToolbar } from './AiToolbar';
import { AiSettingsDialog } from './AiSettingsDialog';
import { getAIService } from '@/services/ai/aiService';
import { chat as aiChat, runPipeline } from '@/services/ai/pipeline';
import { renderPageForOcr } from '@/lib/pdfLoader';
import { cn } from '@/lib/utils';
import { createPageImageGenerator, getOptimalScale } from '@/services/ai/imageCapture';
import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import type { BlueprintAnalysisResult, CanvasPlacement, PlacementMarkup } from '@/services/ai/providers/types';

export function AiChatDrawer() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pageSelection, setPageSelection] = useState('current');
  const [productMapOpen, setProductMapOpen] = useState(false);
  const [productMapKeys, setProductMapKeys] = useState<string[]>([]);
  const [productMapValues, setProductMapValues] = useState<Record<string, string>>({});
  const [productMapMarkups, setProductMapMarkups] = useState<Array<{ page: number; markup: CanvasMarkup }>>([]);
  
  // Chat store
  const {
    isOpen,
    closeDrawer,
    messages,
    isLoading,
    addMessage,
    updateMessage,
    clearMessages,
    selectedTrade,
    placementMode,
    pipelineStatus,
    setPipelineStatus,
    setPendingPlacements,
  } = useAIChatStore();
  
  // Settings store
  const { initialize: initSettings, isInitialized } = useAISettingsStore();
  
  // Canvas store for page context
  const { activeDocId, pdfDocuments, currentPage, pageWidth, pageHeight, defaultStyle, addAIMarkupBatch, getSnapPointForPage, extractDocumentSnapData } = useCanvasStore();
  const { nodes, linkMeasurement } = useProductStore();
  
  // Editor store for document info
  const { documents, activeDocument } = useEditorStore();
  
  // Initialize settings on mount
  useEffect(() => {
    if (!isInitialized) {
      initSettings();
    }
  }, [isInitialized, initSettings]);
  
  // Initialize AI service with proxy mode (company API keys via Edge Function)
  useEffect(() => {
    if (isInitialized) {
      // Use proxy by default - no local API keys needed
      getAIService().initialize({ useProxy: true });
    }
  }, [isInitialized]);
  
  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);
  
  // Get current page image for context
  const getCurrentPageImage = useCallback(async (): Promise<string | undefined> => {
    if (!activeDocId || !pdfDocuments[activeDocId]) {
      console.log('[AI] No active document to capture');
      return undefined;
    }
    
    const docData = pdfDocuments[activeDocId];
    const page = docData.currentPage || 1;
    const pdfDoc = docData.pdfDocument;
    
    if (!pdfDoc) {
      console.log('[AI] PDF document not loaded');
      return undefined;
    }
    
    try {
      // renderPageForOcr expects (pdfDoc, pageNumber, dpi)
      // Use 150 DPI for good quality without excessive size
      const canvas = await renderPageForOcr(pdfDoc, page, 150);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85); // Use JPEG for smaller size
      console.log('[AI] Page', page, 'captured, canvas size:', canvas.width, 'x', canvas.height);
      return dataUrl;
    } catch (error) {
      console.error('[AI] Failed to get page image:', error);
      return undefined;
    }
  }, [activeDocId, pdfDocuments]);
  
  const totalPages = activeDocId ? pdfDocuments[activeDocId]?.totalPages || 0 : 0;
  const selectedPages = useMemo(
    () => parsePageSelection(pageSelection, totalPages, currentPage || 1),
    [pageSelection, totalPages, currentPage]
  );
  
  // Handle sending a message
  const handleSendMessage = useCallback(async (content: string, images?: string[], options?: { forcePipeline?: boolean }) => {
    // AI service uses proxy by default - no local API keys needed
    // Just need to be authenticated
    
    // Add user message
    addMessage({
      role: 'user',
      content,
      images,
    });
    
    // Add loading assistant message
    const assistantMsgId = addMessage({
      role: 'assistant',
      content: '',
      isLoading: true,
    });
    
    try {
      setPipelineStatus({ isRunning: true, message: 'Processing...' });
      
      // Always capture the current page if a document is open
      // This ensures the AI can see and analyze the blueprint
      let imageBase64: string | undefined;
      
      if (images?.length) {
        // User attached an image
        imageBase64 = images[0];
        console.log('[AI] Using user-attached image');
      } else if (activeDocId) {
        // Capture the current page from the open document
        console.log('[AI] Capturing current page image...');
        setPipelineStatus({ isRunning: true, message: 'Capturing page...' });
        imageBase64 = await getCurrentPageImage();
        if (imageBase64) {
          console.log('[AI] Page captured successfully, size:', Math.round(imageBase64.length / 1024), 'KB');
        } else {
          console.warn('[AI] Failed to capture page image');
        }
      } else {
        console.log('[AI] No document open, sending text-only message');
      }
      
      // Build previous messages for context (last 10)
      const previousMessages = messages
        .filter(m => m.role !== 'system' && !m.isLoading)
        .slice(-10)
        .map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      
      const shouldRunPipeline = options?.forcePipeline || shouldRunTakeoff(content);
      const docData = activeDocId ? pdfDocuments[activeDocId] : null;
      
      if (shouldRunPipeline && docData?.pdfDocument && selectedPages.length > 0) {
        const optimalScale = getOptimalScale(docData.originalPageWidth, docData.originalPageHeight);
        const imageGenerator = createPageImageGenerator(docData.pdfDocument, {
          scale: optimalScale,
          format: 'jpeg',
          quality: 0.85,
        });
        
        const pipelineResult = await runPipeline({
          trade: selectedTrade,
          pages: selectedPages,
          imageGenerator,
          pageWidth: docData.originalPageWidth || pageWidth,
          pageHeight: docData.originalPageHeight || pageHeight,
          userPrompt: content,
          pdfDoc: docData.pdfDocument,
          refinePlacements: true,
          onProgress: (progress) => {
            setPipelineStatus({
              isRunning: true,
              currentStage: progress.stage,
              progress: progress.progress,
              message: progress.message,
            });
          },
        });
        
        if (!pipelineResult.success || !pipelineResult.placements) {
          throw new Error(pipelineResult.error || 'AI pipeline failed');
        }
        
        const aiGroupId = `ai_${Date.now()}`;
        const scaleX = docData.originalPageWidth ? (pageWidth || docData.originalPageWidth) / docData.originalPageWidth : 1;
        const scaleY = docData.originalPageHeight ? (pageHeight || docData.originalPageHeight) / docData.originalPageHeight : 1;
        const markups = convertPlacementsToMarkups(
          pipelineResult.placements,
          defaultStyle,
          aiGroupId,
          scaleX,
          scaleY
        );
        
        await Promise.all(selectedPages.map((page) => extractDocumentSnapData(page)));
        const snappedMarkups = snapMarkupsToDocument(markups, getSnapPointForPage);
        
        if (snappedMarkups.length > 0) {
          if (placementMode === 'confirm') {
            addAIMarkupBatch(snappedMarkups, true);
            setPendingPlacements(
              snappedMarkups.map(({ page, markup }) => ({
                id: markup.id,
                type: markup.type,
                page,
                data: markup,
              }))
            );
          } else {
            addAIMarkupBatch(snappedMarkups, false);
          }
        }
        
        const estimateCount = pipelineResult.estimate?.items?.length || 0;
        const typeCounts = extractTypeCounts(pipelineResult.analysis || []);
        const typeCountSummary = formatTypeCounts(typeCounts);
        const responseText = [
          `Analyzed pages: ${selectedPages.join(', ')}`,
          `Detected items: ${estimateCount}`,
          typeCountSummary ? `Type counts: ${typeCountSummary}` : 'Type counts: none detected',
          `Suggested markups: ${snappedMarkups.length}`,
          placementMode === 'confirm'
            ? 'Review the suggested placements and confirm to add them to the canvas.'
            : 'Placements have been added to the canvas.',
        ].join('\n');

        const detectedKeys = collectDetectedKeys(pipelineResult.analysis || [], snappedMarkups);
        if (detectedKeys.length > 0) {
          setProductMapKeys(detectedKeys);
          setProductMapValues({});
          setProductMapMarkups(snappedMarkups);
          setProductMapOpen(true);
        }
        
        updateMessage(assistantMsgId, {
          content: responseText,
          isLoading: false,
          metadata: { trade: selectedTrade },
        });
        return;
      }
      
      // Send to AI (chat-only)
      const response = await aiChat({
        message: content,
        context: {
          trade: selectedTrade,
          currentPage: currentPage,
          previousMessages,
        },
        imageBase64,
      });
      
      // Update assistant message with response
      updateMessage(assistantMsgId, {
        content: response,
        isLoading: false,
        metadata: {
          trade: selectedTrade,
        },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An error occurred';
      updateMessage(assistantMsgId, {
        content: '',
        isLoading: false,
        error: errorMessage,
      });
    } finally {
      setPipelineStatus({ isRunning: false, progress: 0, message: '' });
    }
  }, [
    addMessage,
    updateMessage,
    setPipelineStatus,
    getCurrentPageImage,
    messages,
    selectedTrade,
    currentPage,
    activeDocId,
    pdfDocuments,
    selectedPages,
    placementMode,
    pageWidth,
    pageHeight,
    defaultStyle,
    addAIMarkupBatch,
    setPendingPlacements,
    getSnapPointForPage,
    extractDocumentSnapData,
  ]);
  
  // Handle keyboard shortcut to open drawer
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + Shift + A to toggle drawer
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        useAIChatStore.getState().toggleDrawer();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  
  const hasMessages = messages.length > 0;
  // AI is always available when authenticated (uses company API keys via proxy)
  const isAIAvailable = isInitialized;

  return (
    <>
      <Sheet open={isOpen} onOpenChange={(open) => !open && closeDrawer()}>
        <SheetContent
          side="right"
          className="w-[450px] sm:w-[500px] p-0 flex flex-col"
          hideCloseButton
        >
          {/* Header */}
          <SheetHeader className="px-4 py-3 border-b border-border flex-shrink-0">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
                  <Bot className="w-4 h-4 text-white" />
                </div>
                <div>
                  <SheetTitle className="text-base">EZTO AI Assistant</SheetTitle>
                  <p className="text-xs text-muted-foreground">Blueprint analysis & estimation</p>
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                onClick={closeDrawer}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </SheetHeader>
          
          {/* Toolbar */}
          <AiToolbar
            onOpenSettings={() => setSettingsOpen(true)}
            onClearChat={clearMessages}
            onRunTakeoff={() => handleSendMessage('Run a full takeoff for the selected pages.', undefined, { forcePipeline: true })}
          />
          
          {/* Page Selection */}
          {activeDocId && totalPages > 0 && (
            <div className="px-4 py-2 border-b border-border bg-secondary/20">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Pages</span>
                <Input
                  value={pageSelection}
                  onChange={(event) => setPageSelection(event.target.value)}
                  placeholder="current, all, or 1,3-5"
                  className="h-7 text-xs"
                />
                <span className="text-[10px] text-muted-foreground">
                  {selectedPages.length ? `${selectedPages.length}/${totalPages}` : `0/${totalPages}`}
                </span>
              </div>
            </div>
          )}
          
          {/* Messages */}
          <ScrollArea ref={scrollRef} className="flex-1">
            {!hasMessages ? (
              <div className="flex flex-col items-center justify-center h-full p-8 text-center">
                <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-600/20 flex items-center justify-center mb-4">
                  <Sparkles className="w-8 h-8 text-violet-500" />
                </div>
                <h3 className="text-lg font-medium mb-2">AI Blueprint Assistant</h3>
                <p className="text-sm text-muted-foreground mb-6 max-w-[300px]">
                  Analyze blueprints, count materials, get code references, and generate layout suggestions.
                </p>
                
                <div className="space-y-2 w-full max-w-[300px]">
                  <p className="text-xs text-muted-foreground mb-2">Try asking:</p>
                  <QuickPrompt
                    text="Count all outlets on this page"
                    onClick={() => handleSendMessage('Count all outlets on this page')}
                    disabled={!isAIAvailable || isLoading}
                  />
                  <QuickPrompt
                    text="Analyze this blueprint for electrical components"
                    onClick={() => handleSendMessage('Analyze this blueprint for electrical components')}
                    disabled={!isAIAvailable || isLoading}
                  />
                  <QuickPrompt
                    text="Suggest conduit runs for the devices shown"
                    onClick={() => handleSendMessage('Suggest conduit runs for the devices shown')}
                    disabled={!isAIAvailable || isLoading}
                  />
                </div>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {messages.map(message => (
                  <ChatMessage key={message.id} message={message} />
                ))}
              </div>
            )}
          </ScrollArea>
          
          {/* Pipeline Status */}
          {pipelineStatus.isRunning && (
            <div className="px-4 py-2 bg-secondary/50 border-t border-border">
              <div className="flex items-center gap-2 text-sm">
                <div className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
                <span className="text-muted-foreground">{pipelineStatus.message}</span>
              </div>
              <div className="mt-1.5 h-1 bg-secondary rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-violet-500 to-purple-600 transition-all duration-300"
                  style={{ width: `${pipelineStatus.progress}%` }}
                />
              </div>
            </div>
          )}
          
          {/* Input */}
          <ChatInput
            onSend={handleSendMessage}
            isLoading={isLoading || pipelineStatus.isRunning}
            disabled={!isAIAvailable}
            placeholder="Ask about your blueprints..."
          />
        </SheetContent>
      </Sheet>
      
      {/* Settings Dialog */}
      <AiSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />

      <Dialog open={productMapOpen} onOpenChange={setProductMapOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Map AI Types to Products</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {productMapKeys.map((key) => (
              <div key={key} className="space-y-1">
                <Label className="text-xs">{key}</Label>
                <Select
                  value={productMapValues[key] || ''}
                  onValueChange={(value) =>
                    setProductMapValues((prev) => ({ ...prev, [key]: value }))
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select a product" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.values(nodes)
                      .filter((node) => node.type === 'product')
                      .map((node) => (
                        <SelectItem key={node.id} value={node.id}>
                          {node.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => setProductMapOpen(false)}
            >
              Skip
            </Button>
            <Button
              onClick={() => {
                applyProductMappings({
                  activeDocId,
                  mappings: productMapValues,
                  markups: productMapMarkups,
                  linkMeasurement,
                });
                setProductMapOpen(false);
              }}
            >
              Apply Counts
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// Quick prompt button component
function QuickPrompt({
  text,
  onClick,
  disabled,
}: {
  text: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full text-left px-3 py-2 text-sm rounded-lg border border-border',
        'hover:bg-secondary/50 hover:border-primary/50 transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed'
      )}
    >
      {text}
    </button>
  );
}

function parsePageSelection(input: string, totalPages: number, currentPage: number): number[] {
  if (!totalPages) return [];
  const normalized = input.trim().toLowerCase();
  if (!normalized || normalized === 'current') return [currentPage];
  if (normalized === 'all') {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }
  
  const pages = new Set<number>();
  const tokens = normalized.split(',').map(token => token.trim()).filter(Boolean);
  
  for (const token of tokens) {
    if (token.includes('-')) {
      const [startRaw, endRaw] = token.split('-');
      const start = Math.max(1, Math.min(totalPages, parseInt(startRaw, 10)));
      const end = Math.max(1, Math.min(totalPages, parseInt(endRaw, 10)));
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      const [rangeStart, rangeEnd] = start <= end ? [start, end] : [end, start];
      for (let i = rangeStart; i <= rangeEnd; i += 1) {
        pages.add(i);
      }
    } else {
      const page = parseInt(token, 10);
      if (!Number.isNaN(page) && page >= 1 && page <= totalPages) {
        pages.add(page);
      }
    }
  }
  
  if (pages.size === 0) return [currentPage];
  return Array.from(pages).sort((a, b) => a - b);
}

function shouldRunTakeoff(message: string): boolean {
  const normalized = message.toLowerCase();
  const keywords = [
    'how many',
    'quantity',
    'qty',
    'takeoff',
    'estimate',
    'count',
    'analyze',
    'analysis',
    'fixture',
    'fixtures',
    'schedule',
    'legend',
    'type a',
    'type b',
    'type c',
    'type d',
    'place',
    'mark up',
    'markup',
    'layout',
    'suggest',
  ];
  return keywords.some(keyword => normalized.includes(keyword));
}

function extractTypeCounts(analysisResults: BlueprintAnalysisResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  
  analysisResults.forEach(result => {
    const resultCounts = (result as { typeCounts?: Record<string, number> }).typeCounts;
    if (resultCounts) {
      Object.entries(resultCounts).forEach(([key, value]) => {
        const normalizedKey = key.toUpperCase();
        counts[normalizedKey] = (counts[normalizedKey] || 0) + (value || 0);
      });
    }
    
    result.items?.forEach(item => {
      const source = `${item.name || ''} ${item.type || ''} ${item.notes || ''}`;
      const match = source.match(/\btype\s*([A-Z0-9]+)\b/i);
      if (match?.[1]) {
        const key = match[1].toUpperCase();
        counts[key] = (counts[key] || 0) + (item.quantity || 1);
      }
    });
  });
  
  return counts;
}

function formatTypeCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return '';
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function snapMarkupsToDocument(
  markups: Array<{ page: number; markup: CanvasMarkup }>,
  getSnapPointForPage: (page: number, point: { x: number; y: number }, snapDistance?: number) => { point: { x: number; y: number } }
): Array<{ page: number; markup: CanvasMarkup }> {
  const snapDistance = 12;
  return markups.map(({ page, markup }) => {
    if ('points' in markup && Array.isArray(markup.points) && markup.points.length > 0) {
      const snappedPoints = markup.points.map((point) => getSnapPointForPage(page, point, snapDistance).point);
      return { page, markup: { ...markup, points: snappedPoints } };
    }
    if ('x' in markup && 'y' in markup) {
      const snapped = getSnapPointForPage(page, { x: markup.x, y: markup.y }, snapDistance).point;
      return { page, markup: { ...markup, x: snapped.x, y: snapped.y } as CanvasMarkup };
    }
    return { page, markup };
  });
}

function collectDetectedKeys(
  analysisResults: BlueprintAnalysisResult[],
  markups: Array<{ page: number; markup: CanvasMarkup }>
): string[] {
  const keys = new Set<string>();
  analysisResults.forEach((result) => {
    result.items?.forEach((item) => {
      if (item.name) keys.add(item.name);
      if (item.type) keys.add(item.type);
      const source = `${item.name || ''} ${item.type || ''} ${item.notes || ''}`;
      const match = source.match(/\btype\s*([A-Z0-9]+)\b/i);
      if (match?.[1]) {
        keys.add(`Type ${match[1].toUpperCase()}`);
      }
    });
  });
  markups.forEach(({ markup }) => {
    if ('label' in markup && markup.label) {
      keys.add(markup.label);
    }
  });
  return Array.from(keys).filter(Boolean);
}

function applyProductMappings(options: {
  activeDocId: string | null;
  mappings: Record<string, string>;
  markups: Array<{ page: number; markup: CanvasMarkup }>;
  linkMeasurement: (productId: string, measurement: {
    markupId: string;
    documentId: string;
    page: number;
    type: 'count';
    value: number;
    unit: string;
    groupId?: string;
    groupLabel?: string;
  }) => void;
}) {
  const { activeDocId, mappings, markups, linkMeasurement } = options;
  if (!activeDocId) return;
  const labelsToProduct = mappings;
  markups.forEach(({ page, markup }) => {
    if (markup.type !== 'count-marker') return;
    const label = 'label' in markup ? markup.label || '' : '';
    const productId = label ? labelsToProduct[label] : '';
    if (!productId) return;
    linkMeasurement(productId, {
      markupId: markup.id,
      documentId: activeDocId,
      page,
      type: 'count',
      value: 1,
      unit: 'ea',
      groupId: 'groupId' in markup ? markup.groupId : undefined,
      groupLabel: label || undefined,
    });
  });
}

function convertPlacementsToMarkups(
  placements: CanvasPlacement,
  defaultStyle: MarkupStyle,
  groupId: string,
  scaleX: number,
  scaleY: number
): Array<{ page: number; markup: CanvasMarkup }> {
  const now = new Date().toISOString();
  const markups: Array<{ page: number; markup: CanvasMarkup }> = [];
  
  const buildStyle = (placementStyle?: PlacementMarkup['style']): MarkupStyle => ({
    strokeColor: placementStyle?.strokeColor || defaultStyle.strokeColor,
    fillColor: placementStyle?.fillColor || defaultStyle.fillColor,
    strokeWidth: placementStyle?.strokeWidth || defaultStyle.strokeWidth,
    opacity: 100,
    fontSize: defaultStyle.fontSize,
    fontFamily: defaultStyle.fontFamily,
  });
  
  placements.markups.forEach((placement, index) => {
    const style = buildStyle(placement.style);
    const base = {
      id: placement.id || `ai_${Date.now()}_${index}`,
      type: placement.type,
      page: placement.page,
      style,
      locked: false,
      author: 'AI',
      createdAt: now,
      label: placement.label,
      aiGenerated: true,
      aiPending: placement.pending,
      aiNote: placement.aiNote,
      aiLinkedItemId: placement.linkedItemId,
    } as const;
    
    if (placement.type === 'count-marker') {
      const point = placement.points?.[0] || { x: 0, y: 0 };
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'count-marker',
          x: point.x * scaleX,
          y: point.y * scaleY,
          number: 1,
          groupId,
        },
      });
      return;
    }
    
    if (placement.type === 'measurement-length' || placement.type === 'measurement-area') {
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: placement.type,
          points: (placement.points || []).map((point) => ({
            x: point.x * scaleX,
            y: point.y * scaleY,
          })),
          value: 0,
          scaledValue: 0,
          unit: 'ft',
        },
      });
      return;
    }
    
    if (placement.type === 'polyline' || placement.type === 'polygon') {
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: placement.type,
          points: (placement.points || []).map((point) => ({
            x: point.x * scaleX,
            y: point.y * scaleY,
          })),
        },
      });
      return;
    }
    
    if (placement.type === 'text') {
      const point = placement.points?.[0] || { x: 0, y: 0 };
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'text',
          x: point.x * scaleX,
          y: point.y * scaleY,
          width: 200,
          height: 50,
          content: placement.label || placement.aiNote || 'AI Note',
        },
      });
      return;
    }
  });
  
  return markups;
}
