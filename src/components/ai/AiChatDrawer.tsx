/**
 * BidveraAi Agent Assistant Panel
 * Docked agent (tool loop, approvals, verification) — replaces the old one-shot chat drawer.
 */

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { Sparkles, AlertCircle, Loader2, FolderPlus, PackagePlus, Boxes } from 'lucide-react';
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
import { useAIChatStore } from '@/store/aiChatStore';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import {
  commitMarkupsByConfidence,
  normalizeAgentMarkupPayload,
  resolvePageAnchors,
  usePlacementDebugStore,
  verifyPlacementMarkupsWithGeometryGate,
} from '@/services/ai/placement';
import {
  executePlaceMarkupsApproval,
  newDirectPlaceMarkupsApprovalId,
} from '@/services/ai/placement/executePlaceMarkupsApproval';
import { handleApprovalDecision } from '@/services/ai/placement/handleApprovalDecision';
import { useEditorStore } from '@/store/editorStore';
import { useProductSync } from '@/hooks/useProductSync';
import { ChatMessage } from './ChatMessage';
import { AiToolbar } from './AiToolbar';
import { AiSettingsDialog } from './AiSettingsDialog';
import { ProductMatchPanel } from './ProductMatchPanel';
import { getAIService } from '@/services/ai/aiService';
import type { PipelineResult } from '@/services/ai/pipeline';
import { summarizeCatalogForChat, summarizeMarkupsForChat } from '@/services/ai/contextSummary';
import { cn } from '@/lib/utils';
import { capturePageCrop, createPageImageGenerator, getOptimalScale } from '@/services/ai/imageCapture';
import { ensureNumberedCalloutMentions } from '@/services/ai/callouts';
import { fetchTrainingContext } from '@/services/ai/trainingService';
import type { CanvasMarkup } from '@/types/markup';
import type { BlueprintAnalysisResult } from '@/services/ai/providers/types';
import { useAuth } from '@/hooks/useAuth';
import { useCatalogSync } from '@/components/catalog/CatalogSyncProvider';
import {
  registerAssistantRunController,
  releaseAssistantRunController,
} from '@/services/ai/assistantOrchestrator';
import type { EvidenceCitation } from '@/types/assistant';
import {
  proposeAssistantMutation,
} from '@/services/ai/tools/registry';
import {
  buildAgentContext,
  cancelTask,
  createAgentToolContext,
  labelForAgentStatus,
  registerAllAgentTools,
  resumeTaskAfterClarification,
  startAgentTask,
  startPipelineTask,
  shouldAttachDocumentEvidence,
  summarizeCachedPageAnalyses,
} from '@/services/ai/agent';
import { sanitizeAssistantVisibleText } from '@/services/ai/agent/assistantVisibleText';
import type { ClarificationAnswerDetail } from './QuestionCard';
import { AssistantHeader } from './AssistantHeader';
import { AssistantComposer } from './AssistantComposer';
import { startProjectIndexer } from '@/services/ai/projectIndex/scheduler';
import { allIndexedPages } from '@/services/ai/projectIndex/store';
import { compactProjectDocuments, formatProjectDocumentsSummary } from '@/services/ai/projectIndex/summaries';
import { detectFollowUpOffer } from '@/lib/followUpOffer';
import { inferTrade } from '@/services/ai/inferTrade';
import { startAiPreviewSync } from '@/services/ai/placement/aiPreviewSync';
import { resolveDocumentRef } from '@/services/ai/documentRef';

/** @deprecated Prefer AgentAssistantDrawer — same implementation. */
export function AiChatDrawer() {
  return <AgentAssistantDrawer />;
}

/** Primary docked agent panel used by the editor. */
export function AgentAssistantDrawer() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [productMapOpen, setProductMapOpen] = useState(false);
  const [productMapKeys, setProductMapKeys] = useState<string[]>([]);
  const [productMapValues, setProductMapValues] = useState<Record<string, string>>({});
  const [pendingCountMap, setPendingCountMap] = useState<Record<string, number>>({});
  const [pendingDetectedKeys, setPendingDetectedKeys] = useState<string[]>([]);
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const [calibrationTypeInput, setCalibrationTypeInput] = useState('');
  const [createNodeType, setCreateNodeType] = useState<'product' | 'folder' | 'assembly'>('product');
  const [createNodeName, setCreateNodeName] = useState('');
  const [createNodeParentId, setCreateNodeParentId] = useState<string | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  
  // Chat store
  const {
    closeDrawer,
    messages,
    isLoading,
    addMessage,
    updateMessage,
    clearMessages,
    selectedTrade,
    lastInferredTrade,
    recordInferredTrade,
    placementMode,
    pipelineStatus,
    setPipelineStatus,
    setPendingPlacements,
    setConversationContext,
    runs,
    conversation,
    conversationList,
    createConversation,
    selectConversation,
  } = useAIChatStore();

  const { user } = useAuth();
  const { queueMutation } = useCatalogSync();
  
  // Settings store
  const { initialize: initSettings, isInitialized } = useAISettingsStore();
  
  // Canvas store for page context
  const { 
    activeDocId,
    pdfDocuments,
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
    getMarkupsByPage,
    getCurrentPage,
    getTextContent,
    setTextContent,
  } = useCanvasStore();
  // `currentPage` is not a top-level store field (it lives per-document at
  // pdfDocuments[docId].currentPage) - always derive it via getCurrentPage()
  // so chat context, markup summaries, and pointer placement target the page
  // actually shown on the canvas instead of silently defaulting to page 1.
  const currentPage = getCurrentPage();
  const { nodes, rootIds, activeProductId, linkMeasurement } = useProductStore();
  const { isLoading: productsLoading, error: productsError } = useProductSync();
  
  // Editor store for document info
  const { documents, activeDocument } = useEditorStore();
  const activeDocumentRecord = documents.find(document => document.id === activeDocument);

  useEffect(() => {
    registerAllAgentTools();
  }, []);

  useEffect(() => {
    const contextId = activeDocId || (user?.id ? `user:${user.id}:general` : 'local:general');
    void setConversationContext(contextId, activeDocumentRecord?.name || 'General assistant');
  }, [activeDocId, activeDocumentRecord?.name, setConversationContext, user?.id]);
  
  // Initialize settings on mount
  useEffect(() => {
    if (!isInitialized) {
      initSettings();
    }
  }, [isInitialized, initSettings]);

  useEffect(() => {
    startProjectIndexer();
  }, []);
  
  // Initialize AI service with proxy mode (company API keys via Edge Function)
  useEffect(() => {
    if (isInitialized) {
      // Use proxy by default - no local API keys needed
      getAIService().initialize({ useProxy: true });
    }
  }, [isInitialized]);
  
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) {
      setShowJumpToLatest(true);
      return;
    }
    scrollToBottom();
  }, [messages, isLoading, pipelineStatus.message, scrollToBottom]);
  
  const totalPages = activeDocId ? pdfDocuments[activeDocId]?.totalPages || 0 : 0;
  const selectedPages = useMemo(
    () => (currentPage ? [currentPage] : []),
    [currentPage]
  );

  const queueMarkupApproval = useCallback((options: {
    assistantMsgId: string;
    runId: string;
    markups: Array<{ page: number; markup: CanvasMarkup }>;
    description: string;
  }) => {
    // The live canvas preview is driven by startAiPreviewSync once the approval exists.
    setPendingDetectedKeys([]);
    setPendingAssistantId(options.assistantMsgId);
    const approval = proposeAssistantMutation('place_markups', {
      payload: options.markups,
      description: options.description,
      preview: { count: options.markups.length, pages: [...new Set(options.markups.map(item => item.page))] },
    }, {
      runId: options.runId,
      messageId: options.assistantMsgId,
    });
    const store = useAIChatStore.getState();
    store.addApproval(approval);
    store.addMessageBlock(options.assistantMsgId, {
      id: `block_${approval.id}`,
      type: 'approval',
      approvalId: approval.id,
    });
    const run = store.runs[options.runId];
    if (run) {
      store.finishRun(options.runId, 'waiting-approval');
    }
  }, []);

  const createEditorToolContext = useCallback((
    runId: string,
    messageId: string,
    signal?: AbortSignal,
  ) => createAgentToolContext({
    runId,
    messageId,
    signal,
    trade: useAIChatStore.getState().lastInferredTrade || useAIChatStore.getState().selectedTrade,
    placeMarkups: async (payload) => {
      const canvas = useCanvasStore.getState();
      const docId = canvas.activeDocId;
      const pdf = docId ? canvas.pdfDocuments[docId] : null;
      return executePlaceMarkupsApproval({
        approval: {
          id: newDirectPlaceMarkupsApprovalId(messageId),
          runId,
          messageId,
          toolId: 'place_markups',
          title: 'Place document markups',
          description: 'Place proposed markups on the document',
          status: 'approved',
          payload,
          undoable: true,
          createdAt: new Date().toISOString(),
        },
        page: canvas.getCurrentPage() || 1,
        pageWidth: pdf?.originalPageWidth || pageWidth,
        pageHeight: pdf?.originalPageHeight || pageHeight,
        defaultStyle,
        pdfDocument: pdf?.pdfDocument || null,
        placementMode,
        addAIMarkupBatch,
        setPendingPlacements,
        getPendingPlacements: () => useAIChatStore.getState().pendingPlacements,
      });
    },
    navigateToPage: (page, bounds, documentId) => {
      const canvas = useCanvasStore.getState();
      const editor = useEditorStore.getState();
      const target = documentId || canvas.activeDocId;
      if (target && target !== canvas.activeDocId) {
        editor.setActiveDocument(target);
        canvas.setActiveDocId(target);
      }
      canvas.setCurrentPage(page);
      if (bounds && target) {
        canvas.setAiSelectionRect(target, page, bounds);
        canvas.setAiSelectionActive(true);
      }
    },
  }), [
    addAIMarkupBatch,
    defaultStyle,
    pageHeight,
    pageWidth,
    placementMode,
    setPendingPlacements,
  ]);

  const applyCompletedPipelineResult = useCallback((options: {
    result: PipelineResult;
    runId: string;
    assistantMsgId: string;
    pages: number[];
    trainingApplied?: boolean;
  }) => {
    const canvas = useCanvasStore.getState();
    const docId = canvas.activeDocId;
    const docData = docId ? canvas.pdfDocuments[docId] : null;
    const analysisTypeCounts = extractTypeCounts(options.result.analysis || []);
    const estimateCountMap = extractCountsFromEstimate(options.result.estimate?.items || []);
    const countMap = Object.keys(analysisTypeCounts).length > 0 ? analysisTypeCounts : estimateCountMap;
    const estimateCount = options.result.estimate?.items?.length || 0;
    const countSummary = formatCountMap(countMap);
    const store = useAIChatStore.getState();
    store.upsertRunStep(options.runId, {
      id: 'step_evidence',
      label: 'Verify document evidence',
      summary: countSummary
        ? `Reconciled detections: ${countSummary}`
        : `Reviewed ${options.pages.length} page${options.pages.length === 1 ? '' : 's'}; no countable symbols verified.`,
      stage: 'tool',
      status: 'completed',
      progress: 100,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      citations: options.pages.map(page => ({
        id: `run_citation_${options.runId}_${page}`,
        documentId: docId || undefined,
        documentName: activeDocumentRecord?.name,
        page,
        label: `${activeDocumentRecord?.name || 'Document'}, page ${page}`,
      })),
    });
    const responseText = [
      `Analyzed pages: ${options.pages.join(', ')}`,
      `Detected items: ${estimateCount}`,
      countSummary ? `Type counts: ${countSummary}` : 'Type counts: none detected',
      'Markups are not placed. Map counts to products to apply totals.',
      options.trainingApplied ? 'Applied verified training data.' : null,
    ].filter(Boolean).join('\n');

    setPendingCountMap(countMap);
    const countKeys = Object.keys(countMap);
    if (countKeys.length > 0) {
      setProductMapKeys(countKeys);
      setProductMapValues({});
      setProductMapOpen(true);
    }
    store.updateMessage(options.assistantMsgId, {
      content: responseText,
      isLoading: false,
      metadata: { trade: store.selectedTrade },
    });
    if (shouldAttachDocumentEvidence({
      evidenceSnippets: options.result.evidence,
    })) {
      addDocumentEvidenceBlock(
        options.assistantMsgId,
        activeDocumentRecord?.name,
        options.pages,
        options.result.evidence,
      );
    }

    if (options.result.placements?.markups.length) {
      const placementMarkups = options.result.placements.markups;
      void (async () => {
        const {
          verified,
          reviewOnly,
          geometryByPage,
          verifiedResults,
        } = await verifyPlacementMarkupsWithGeometryGate({
          markups: placementMarkups,
          pdfDocument: docData?.pdfDocument || null,
          defaultStyle,
          idPrefix: `takeoff_${options.assistantMsgId}`,
          resolveAnchors: (page, pageNumber) => resolvePageAnchors({ page, pageNumber }),
        });

        if (reviewOnly.length > 0) {
          const existing = useAIChatStore.getState().pendingPlacements;
          const byId = new Map(existing.map(row => [row.id, row]));
          for (const { page, markup } of reviewOnly) {
            byId.set(markup.id, {
              id: markup.id,
              type: markup.type,
              page: markup.page || page,
              data: markup,
            });
          }
          setPendingPlacements([...byId.values()]);
        }

        const debugPageNumber = canvas.getCurrentPage()
          || Array.from(geometryByPage.keys())[0]
          || 1;
        const debugPage = geometryByPage.get(debugPageNumber);
        if (debugPage) {
          usePlacementDebugStore.getState().setDebugScene({
            page: debugPage,
            proposals: verifiedResults
              .map(item => item.proposal)
              .filter(proposal => proposal.pageNumber === debugPage.pageNumber),
            anchors: resolvePageAnchors({ page: debugPage, pageNumber: debugPage.pageNumber }),
          });
        }

        if (verified.length > 0) {
          queueMarkupApproval({
            assistantMsgId: options.assistantMsgId,
            runId: options.runId,
            markups: verified,
            description: `Place ${verified.length} verified green callout${verified.length === 1 ? '' : 's'} from this takeoff.`,
          });
        } else {
          useAIChatStore.getState().finishRun(options.runId, 'completed');
        }
      })();
    } else {
      store.finishRun(options.runId, 'completed');
    }
  }, [
    activeDocumentRecord?.name,
    defaultStyle,
    pageHeight,
    pageWidth,
    queueMarkupApproval,
    setPendingPlacements,
  ]);
  
  // Handle sending a message
  const handleSendMessage = useCallback(async (
    content: string,
    images?: string[],
    options?: { forcePipeline?: boolean; scope?: 'full' | 'viewport' | 'selection'; highAccuracy?: boolean; visibleOnly?: boolean }
  ) => {
    const indexed = allIndexedPages().find(page => page.docId === (useCanvasStore.getState().activeDocId || ''))
      || allIndexedPages()[0];
    const trade = inferTrade({
      message: content,
      sheetDiscipline: indexed?.discipline,
      documentName: activeDocumentRecord?.name || indexed?.documentName,
      conversationTrade: lastInferredTrade || selectedTrade,
    });
    recordInferredTrade(trade);
    useCanvasStore.getState().clearAiPreview();
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
    const runId = useAIChatStore.getState().createRun(assistantMsgId, content || 'Analyze attached document');
    const runSignal = registerAssistantRunController(runId);
    let failed = false;
    
    try {
      setPipelineStatus({ isRunning: true, message: 'Processing...' });
      
      // User attachments remain supported; PDF pages are captured by the
      // shared maximum-accuracy pipeline below instead of this component.
      let imageBase64: string | undefined;
      
      if (images?.length) {
        imageBase64 = images[0];
        console.log('[AI] Using user-attached image');
      } else if (!activeDocId) {
        console.log('[AI] No document open, sending text-only message');
      }
      
      // Build previous messages for context (last 10)
      const previousMessages = useAIChatStore.getState().messages
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
        let analysisRegion: { x: number; y: number; width: number; height: number } | undefined;
        
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
          analysisRegion = cropRect;
          
          imageGenerator = async (page: number) => {
            const cropped = await capturePageCrop(docData.pdfDocument, page, cropRect, {
              scale: optimalScale,
              format: 'jpeg',
              quality: 0.9,
            });
            return cropped.base64;
          };
        }
        
        const orchestrated = await startPipelineTask({
          runId,
          messageId: assistantMsgId,
          userMessage: content,
          documentId: activeDocId || undefined,
          pipeline: {
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
            analysisRegion,
            refinePlacements: true,
            getCachedText: getTextContent,
            setCachedText: setTextContent,
            onProgress: (progress) => {
              if (runSignal.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');
              setPipelineStatus({
                isRunning: true,
                currentStage: progress.stage,
                progress: progress.progress,
                message: progress.message,
              });
              useAIChatStore.getState().upsertRunStep(runId, {
                id: `step_${progress.stage}`,
                label: progress.message,
                stage: progress.stage === 'error' ? 'tool' : progress.stage,
                status: progress.stage === 'error' ? 'error' : progress.progress >= 100 ? 'completed' : 'running',
                progress: progress.progress,
                startedAt: new Date().toISOString(),
                completedAt: progress.progress >= 100 ? new Date().toISOString() : undefined,
              });
            },
          },
        });
        const pipelineResult = orchestrated.pipelineResult;
        if (!pipelineResult) throw new Error('Takeoff pipeline returned no result.');
        if (runSignal.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');
        
        if (!pipelineResult.success) {
          throw new Error(pipelineResult.error || 'AI pipeline failed');
        }

        if (orchestrated.status === 'needs_clarification') {
          const evidenceText = pipelineResult.evidence && pipelineResult.evidence.length > 0
            ? `\n\nEvidence:\n- ${pipelineResult.evidence.join('\n- ')}`
            : '';
          updateMessage(assistantMsgId, {
            content: `I need a bit more information before placing markups.${evidenceText}`,
            isLoading: false,
            metadata: { trade: selectedTrade },
          });
          return;
        }

        applyCompletedPipelineResult({
          result: pipelineResult,
          runId,
          assistantMsgId,
          pages: pagesToAnalyze,
          trainingApplied: Boolean(trainingContext),
        });
        return;
      }
      
      // Agent chat path (tool loop). Forced takeoff pipeline stays above.
      const markupsSummary = activeDocId
        ? summarizeMarkupsForChat(getMarkupsByPage(activeDocId), currentPage || 1)
        : undefined;
      const catalogSummary = summarizeCatalogForChat(nodes, rootIds, activeProductId);
      const materialCounts = useProductStore.getState().exportProducts(activeDocumentRecord?.name || 'project');
      const materialCountsSummary = materialCounts.products.length
        ? materialCounts.products
          .slice(0, 30)
          .map(p => `- ${p.name}: count=${p.measurements.totalCount}, length=${p.measurements.totalLength}, area=${p.measurements.totalArea}`)
          .join('\n')
        : undefined;

      let agentImage = imageBase64;
      if (!agentImage && docData?.pdfDocument) {
        try {
          const optimalScale = getOptimalScale(docData.originalPageWidth, docData.originalPageHeight);
          const imageGenerator = createPageImageGenerator(docData.pdfDocument, {
            scale: Math.min(optimalScale, 1.5),
            format: 'jpeg',
            quality: 0.85,
          });
          agentImage = await imageGenerator(currentPage || 1);
          setPipelineStatus({
            isRunning: true,
            currentStage: 'vision',
            progress: 35,
            message: 'Captured page for agent context…',
          });
        } catch (captureError) {
          console.warn('[AI Agent] Page capture failed; continuing text-only', captureError);
        }
      }

      const indexedPages = allIndexedPages();
      const editorDocs = useEditorStore.getState().documents;
      const canvasDocs = useCanvasStore.getState().pdfDocuments;
      const compactDocs = compactProjectDocuments(
        editorDocs.map(doc => ({ id: doc.id, name: doc.name, pages: canvasDocs[doc.id]?.totalPages || 0 })),
        indexedPages,
      );
      const totalOpenPages = compactDocs.reduce((sum, doc) => sum + doc.pages, 0);
      const { text: contextText } = buildAgentContext({
        userIntent: content,
        trade: selectedTrade,
        currentPage: currentPage || undefined,
        documentName: activeDocumentRecord?.name,
        documentId: activeDocId,
        totalPages: docData?.totalPages,
        screen: 'editor',
        recentTurns: previousMessages,
        markupsSummary,
        catalogSummary,
        materialCountsSummary,
        takeoffSummary: markupsSummary,
        pageAnalysisSummary: summarizeCachedPageAnalyses(
          activeDocId,
          activeDocId ? useCanvasStore.getState().pdfDocuments[activeDocId]?.contentRevision : undefined,
        ),
        projectDocumentsSummary: formatProjectDocumentsSummary(
          compactDocs,
          indexedPages.length,
          totalOpenPages,
        ),
      });

      const toolContext = createEditorToolContext(runId, assistantMsgId, runSignal);

      const orchestrated = await startAgentTask({
        messageId: assistantMsgId,
        runId,
        userMessage: content,
        toolContext,
        contextText,
        imageBase64: agentImage,
        trade: selectedTrade,
        currentPage: currentPage || undefined,
        documentName: activeDocumentRecord?.name,
        documentId: activeDocId,
        totalPages: docData?.totalPages,
        recentTurns: previousMessages,
        markupsSummary,
        catalogSummary,
        materialCountsSummary,
        takeoffSummary: markupsSummary,
        pageAnalysisSummary: summarizeCachedPageAnalyses(
          activeDocId,
          activeDocId ? useCanvasStore.getState().pdfDocuments[activeDocId]?.contentRevision : undefined,
        ),
        onStatus: (status, detail) => {
          if (runSignal.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');
          const busy = status === 'thinking'
            || status === 'running_tool'
            || status === 'running_tools'
            || status === 'routing'
            || status === 'verifying';
          setPipelineStatus({
            isRunning: busy,
            currentStage: status === 'verifying' || status === 'running_tool' || status === 'running_tools'
              ? 'placement'
              : status === 'routing'
                ? 'estimation'
                : 'vision',
            progress: status === 'needs_approval'
              || status === 'needs_clarification'
              || status === 'completed'
              ? 100
              : 55,
            message: labelForAgentStatus(status, detail),
          });
        },
      });
      const agentResult = orchestrated.agentResult;
      if (!agentResult) throw new Error('Agent task returned no result.');
      if (runSignal.aborted) throw new DOMException('Assistant run cancelled', 'AbortError');

      const answerText = ensureNumberedCalloutMentions(
        sanitizeAssistantVisibleText(agentResult.assistantMessage),
        [],
      );
      updateMessage(assistantMsgId, {
        content: answerText,
        isLoading: agentResult.status === 'needs_approval',
        metadata: {
          trade: selectedTrade,
          tokenUsage: undefined,
        },
      });

      if (activeDocId && shouldAttachDocumentEvidence({
        toolHistory: agentResult.toolHistory,
      })) {
        addDocumentEvidenceBlock(assistantMsgId, activeDocumentRecord?.name, [currentPage || 1]);
      }

      if (agentResult.status === 'needs_clarification') {
        return;
      }

      if (agentResult.status === 'completed' && !runSignal.aborted) {
        const offer = detectFollowUpOffer(answerText);
        if (offer) {
          useAIChatStore.getState().addMessageBlock(assistantMsgId, {
            id: `block_followup_${assistantMsgId}`,
            type: 'follow-up',
            messageId: assistantMsgId,
            question: offer.question,
            options: offer.options,
          });
        }
      }

      if (agentResult.status === 'needs_approval' && agentResult.approvalRequest) {
        // Canvas preview is handled by startAiPreviewSync (covers resumed approvals too).
        const approval = agentResult.approvalRequest;
        if (approval.toolId === 'place_markups' || approval.toolId === 'propose_callouts') {
          setPendingAssistantId(assistantMsgId);
        }
        return;
      }

      if (agentResult.status === 'failed') {
        failed = true;
        updateMessage(assistantMsgId, {
          content: '',
          isLoading: false,
          error: agentResult.assistantMessage,
        });
      }
    } catch (error) {
      failed = true;
      const errorMessage = error instanceof Error ? error.message : 'An error occurred';
      updateMessage(assistantMsgId, {
        content: runSignal.aborted ? 'Stopped.' : '',
        isLoading: false,
        error: runSignal.aborted ? undefined : errorMessage,
      });
      useAIChatStore.getState().finishRun(
        runId,
        runSignal.aborted ? 'cancelled' : 'error',
        runSignal.aborted ? undefined : errorMessage
      );
    } finally {
      const runStatus = useAIChatStore.getState().runs[runId]?.status;
      if (!failed && runStatus === 'running') {
        useAIChatStore.getState().finishRun(runId, 'completed');
      }
      setPipelineStatus({ isRunning: false, progress: 0, message: '' });
      if (runStatus !== 'waiting-approval' && runStatus !== 'waiting-clarification') {
        releaseAssistantRunController(runId);
      }
    }
  }, [
    lastInferredTrade,
    recordInferredTrade,
    addMessage,
    setPipelineStatus,
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
    documents,
    activeDocument,
    user,
    getMarkupsByPage,
    getTextContent,
    setTextContent,
    nodes,
    rootIds,
    activeProductId,
    activeDocumentRecord?.name,
    queueMarkupApproval,
    addAIMarkupBatch,
    placementMode,
    setPendingPlacements,
    applyCompletedPipelineResult,
    createEditorToolContext,
  ]);

  useEffect(() => {
    const retry = (event: Event) => {
      const detail = (event as CustomEvent<{ content: string; images?: string[] }>).detail;
      if (detail?.content) void handleSendMessage(detail.content, detail.images);
    };
    window.addEventListener('bidveraai:retry', retry);
    window.addEventListener('bidveraai:quick-reply', retry);
    return () => {
      window.removeEventListener('bidveraai:retry', retry);
      window.removeEventListener('bidveraai:quick-reply', retry);
    };
  }, [handleSendMessage]);

  useEffect(() => startAiPreviewSync({
    getDefaultStyle: () => useCanvasStore.getState().defaultStyle,
    getFallbackSize: () => {
      const canvas = useCanvasStore.getState();
      return { pageWidth: canvas.pageWidth, pageHeight: canvas.pageHeight };
    },
  }), []);
  
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
  const activeRun = Object.values(runs).find(run => run.status === 'running');
  const waitingForUser = Object.values(runs).some(
    run => run.status === 'waiting-clarification' || run.status === 'waiting-approval',
  );
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
    () => Object.values(nodes).filter((node) => node.type !== 'folder'),
    [nodes]
  );
  const hasProducts = productOptions.length > 0;

  const handleCreateNode = useCallback(async () => {
    const name = createNodeName.trim();
    if (!name || !user) return;
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const category = createNodeParentId ? nodes[createNodeParentId]?.categoryPath || '' : '';
    if (createNodeType === 'folder') {
      await queueMutation('product_categories', 'insert', {
        id,
        user_id: user.id,
        path: category ? `${category}/${name}` : name,
        sort_order: 0,
        created_at: now,
        updated_at: now,
      });
    } else if (createNodeType === 'assembly') {
      await queueMutation('assemblies', 'insert', {
        id,
        user_id: user.id,
        name,
        description: '',
        category: category || null,
        unit_of_measure: 'each',
        sku: null,
        notes: null,
        created_at: now,
        updated_at: now,
      });
    } else {
      await queueMutation('product_catalog', 'insert', {
        id,
        user_id: user.id,
        name,
        description: '',
        category: category || null,
        unit_of_measure: 'each',
        unit_price: 0,
        labor_cost: 0,
        material_cost: 0,
        supplier: null,
        sku: null,
        notes: null,
        created_at: now,
        updated_at: now,
        organization_id: null,
        is_org_catalog: false,
      });
    }
    setCreateNodeName('');
  }, [createNodeName, createNodeParentId, createNodeType, nodes, queueMutation, user]);

  useEffect(() => {
    const handleApproval = (event: Event) => {
      const detail = (event as CustomEvent<{ approvalId: string; decision: 'approved' | 'rejected' }>).detail;
      void handleApprovalDecision(detail.approvalId, detail.decision, {
        pageWidth,
        pageHeight,
        defaultStyle,
        placementMode,
        setPipelineStatus,
        createEditorToolContext,
      });
    };
    window.addEventListener('bidveraai:approval', handleApproval);
    return () => window.removeEventListener('bidveraai:approval', handleApproval);
  }, [createEditorToolContext, defaultStyle, pageHeight, pageWidth, placementMode, setPipelineStatus]);

  useEffect(() => {
    const handleClarification = (event: Event) => {
      void (async () => {
        const detail = (event as CustomEvent<ClarificationAnswerDetail>).detail;
        const store = useAIChatStore.getState();
        const clarification = store.clarifications[detail.clarificationId];
        if (!clarification || clarification.status !== 'pending') return;

        const answer = {
          selectedValues: detail.selectedValues || [],
          freeform: detail.freeform,
          displayText: detail.displayText,
        };
        const toolContext = createEditorToolContext(clarification.runId, clarification.messageId);

        try {
          setPipelineStatus({
            isRunning: true,
            message: labelForAgentStatus('thinking'),
            progress: 60,
          });
          store.updateMessage(clarification.messageId, { isLoading: true });
          const canvas = useCanvasStore.getState();
          const docId = canvas.activeDocId;
          const docData = docId ? canvas.pdfDocuments[docId] : null;
          const orchestrated = await resumeTaskAfterClarification({
            clarification,
            answer,
            toolContext,
            pipelineRuntime: {
              activeDocumentId: docId || undefined,
              pdfDoc: docData?.pdfDocument,
              getCachedText: canvas.getTextContent,
              setCachedText: canvas.setTextContent,
              onProgress: (progress) => {
                setPipelineStatus({
                  isRunning: true,
                  currentStage: progress.stage,
                  progress: progress.progress,
                  message: progress.message,
                });
                store.upsertRunStep(clarification.runId, {
                  id: `step_${progress.stage}`,
                  label: progress.message,
                  stage: progress.stage === 'error' ? 'tool' : progress.stage,
                  status: progress.stage === 'error' ? 'error' : progress.progress >= 100 ? 'completed' : 'running',
                  progress: progress.progress,
                  startedAt: new Date().toISOString(),
                  completedAt: progress.progress >= 100 ? new Date().toISOString() : undefined,
                });
              },
            },
            onStatus: (status, detailMsg) => {
              const busy = status === 'thinking'
                || status === 'running_tool'
                || status === 'running_tools'
                || status === 'routing'
                || status === 'verifying';
              setPipelineStatus({
                isRunning: busy,
                progress: status === 'needs_approval'
                  || status === 'needs_clarification'
                  || status === 'completed'
                  ? 100
                  : 60,
                message: labelForAgentStatus(status, detailMsg),
              });
            },
          });
          if (orchestrated.pipelineResult) {
            if (!orchestrated.pipelineResult.success) {
              throw new Error(orchestrated.pipelineResult.error || 'AI pipeline failed');
            }
            const pages = [...new Set(
              (orchestrated.pipelineResult.analysis || []).map(item => item.page),
            )];
            applyCompletedPipelineResult({
              result: orchestrated.pipelineResult,
              runId: clarification.runId,
              assistantMsgId: clarification.messageId,
              pages: pages.length ? pages : [canvas.getCurrentPage() || 1],
            });
            return;
          }
          const result = orchestrated.agentResult;
          if (!result) {
            store.updateMessage(clarification.messageId, {
              isLoading: orchestrated.status === 'needs_clarification',
            });
            return;
          }
          const assistantMessage = result.assistantMessage || 'The assistant could not continue this task.';
          store.updateMessage(clarification.messageId, {
            content: ensureNumberedCalloutMentions(assistantMessage, []),
            isLoading: result.status === 'needs_approval',
            error: result.status === 'failed' ? assistantMessage : undefined,
          });
          if (result.status === 'failed') {
            store.finishRun(clarification.runId, 'error', assistantMessage);
          }
        } catch (error) {
          store.updateMessage(clarification.messageId, {
            isLoading: false,
            error: error instanceof Error ? error.message : String(error),
          });
          store.finishRun(clarification.runId, 'error', error instanceof Error ? error.message : String(error));
        } finally {
          setPipelineStatus({ isRunning: false, progress: 0, message: '' });
        }
      })();
    };

    window.addEventListener('bidveraai:clarification', handleClarification);
    return () => window.removeEventListener('bidveraai:clarification', handleClarification);
  }, [applyCompletedPipelineResult, createEditorToolContext, setPipelineStatus]);

  return (
    <>
      <div className="h-full w-full flex flex-col bg-panel">
          <AssistantHeader
            conversation={conversation}
            conversations={conversationList}
            documentName={activeDocumentRecord?.name}
            page={currentPage || 1}
            trade={selectedTrade}
            onSelectConversation={value => void selectConversation(value)}
            onNewConversation={() => {
              useCanvasStore.getState().clearAiPreview();
              createConversation();
            }}
            onClose={closeDrawer}
            onOpenSettings={() => setSettingsOpen(true)}
            onClearChat={clearMessages}
          />
          
          {/* Primary assistant controls — always visible, visually secondary */}
          <AiToolbar />
          
          {/* Messages */}
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              className="h-full overflow-y-auto"
              onScroll={(event) => {
                const el = event.currentTarget;
                const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                stickToBottomRef.current = nearBottom;
                setShowJumpToLatest(!nearBottom && el.scrollHeight > el.clientHeight);
              }}
            >
            {!hasMessages ? (
              <div className="flex h-full flex-col items-center justify-center p-8 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-violet-500/20 to-purple-600/20">
                  <Sparkles className="h-7 w-7 text-violet-500" />
                </div>
                <h3 className="mb-1 text-base font-medium">BidveraAi</h3>
                <p className="mb-6 max-w-[280px] text-sm text-muted-foreground">
                  Ask about this plan, counts, or markups.
                </p>
                <div className="w-full max-w-[300px] space-y-2">
                  {(() => {
                    const sheet = (activeDocumentRecord?.name || '').match(/\b([A-Z]{1,3}-\d{1,3}[A-Z]?)\b/)?.[1] || 'this sheet';
                    const chips = [
                      `Count fixtures on ${sheet}`,
                      `Check specs for fixture type A`,
                      'Place count markers',
                      'Map types to products',
                    ];
                    return chips.map(text => (
                      <QuickPrompt
                        key={text}
                        text={text}
                        onClick={() => handleSendMessage(text)}
                        disabled={!isAIAvailable || isLoading}
                      />
                    ));
                  })()}
                </div>
              </div>
            ) : (
              <div className="py-2">
                {messages.map(message => (
                  <ChatMessage key={message.id} message={message} />
                ))}
              </div>
            )}
            </div>
            {showJumpToLatest && (
              <button
                type="button"
                onClick={scrollToBottom}
                className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-md motion-safe:transition-opacity"
              >
                Jump to latest
              </button>
            )}
          </div>
          
          {/* Input */}
          <AssistantComposer
            onSend={(message, images) => {
              void handleSendMessage(message, images);
            }}
            isLoading={isLoading || pipelineStatus.isRunning}
            disabled={!isAIAvailable || waitingForUser}
            onStop={activeRun ? () => {
              useCanvasStore.getState().clearAiPreview();
              cancelTask(activeRun.id);
            } : undefined}
            contextChips={[
              activeDocumentRecord?.name || 'No document',
              `Page ${currentPage || 1}`,
              lastInferredTrade || selectedTrade,
            ]}
          />
      </div>

      {/* Settings Dialog */}
      <AiSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />


      <Dialog open={productMapOpen} onOpenChange={setProductMapOpen}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Map AI Types to Products</DialogTitle>
            <DialogDescription>
              Select a detected item on the left, then click its matching product on the right.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 min-h-0 overflow-y-auto pr-1">
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

            <ProductMatchPanel
              mapKeys={productMapKeys.length ? productMapKeys : Object.keys(pendingCountMap)}
              counts={pendingCountMap}
              values={productMapValues}
              onSelect={(key, productId) =>
                setProductMapValues((prev) => ({ ...prev, [key]: productId }))
              }
              productOptions={productOptions}
            />

            <div className="border-t border-border pt-2">
              <button
                type="button"
                onClick={() => setShowCreateForm((prev) => !prev)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <PackagePlus className="w-3.5 h-3.5" />
                {showCreateForm ? 'Hide create form' : "Don't see it? Create a new product or category"}
              </button>
              {showCreateForm && (
                <div className="mt-2 rounded-md border border-border p-3 space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium">
                    {createNodeType === 'product' ? <PackagePlus className="w-4 h-4" /> : createNodeType === 'assembly' ? <Boxes className="w-4 h-4" /> : <FolderPlus className="w-4 h-4" />}
                    Create {createNodeType === 'product' ? 'Product' : createNodeType === 'assembly' ? 'Assembly' : 'Category'}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Select
                      value={createNodeType}
                      onValueChange={(value) => setCreateNodeType(value as 'product' | 'folder' | 'assembly')}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="product">Product</SelectItem>
                        <SelectItem value="assembly">Assembly</SelectItem>
                        <SelectItem value="folder">Category</SelectItem>
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
                      placeholder={createNodeType === 'product' ? 'Product name' : createNodeType === 'assembly' ? 'Assembly name' : 'Category name'}
                      className="h-8 text-xs"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 text-xs"
                      onClick={() => void handleCreateNode()}
                      disabled={!createNodeName.trim()}
                    >
                      Create
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4 flex-shrink-0">
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

function addDocumentEvidenceBlock(
  messageId: string,
  documentName: string | undefined,
  pages: number[],
  evidence: string[] = []
): void {
  const citations: EvidenceCitation[] = pages.map((page, index) => ({
    id: `citation_${messageId}_${page}`,
    documentName,
    page,
    label: `${documentName || 'Document'}, page ${page}`,
    snippet: evidence[index] || evidence[0],
  }));
  useAIChatStore.getState().addMessageBlock(messageId, {
    id: `block_evidence_${messageId}`,
    type: 'evidence',
    title: 'Document evidence',
    summary: evidence.length ? evidence.slice(0, 3).join(' · ') : 'Answer grounded in the active document page.',
    citations,
  });
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
