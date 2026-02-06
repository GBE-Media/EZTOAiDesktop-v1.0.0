/**
 * AI Chat Drawer Component
 * Floating slide-out panel for AI interaction
 */

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { X, Bot, Sparkles, AlertCircle, Loader2, FolderPlus, PackagePlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAIChatStore } from '@/store/aiChatStore';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import { useEditorStore } from '@/store/editorStore';
import { useProductSync } from '@/hooks/useProductSync';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AiToolbar } from './AiToolbar';
import { AiSettingsDialog } from './AiSettingsDialog';
import { getAIService } from '@/services/ai/aiService';
import { chat as aiChat, runPipeline } from '@/services/ai/pipeline';
import { renderPageForOcr } from '@/lib/pdfLoader';
import { cn } from '@/lib/utils';
import { capturePageCrop, createPageImageGenerator, getOptimalScale } from '@/services/ai/imageCapture';
import { fetchTrainingContext } from '@/services/ai/trainingService';
import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import type { BlueprintAnalysisResult, CanvasPlacement, PlacementMarkup } from '@/services/ai/providers/types';
import { useAuth } from '@/hooks/useAuth';

export function AiChatDrawer() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pageSelection, setPageSelection] = useState('current');
  const [productMapOpen, setProductMapOpen] = useState(false);
  const [productMapKeys, setProductMapKeys] = useState<string[]>([]);
  const [productMapValues, setProductMapValues] = useState<Record<string, string>>({});
  const [pendingCountMap, setPendingCountMap] = useState<Record<string, number>>({});
  const [placeMarkupsOpen, setPlaceMarkupsOpen] = useState(false);
  const [questionModalOpen, setQuestionModalOpen] = useState(false);
  const [questionOptions, setQuestionOptions] = useState<Array<{ id: string; prompt: string; options: string[]; allowMultiple?: boolean }>>([]);
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string[]>>({});
  const [questionFallback, setQuestionFallback] = useState('');
  const [pendingMarkups, setPendingMarkups] = useState<Array<{ page: number; markup: CanvasMarkup }>>([]);
  const [pendingDetectedKeys, setPendingDetectedKeys] = useState<string[]>([]);
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const [takeoffOpen, setTakeoffOpen] = useState(false);
  const [takeoffPrompt, setTakeoffPrompt] = useState('');
  const [takeoffScope, setTakeoffScope] = useState<'ask' | 'viewport' | 'full' | 'selection'>('ask');
  const [highAccuracy, setHighAccuracy] = useState(false);
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [takeoffError, setTakeoffError] = useState<string | null>(null);
  const [calibrationTypeInput, setCalibrationTypeInput] = useState('');
  const [createNodeType, setCreateNodeType] = useState<'product' | 'folder'>('product');
  const [createNodeName, setCreateNodeName] = useState('');
  const [createNodeParentId, setCreateNodeParentId] = useState<string | null>(null);
  
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

  const { user } = useAuth();
  
  // Settings store
  const { initialize: initSettings, isInitialized } = useAISettingsStore();
  
  // Canvas store for page context
  const { 
    activeDocId,
    pdfDocuments,
    currentPage,
    pageWidth,
    pageHeight,
    defaultStyle,
    addAIMarkupBatch,
    getAiSelectionForPage,
    getAiViewportForPage,
    setAiSelectionActive,
    setAiCalibrationActive,
    setAiCalibrationType,
    requestAiSymbolDetection,
    aiCalibrationActive,
    aiCalibrationType,
    aiCalibrationSamples,
  } = useCanvasStore();
  const { nodes, rootIds, addProduct, addFolder, linkMeasurement } = useProductStore();
  const { isLoading: productsLoading, error: productsError } = useProductSync();
  
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
  const handleSendMessage = useCallback(async (
    content: string,
    images?: string[],
    options?: { forcePipeline?: boolean; scope?: 'full' | 'viewport' | 'selection'; highAccuracy?: boolean; visibleOnly?: boolean }
  ) => {
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
      
      const shouldRunPipeline = options?.forcePipeline === true;
      const docData = activeDocId ? pdfDocuments[activeDocId] : null;
      
      if (shouldRunPipeline && docData?.pdfDocument && selectedPages.length > 0) {
        const optimalScale = getOptimalScale(docData.originalPageWidth, docData.originalPageHeight);
        const scope = options?.scope ?? 'full';
        const highAccuracyMode = options?.highAccuracy ?? false;
        const targetPage = currentPage || 1;
        const pagesToAnalyze = scope === 'full' ? selectedPages : [targetPage];
        const activeDoc = documents.find((docItem) => docItem.id === activeDocument);

        let trainingContext = '';
        if (user?.id) {
          try {
            trainingContext = await fetchTrainingContext({
              userId: user.id,
              trade: selectedTrade,
              projectName: activeDoc?.name,
            });
          } catch (error) {
            console.warn('[AI] Failed to load training context:', error);
          }
        }
        
        let imageGenerator = createPageImageGenerator(docData.pdfDocument, {
          scale: optimalScale,
          format: 'jpeg',
          quality: 0.9,
        });
        
        if (scope === 'viewport' || scope === 'selection') {
          const cropRect = scope === 'selection'
            ? (activeDocId ? getAiSelectionForPage(activeDocId, targetPage) : null)
            : (activeDocId ? getAiViewportForPage(activeDocId, targetPage) : null);
          
          if (!cropRect) {
            throw new Error(scope === 'selection'
              ? 'Select a region on the canvas before running takeoff.'
              : 'Unable to determine the visible viewport. Try zooming or fit-to-canvas and retry.'
            );
          }
          
          imageGenerator = async (page: number) => {
            const cropped = await capturePageCrop(docData.pdfDocument, page, cropRect, {
              scale: optimalScale,
              format: 'jpeg',
              quality: 0.9,
            });
            return cropped.base64;
          };
        }
        
        const pipelineResult = await runPipeline({
          trade: selectedTrade,
          pages: pagesToAnalyze,
          imageGenerator,
          pageWidth: docData.originalPageWidth || pageWidth,
          pageHeight: docData.originalPageHeight || pageHeight,
          userPrompt: content,
          trainingContext,
          pdfDoc: docData.pdfDocument,
          highAccuracyMode,
          visibleOnly: options?.visibleOnly ?? false,
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
        
        if (!pipelineResult.success) {
          throw new Error(pipelineResult.error || 'AI pipeline failed');
        }

        if ((pipelineResult.questions && pipelineResult.questions.length > 0) || (pipelineResult.questionOptions && pipelineResult.questionOptions.length > 0)) {
          const evidenceText = pipelineResult.evidence && pipelineResult.evidence.length > 0
            ? `\n\nEvidence:\n- ${pipelineResult.evidence.join('\n- ')}`
            : '';
          updateMessage(assistantMsgId, {
            content: `I need a bit more information before placing markups.${evidenceText}`,
            isLoading: false,
            metadata: { trade: selectedTrade },
          });
          setQuestionOptions(pipelineResult.questionOptions || []);
          setQuestionAnswers({});
          setQuestionFallback('');
          setQuestionModalOpen(true);
          return;
        }

        const analysisTypeCounts = extractTypeCounts(pipelineResult.analysis || []);
        const estimateCountMap = extractCountsFromEstimate(pipelineResult.estimate?.items || []);
        const countMap = Object.keys(analysisTypeCounts).length > 0 ? analysisTypeCounts : estimateCountMap;
        const estimateCount = pipelineResult.estimate?.items?.length || 0;
        const countSummary = formatCountMap(countMap);
        const responseText = [
          `Analyzed pages: ${pagesToAnalyze.join(', ')}`,
          `Detected items: ${estimateCount}`,
          countSummary ? `Type counts: ${countSummary}` : 'Type counts: none detected',
          'Markups are not placed. Map counts to products to apply totals.',
          trainingContext ? 'Applied verified training data.' : null,
        ].filter(Boolean).join('\n');
        
        setPendingCountMap(countMap);
        const countKeys = Object.keys(countMap);
        if (countKeys.length > 0) {
          setProductMapKeys(countKeys);
          setProductMapValues({});
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
    setPipelineStatus,
    getCurrentPageImage,
    messages,
    selectedTrade,
    currentPage,
    activeDocId,
    pdfDocuments,
    selectedPages,
    pageWidth,
    pageHeight,
    defaultStyle,
    getAiSelectionForPage,
    getAiViewportForPage,
    updateMessage,
    setPendingMarkups,
    setPendingDetectedKeys,
    setPendingAssistantId,
    setPlaceMarkupsOpen,
    documents,
    activeDocument,
    user,
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
  const activePageNumber = currentPage || 1;
  const selectionAvailable = !!(activeDocId && getAiSelectionForPage(activeDocId, activePageNumber));
  const viewportAvailable = !!(activeDocId && getAiViewportForPage(activeDocId, activePageNumber));
  const calibrationSampleCount = activeDocId && aiCalibrationType
    ? (aiCalibrationSamples[activeDocId]?.[activePageNumber]?.[aiCalibrationType]?.length || 0)
    : 0;
  const folderOptions = useMemo(() => buildFolderOptions(nodes, rootIds), [nodes, rootIds]);
  const productOptions = useMemo(
    () => Object.values(nodes).filter((node) => node.type === 'product'),
    [nodes]
  );
  const hasProducts = productOptions.length > 0;

  const openTakeoffDialog = useCallback(() => {
    setTakeoffError(null);
    setTakeoffOpen(true);
  }, []);

  const handleConfirmTakeoff = useCallback(() => {
    const prompt = takeoffPrompt.trim() || 'Run a takeoff for the selected area.';
    const resolvedScope = takeoffScope === 'ask' ? 'viewport' : takeoffScope;

    if (resolvedScope === 'selection' && !selectionAvailable) {
      setTakeoffError('Select a region on the canvas before running takeoff.');
      setAiSelectionActive(true);
      setTakeoffOpen(false);
      return;
    }

    if (resolvedScope === 'viewport' && !viewportAvailable) {
      setTakeoffError('Unable to determine the viewport. Try zooming or fit-to-canvas and retry.');
      return;
    }

    setTakeoffOpen(false);
    setTakeoffError(null);
    handleSendMessage(prompt, undefined, { forcePipeline: true, scope: resolvedScope, highAccuracy, visibleOnly });
  }, [handleSendMessage, selectionAvailable, setAiSelectionActive, takeoffPrompt, takeoffScope, viewportAvailable, highAccuracy, visibleOnly]);

  const handleCreateNode = useCallback(() => {
    const name = createNodeName.trim();
    if (!name) return;
    if (createNodeType === 'folder') {
      addFolder(createNodeParentId, name);
    } else {
      addProduct(createNodeParentId, name);
    }
    setCreateNodeName('');
  }, [addFolder, addProduct, createNodeName, createNodeParentId, createNodeType]);

  const applyPendingMarkups = useCallback(() => {
    if (!pendingMarkups.length) {
      setPlaceMarkupsOpen(false);
      return;
    }

    if (placementMode === 'confirm') {
      addAIMarkupBatch(pendingMarkups, true);
      setPendingPlacements(
        pendingMarkups.map(({ markup }) => ({
          id: markup.id,
          type: markup.type,
          page: markup.page,
          data: markup,
        }))
      );
    } else {
      addAIMarkupBatch(pendingMarkups, false);
    }

    if (pendingDetectedKeys.length > 0) {
      setProductMapKeys(pendingDetectedKeys);
      setProductMapValues({});
      setProductMapOpen(true);
    }

    if (pendingAssistantId) {
      updateMessage(pendingAssistantId, {
        content: `${pendingMarkups.length} markups placed on the canvas.`,
      });
    }

    setPendingMarkups([]);
    setPendingDetectedKeys([]);
    setPendingAssistantId(null);
    setPlaceMarkupsOpen(false);
  }, [
    addAIMarkupBatch,
    pendingAssistantId,
    pendingDetectedKeys,
    pendingMarkups,
    placementMode,
    setPendingPlacements,
    updateMessage,
  ]);

  const handleQuestionToggle = useCallback((questionId: string, option: string, allowMultiple?: boolean) => {
    setQuestionAnswers((prev) => {
      const current = prev[questionId] || [];
      if (allowMultiple) {
        return {
          ...prev,
          [questionId]: current.includes(option)
            ? current.filter((value) => value !== option)
            : [...current, option],
        };
      }
      return { ...prev, [questionId]: [option] };
    });
  }, []);

  const submitQuestionAnswers = useCallback(() => {
    const answersText = questionOptions.map((question) => {
      const answers = questionAnswers[question.id] || [];
      return `${question.prompt}\nSelected: ${answers.length ? answers.join(', ') : 'No selection'}`;
    }).join('\n\n');

    const extraContext = questionFallback.trim()
      ? `Additional notes: ${questionFallback.trim()}`
      : '';

    const answerBlock = `User answers to clarification questions:\n${answersText}${extraContext ? `\n\n${extraContext}` : ''}`;
    setQuestionModalOpen(false);
    setQuestionOptions([]);
    setQuestionAnswers({});
    setQuestionFallback('');

    handleSendMessage(answerBlock, undefined, { forcePipeline: true, scope: 'full', highAccuracy });
  }, [handleSendMessage, highAccuracy, questionAnswers, questionFallback, questionOptions]);

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
            onRunTakeoff={openTakeoffDialog}
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

      <Dialog open={takeoffOpen} onOpenChange={setTakeoffOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>AI Takeoff</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>What should the AI do?</Label>
              <Textarea
                value={takeoffPrompt}
                onChange={(event) => setTakeoffPrompt(event.target.value)}
                placeholder="Example: Count all doors and windows in this area."
                className="min-h-[80px]"
              />
            </div>
            <div className="space-y-2">
              <Label>Scope</Label>
              <Select value={takeoffScope} onValueChange={(value) => setTakeoffScope(value as typeof takeoffScope)}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose scope" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">Ask each time</SelectItem>
                  <SelectItem value="viewport">Visible viewport</SelectItem>
                  <SelectItem value="full">Full page</SelectItem>
                  <SelectItem value="selection">Selected region</SelectItem>
                </SelectContent>
              </Select>
              {takeoffScope === 'selection' && (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{selectionAvailable ? 'Selection ready' : 'No selection yet'}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAiSelectionActive(true);
                      setTakeoffOpen(false);
                    }}
                  >
                    Select region
                  </Button>
                </div>
              )}
              {takeoffScope === 'viewport' && (
                <div className="text-xs text-muted-foreground">
                  {viewportAvailable ? 'Viewport will be used' : 'Viewport not ready yet'}
                </div>
              )}
            </div>
            <div className="space-y-2 rounded-md border border-border px-3 py-2">
              <Label>Symbol calibration (optional)</Label>
              <div className="flex items-center gap-2">
                <Input
                  value={calibrationTypeInput}
                  onChange={(event) => setCalibrationTypeInput(event.target.value)}
                  placeholder="Fixture type (e.g., Type A)"
                />
                <Button
                  type="button"
                  variant={aiCalibrationActive ? 'secondary' : 'outline'}
                  onClick={() => {
                    const type = calibrationTypeInput.trim();
                    if (!type) return;
                    setAiCalibrationType(type);
                    setAiCalibrationActive(!aiCalibrationActive);
                  }}
                >
                  {aiCalibrationActive ? 'Stop' : 'Start'}
                </Button>
              </div>
              {aiCalibrationType && (
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{aiCalibrationActive ? 'Click 3-5 examples on the page' : 'Calibration paused'}</span>
                  <span>{calibrationSampleCount} samples</span>
                </div>
              )}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Detect matching symbols and preview on canvas.</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => requestAiSymbolDetection()}
                  disabled={!aiCalibrationType || calibrationSampleCount < 3}
                >
                  Detect symbols
                </Button>
              </div>
              {aiCalibrationType && calibrationSampleCount > 0 && calibrationSampleCount < 3 && (
                <div className="text-xs text-muted-foreground">
                  Add at least 3 samples before detecting symbols.
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">High Accuracy (slow)</p>
                <p className="text-xs text-muted-foreground">Runs multi-pass analysis for better counts.</p>
              </div>
              <input
                type="checkbox"
                checked={highAccuracy}
                onChange={(event) => setHighAccuracy(event.target.checked)}
                className="h-4 w-4"
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
              <div>
                <p className="text-sm font-medium">Visible-only</p>
                <p className="text-xs text-muted-foreground">Ignore schedule/legend totals. Count only symbols on the plan.</p>
              </div>
              <input
                type="checkbox"
                checked={visibleOnly}
                onChange={(event) => setVisibleOnly(event.target.checked)}
                className="h-4 w-4"
              />
            </div>
            {takeoffError && (
              <div className="text-xs text-destructive">{takeoffError}</div>
            )}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setTakeoffOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirmTakeoff} disabled={!isAIAvailable || isLoading}>
              Run Takeoff
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={placeMarkupsOpen} onOpenChange={setPlaceMarkupsOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Place markups?</DialogTitle>
            <DialogDescription>
              The AI prepared markups from this takeoff. Would you like to place them on the canvas?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => {
                if (pendingAssistantId) {
                  updateMessage(pendingAssistantId, { content: 'Markups not placed.' });
                }
                setPendingMarkups([]);
                setPendingDetectedKeys([]);
                setPendingAssistantId(null);
                setPlaceMarkupsOpen(false);
              }}
            >
              No
            </Button>
            <Button onClick={applyPendingMarkups}>Yes, place</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={questionModalOpen} onOpenChange={setQuestionModalOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Clarify before takeoff</DialogTitle>
            <DialogDescription>
              Select the options that best match the plan so the AI can continue accurately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {questionOptions.length === 0 ? (
              <div className="space-y-2">
                <Label>Additional context</Label>
                <Textarea
                  value={questionFallback}
                  onChange={(event) => setQuestionFallback(event.target.value)}
                  placeholder="Provide any clarification for the AI."
                  className="min-h-[120px]"
                />
              </div>
            ) : (
              questionOptions.map((question) => (
                <div key={question.id} className="space-y-2">
                  <Label>{question.prompt}</Label>
                  <div className="space-y-1">
                    {question.options.map((option) => {
                      const selected = (questionAnswers[question.id] || []).includes(option);
                      return (
                        <label key={option} className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => handleQuestionToggle(question.id, option, question.allowMultiple)}
                          />
                          <span>{option}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setQuestionModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitQuestionAnswers}>Continue</Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={productMapOpen} onOpenChange={setProductMapOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Map AI Types to Products</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 max-h-[65vh]">
            <div className="text-xs text-muted-foreground">
              Counts are derived from the placed markups so they match what you see on the canvas.
            </div>
            {productsLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Loading products...
              </div>
            )}
            {productsError && (
              <div className="text-xs text-destructive">
                Failed to load products: {productsError}
              </div>
            )}
            {!productsLoading && !productsError && !hasProducts && (
              <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
                No products found. Create one below to map AI counts.
              </div>
            )}
            <div className="rounded-md border border-border p-3 space-y-2">
              <div className="flex items-center gap-2 text-xs font-medium">
                {createNodeType === 'product' ? <PackagePlus className="w-4 h-4" /> : <FolderPlus className="w-4 h-4" />}
                Create {createNodeType === 'product' ? 'Product' : 'Folder'}
              </div>
              <div className="grid grid-cols-1 gap-2">
                <Select
                  value={createNodeType}
                  onValueChange={(value) => setCreateNodeType(value as 'product' | 'folder')}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="product">Product</SelectItem>
                    <SelectItem value="folder">Folder</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={createNodeParentId || 'root'}
                  onValueChange={(value) => setCreateNodeParentId(value === 'root' ? null : value)}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Choose parent folder" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="root">Top level</SelectItem>
                    {folderOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={createNodeName}
                  onChange={(event) => setCreateNodeName(event.target.value)}
                  placeholder={createNodeType === 'product' ? 'Product name' : 'Folder name'}
                  className="h-8 text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={handleCreateNode}
                  disabled={!createNodeName.trim()}
                >
                  Create
                </Button>
              </div>
            </div>
            <ScrollArea className="flex-1 min-h-0 pr-2">
              <div className="space-y-3">
                {(productMapKeys.length ? productMapKeys : Object.keys(pendingCountMap)).map((key) => (
                  <div key={key} className="space-y-1">
                    <Label className="text-xs">
                      {pendingCountMap[key] ? `${key} (${pendingCountMap[key]})` : key}
                    </Label>
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
                        {productOptions.map((node) => (
                          <SelectItem key={node.id} value={node.id}>
                            {node.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </ScrollArea>
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
                applyProductCountMappings({
                  activeDocId,
                  mappings: productMapValues,
                  counts: pendingCountMap,
                  page: activePageNumber,
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

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, value]) => value > 0);
  if (entries.length === 0) return '';
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
}

function extractCountsFromEstimate(items: Array<{ name: string; quantity: number }>): Record<string, number> {
  const counts: Record<string, number> = {};
  items.forEach((item) => {
    const key = normalizeSymbolKey(item.name || '');
    if (!key) return;
    counts[key] = (counts[key] || 0) + (item.quantity || 0);
  });
  return counts;
}

function normalizeSymbolKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toUpperCase();
}

function findMatchingSymbolKey(label: string, symbolMap: Record<string, { x: number; y: number }[]>): string | null {
  const normalizedLabel = normalizeSymbolKey(label);
  if (!normalizedLabel) return null;

  let bestMatch: string | null = null;
  let bestLength = 0;
  for (const key of Object.keys(symbolMap)) {
    const normalizedKey = normalizeSymbolKey(key);
    if (normalizedLabel.includes(normalizedKey) || normalizedKey.includes(normalizedLabel)) {
      if (normalizedKey.length > bestLength) {
        bestMatch = key;
        bestLength = normalizedKey.length;
      }
    }
  }
  return bestMatch;
}

function buildFolderOptions(nodes: Record<string, { id: string; name: string; type: string; children: string[] }>, rootIds: string[]) {
  const options: Array<{ id: string; label: string }> = [];
  const walk = (nodeId: string, prefix: string) => {
    const node = nodes[nodeId];
    if (!node) return;
    const label = prefix ? `${prefix} / ${node.name}` : node.name;
    if (node.type === 'folder') {
      options.push({ id: node.id, label });
      node.children.forEach((childId) => walk(childId, label));
    }
  };
  rootIds.forEach((id) => walk(id, ''));
  return options;
}

function applyProductCountMappings(options: {
  activeDocId: string | null;
  mappings: Record<string, string>;
  counts: Record<string, number>;
  page: number;
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
  const { activeDocId, mappings, counts, page, linkMeasurement } = options;
  if (!activeDocId) return;
  const groupId = `ai-count-${Date.now()}`;
  Object.entries(counts).forEach(([key, value]) => {
    const productId = mappings[key];
    if (!productId || value <= 0) return;
    linkMeasurement(productId, {
      markupId: `${groupId}-${key}`,
      documentId: activeDocId,
      page,
      type: 'count',
      value,
      unit: 'ea',
      groupId,
      groupLabel: key,
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
