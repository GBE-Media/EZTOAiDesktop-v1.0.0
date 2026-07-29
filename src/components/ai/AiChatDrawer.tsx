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
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAIChatStore } from '@/store/aiChatStore';
import { useAISettingsStore } from '@/store/aiSettingsStore';
import { useCanvasStore } from '@/store/canvasStore';
import { useProductStore } from '@/store/productStore';
import {
  BASE_RENDER_SCALE,
  createPageGeometry,
  proposalsFromChatPointers,
  proposalsFromPlacementMarkups,
  usePlacementDebugStore,
  verifyMarkupProposal,
} from '@/services/ai/placement';
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
import { chatPointersToGreenPlacements, ensureNumberedCalloutMentions } from '@/services/ai/callouts';
import { fetchTrainingContext } from '@/services/ai/trainingService';
import type { CanvasMarkup, MarkupStyle } from '@/types/markup';
import type { BlueprintAnalysisResult, CanvasPlacement, ChatMarkupPointer, PlacementMarkup } from '@/services/ai/providers/types';
import { useAuth } from '@/hooks/useAuth';
import { useCatalogSync } from '@/components/catalog/CatalogSyncProvider';
import {
  registerAssistantRunController,
  releaseAssistantRunController,
} from '@/services/ai/assistantOrchestrator';
import type { EvidenceCitation } from '@/types/assistant';
import {
  executeApprovedAssistantAction,
  proposeAssistantMutation,
} from '@/services/ai/tools/registry';
import {
  buildAgentContext,
  cancelTask,
  createAgentToolContext,
  labelForAgentStatus,
  registerAllAgentTools,
  resumeTaskAfterApproval,
  resumeTaskAfterClarification,
  startAgentTask,
  startPipelineTask,
} from '@/services/ai/agent';
import type { ClarificationAnswerDetail } from './QuestionCard';
import { AssistantHeader } from './AssistantHeader';
import { AssistantComposer } from './AssistantComposer';

/** @deprecated Prefer AgentAssistantDrawer — same implementation. */
export function AiChatDrawer() {
  return <AgentAssistantDrawer />;
}

/** Primary docked agent panel used by the editor. */
export function AgentAssistantDrawer() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pageSelection, setPageSelection] = useState('current');
  const [productMapOpen, setProductMapOpen] = useState(false);
  const [productMapKeys, setProductMapKeys] = useState<string[]>([]);
  const [productMapValues, setProductMapValues] = useState<Record<string, string>>({});
  const [pendingCountMap, setPendingCountMap] = useState<Record<string, number>>({});
  const [placeMarkupsOpen, setPlaceMarkupsOpen] = useState(false);
  const [pendingMarkups, setPendingMarkups] = useState<Array<{ page: number; markup: CanvasMarkup }>>([]);
  const [pendingDetectedKeys, setPendingDetectedKeys] = useState<string[]>([]);
  const [pendingAssistantId, setPendingAssistantId] = useState<string | null>(null);
  const [takeoffOpen, setTakeoffOpen] = useState(false);
  const [takeoffPrompt, setTakeoffPrompt] = useState('');
  const [takeoffScope, setTakeoffScope] = useState<'ask' | 'viewport' | 'full' | 'selection'>('ask');
  const highAccuracy = true;
  const [visibleOnly, setVisibleOnly] = useState(false);
  const [takeoffError, setTakeoffError] = useState<string | null>(null);
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
  
  const totalPages = activeDocId ? pdfDocuments[activeDocId]?.totalPages || 0 : 0;
  const selectedPages = useMemo(
    () => parsePageSelection(pageSelection, totalPages, currentPage || 1),
    [pageSelection, totalPages, currentPage]
  );

  const queueMarkupApproval = useCallback((options: {
    assistantMsgId: string;
    runId: string;
    markups: Array<{ page: number; markup: CanvasMarkup }>;
    description: string;
  }) => {
    setPendingMarkups(options.markups);
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
    trade: useAIChatStore.getState().selectedTrade,
    placeMarkups: (payload) => {
      const canvas = useCanvasStore.getState();
      const docId = canvas.activeDocId;
      const pdf = docId ? canvas.pdfDocuments[docId] : null;
      const markups = normalizeAgentMarkupPayload({
        payload,
        page: canvas.getCurrentPage() || 1,
        pageWidth: pdf?.originalPageWidth || pageWidth,
        pageHeight: pdf?.originalPageHeight || pageHeight,
        idPrefix: `agent_${messageId}`,
        messageId,
        defaultStyle,
      });
      if (!markups.length) return { placed: 0 };
      addAIMarkupBatch(markups, placementMode === 'confirm');
      if (placementMode === 'confirm') {
        setPendingPlacements(markups.map(({ markup }) => ({
          id: markup.id,
          type: markup.type,
          page: markup.page,
          data: markup,
        })));
      }
      return { placed: markups.length };
    },
    navigateToPage: (page, bounds) => {
      const canvas = useCanvasStore.getState();
      canvas.setCurrentPage(page);
      if (bounds && canvas.activeDocId) {
        canvas.setAiSelectionRect(canvas.activeDocId, page, bounds);
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
    const currentPageNumber = canvas.getCurrentPage() || 1;
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
    addDocumentEvidenceBlock(
      options.assistantMsgId,
      activeDocumentRecord?.name,
      options.pages,
      options.result.evidence,
    );

    if (options.result.placements?.markups.length) {
      const pageGeom = createPageGeometry({
        pageNumber: currentPageNumber,
        docWidth: docData?.originalPageWidth || pageWidth,
        docHeight: docData?.originalPageHeight || pageHeight,
      });
      const proposals = proposalsFromPlacementMarkups({
        markups: options.result.placements.markups,
        page: pageGeom,
      });
      const verified = proposals.map(proposal => verifyMarkupProposal(proposal, {
        page: pageGeom,
        enableSnap: false,
      }));
      usePlacementDebugStore.getState().setDebugScene({
        page: pageGeom,
        proposals: verified.map(item => item.proposal),
      });
      const proposedMarkups = convertPlacementsToMarkups(
        options.result.placements,
        defaultStyle,
        `takeoff_${options.assistantMsgId}`,
        BASE_RENDER_SCALE,
        BASE_RENDER_SCALE,
        verified.map(item => ({
          id: item.proposal.id,
          pending: item.requiresConfirmation,
          confidence: item.proposal.confidence,
        })),
      );
      queueMarkupApproval({
        assistantMsgId: options.assistantMsgId,
        runId: options.runId,
        markups: proposedMarkups,
        description: `Place ${proposedMarkups.length} verified green callout${proposedMarkups.length === 1 ? '' : 's'} from this takeoff.`,
      });
    } else {
      store.finishRun(options.runId, 'completed');
    }
  }, [
    activeDocumentRecord?.name,
    defaultStyle,
    pageHeight,
    pageWidth,
    queueMarkupApproval,
  ]);
  
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

      const answerText = ensureNumberedCalloutMentions(agentResult.assistantMessage, []);
      updateMessage(assistantMsgId, {
        content: answerText,
        isLoading: agentResult.status === 'needs_approval',
        metadata: {
          trade: selectedTrade,
          tokenUsage: undefined,
        },
      });

      if (activeDocId) {
        addDocumentEvidenceBlock(assistantMsgId, activeDocumentRecord?.name, [currentPage || 1]);
      }

      if (agentResult.status === 'needs_clarification') {
        return;
      }

      if (agentResult.status === 'needs_approval' && agentResult.approvalRequest) {
        const approval = agentResult.approvalRequest;
        if (approval.toolId === 'place_markups' || approval.toolId === 'propose_callouts') {
          const pageWidthPx = docData?.originalPageWidth || pageWidth;
          const pageHeightPx = docData?.originalPageHeight || pageHeight;
          const normalized = normalizeAgentMarkupPayload({
            payload: approval.payload,
            page: currentPage || 1,
            pageWidth: pageWidthPx,
            pageHeight: pageHeightPx,
            idPrefix: `agent_${assistantMsgId}`,
            messageId: assistantMsgId,
            defaultStyle,
          });
          if (normalized.length > 0) {
            setPendingMarkups(normalized);
            setPendingAssistantId(assistantMsgId);
          }
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
    return () => window.removeEventListener('bidveraai:retry', retry);
  }, [handleSendMessage]);
  
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
      // Append rather than overwrite - the assistant's actual chat answer may
      // already be in this message (e.g. when pointers came from normal chat).
      const existing = messages.find((message) => message.id === pendingAssistantId);
      const count = pendingMarkups.length;
      const suffix = `\n\n✓ Placed ${count} marker${count === 1 ? '' : 's'} on the canvas.`;
      updateMessage(pendingAssistantId, {
        content: `${existing?.content || ''}${suffix}`,
      });
    }

    setPendingMarkups([]);
    setPendingDetectedKeys([]);
    setPendingAssistantId(null);
    setPlaceMarkupsOpen(false);
  }, [
    addAIMarkupBatch,
    messages,
    pendingAssistantId,
    pendingDetectedKeys,
    pendingMarkups,
    placementMode,
    setPendingPlacements,
    updateMessage,
  ]);

  useEffect(() => {
    const handleApproval = (event: Event) => {
      void (async () => {
      const detail = (event as CustomEvent<{ approvalId: string; decision: 'approved' | 'rejected' }>).detail;
      const store = useAIChatStore.getState();
      const approval = store.approvals[detail.approvalId];
      if (!approval || approval.status !== 'pending') return;

      const continueAgent = async (decision: 'approved' | 'rejected', executionResult?: unknown) => {
        const toolContext = createEditorToolContext(approval.runId, approval.messageId);
        try {
          setPipelineStatus({ isRunning: true, message: 'Continuing assistant…', progress: 60 });
          const orchestrated = await resumeTaskAfterApproval({
            runId: approval.runId,
            approval,
            decision,
            toolContext,
            executionResult,
          });
          const result = orchestrated.agentResult;
          if (!result) return;
          const assistantMessage = result.assistantMessage || 'The assistant could not continue this task.';
          if (orchestrated.errorCode === 'SESSION_EXPIRED') {
            store.finishRun(approval.runId, 'completed');
            const existing = store.messages.find(message => message.id === approval.messageId);
            const placed = (executionResult as { placed?: number } | undefined)?.placed;
            store.updateMessage(approval.messageId, {
              content: `${existing?.content || ''}\n\n${
                decision === 'rejected'
                  ? 'Callout placement was declined. The document was not changed.'
                  : `✓ ${typeof placed === 'number'
                      ? `Placed ${placed} callout${placed === 1 ? '' : 's'}`
                      : 'Approved action executed'
                    }. Use Undo to revert this batch.`
              }`,
              isLoading: false,
            });
            return;
          }
          store.updateMessage(approval.messageId, {
            content: assistantMessage,
            isLoading: false,
            error: result.status === 'failed' ? assistantMessage : undefined,
          });
          if (result.status === 'failed') {
            store.finishRun(approval.runId, 'error', assistantMessage);
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          store.updateMessage(approval.messageId, {
            isLoading: false,
            error: errorMessage,
          });
          store.finishRun(approval.runId, 'error', errorMessage);
        } finally {
          setPipelineStatus({ isRunning: false, progress: 0, message: '' });
        }
      };

      if (detail.decision === 'rejected') {
        store.resolveApproval(approval.id, 'rejected');
        void continueAgent('rejected');
        return;
      }

      try {
        let executionResult: unknown;
        if (
          approval.toolId === 'place_markups'
          || approval.toolId === 'propose_callouts'
        ) {
          const canvas = useCanvasStore.getState();
          const docId = canvas.activeDocId;
          const pdf = docId ? canvas.pdfDocuments[docId] : null;
          const markups = normalizeAgentMarkupPayload({
            payload: approval.payload,
            page: canvas.getCurrentPage() || 1,
            pageWidth: pdf?.originalPageWidth || pageWidth,
            pageHeight: pdf?.originalPageHeight || pageHeight,
            idPrefix: `agent_${approval.messageId}`,
            messageId: approval.messageId,
            defaultStyle,
          });
          if (markups.length === 0 && Array.isArray(approval.payload)) {
            // Pipeline path: payload already CanvasMarkup pairs
            const legacy = approval.payload as Array<{ page: number; markup: CanvasMarkup }>;
            addAIMarkupBatch(legacy, placementMode === 'confirm');
            if (placementMode === 'confirm') {
              setPendingPlacements(legacy.map(({ markup }) => ({
                id: markup.id,
                type: markup.type,
                page: markup.page,
                data: markup,
              })));
            }
            executionResult = { placed: legacy.length };
          } else {
            addAIMarkupBatch(markups, placementMode === 'confirm');
            if (placementMode === 'confirm') {
              setPendingPlacements(markups.map(({ markup }) => ({
                id: markup.id,
                type: markup.type,
                page: markup.page,
                data: markup,
              })));
            }
            executionResult = { placed: markups.length };
          }
        } else {
          const toolContext = createAgentToolContext({
            runId: approval.runId,
            messageId: approval.messageId,
            trade: store.selectedTrade,
            placeMarkups: () => ({ placed: 0 }),
          });
          executionResult = await executeApprovedAssistantAction(approval, toolContext);
        }

        store.resolveApproval(approval.id, 'executed');

        void continueAgent('approved', executionResult);
      } catch (error) {
        store.resolveApproval(
          approval.id,
          'failed',
          error instanceof Error ? error.message : String(error)
        );
      }
      })();
    };
    window.addEventListener('bidveraai:approval', handleApproval);
    return () => window.removeEventListener('bidveraai:approval', handleApproval);
  }, [addAIMarkupBatch, createEditorToolContext, defaultStyle, pageHeight, pageWidth, placementMode, setPendingPlacements, setPipelineStatus]);

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
            onNewConversation={() => createConversation()}
            onClose={closeDrawer}
          />
          
          {/* Primary assistant controls — always visible */}
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
                <h3 className="text-lg font-medium mb-2">BidveraAi Agent</h3>
                <p className="text-sm text-muted-foreground mb-6 max-w-[300px]">
                  Inspect takeoff context, call tools, ask clarifying questions, and propose reviewable changes (callouts require approval).
                </p>
                
                <div className="space-y-2 w-full max-w-[300px]">
                  <p className="text-xs text-muted-foreground mb-2">Try asking:</p>
                  <QuickPrompt
                    text="Where is the fixture schedule on this page?"
                    onClick={() => handleSendMessage('Where is the fixture schedule on this page?')}
                    disabled={!isAIAvailable || isLoading}
                  />
                  <QuickPrompt
                    text="Summarize material counts for this takeoff"
                    onClick={() => handleSendMessage('Summarize material counts for this takeoff')}
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
          
          {/* Input */}
          <AssistantComposer
            onSend={(message, images) => {
              if (message.trim().toLowerCase().startsWith('/takeoff')) {
                const prompt = message.replace(/^\/takeoff\s*/i, '') || 'Run a takeoff for the active page.';
                void handleSendMessage(prompt, images, { forcePipeline: true, scope: 'full', highAccuracy: true });
                return;
              }
              void handleSendMessage(message, images);
            }}
            isLoading={isLoading || pipelineStatus.isRunning}
            disabled={!isAIAvailable || waitingForUser}
            onStop={activeRun ? () => cancelTask(activeRun.id) : undefined}
            contextChips={[
              activeDocumentRecord?.name || 'No document',
              `Page ${currentPage || 1}`,
              selectedTrade,
              takeoffScope === 'ask' ? 'Active page' : takeoffScope,
            ]}
          />
      </div>

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
                <p className="text-sm font-medium">Maximum Accuracy</p>
                <p className="text-xs text-muted-foreground">Always uses overview, tile, OCR, reconciliation, and verification passes.</p>
              </div>
              <input
                type="checkbox"
                checked={highAccuracy}
                disabled
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
              The AI wants to mark {pendingMarkups.length} location{pendingMarkups.length === 1 ? '' : 's'} on the canvas. Place them?
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-4">
            <Button
              variant="outline"
              onClick={() => {
                if (pendingAssistantId) {
                  // Append rather than overwrite - keep the assistant's actual answer intact.
                  const existing = messages.find((message) => message.id === pendingAssistantId);
                  updateMessage(pendingAssistantId, {
                    content: `${existing?.content || ''}\n\nMarkups not placed.`,
                  });
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
  scaleX: number = BASE_RENDER_SCALE,
  scaleY: number = BASE_RENDER_SCALE,
  verificationById?: Array<{ id: string; pending: boolean; confidence: number }>,
): Array<{ page: number; markup: CanvasMarkup }> {
  const now = new Date().toISOString();
  const markups: Array<{ page: number; markup: CanvasMarkup }> = [];
  const verificationMap = new Map(
    (verificationById || []).map(item => [item.id, item]),
  );
  
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
    const verification = verificationMap.get(placement.id || '')
      || verificationMap.get(`proposal_pl_${index}`)
      || verificationMap.get(`proposal_ptr_${placement.calloutRef || index + 1}`);
    const pending = verification?.pending ?? placement.pending;
    const confidence = verification?.confidence ?? placement.confidence;
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
      aiPending: pending,
      aiNote: placement.aiNote,
      aiConfidence: confidence,
      aiLinkedItemId: placement.linkedItemId,
      calloutRef: placement.calloutRef,
    } as const;

    if (placement.type === 'rectangle') {
      const start = placement.points?.[0] || { x: 0, y: 0 };
      const end = placement.points?.[1] || start;
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'rectangle',
          x: Math.min(start.x, end.x) * scaleX,
          y: Math.min(start.y, end.y) * scaleY,
          width: Math.abs(end.x - start.x) * scaleX,
          height: Math.abs(end.y - start.y) * scaleY,
        },
      });
      return;
    }
    
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

    if (placement.type === 'callout') {
      const start = placement.points?.[0] || { x: 0, y: 0 };
      const end = placement.points?.[1] || {
        x: start.x + 120,
        y: start.y + 36,
      };
      const ref = placement.calloutRef || index + 1;
      markups.push({
        page: placement.page,
        markup: {
          ...base,
          type: 'callout',
          x: Math.min(start.x, end.x) * scaleX,
          y: Math.min(start.y, end.y) * scaleY,
          width: Math.max(Math.abs(end.x - start.x) * scaleX, 72),
          height: Math.max(Math.abs(end.y - start.y) * scaleY, 28),
          content: placement.content || `[${ref}] ${placement.label || 'Callout'}`,
          leaderPoints: (placement.leaderPoints || []).map((point) => ({
            x: point.x * scaleX,
            y: point.y * scaleY,
          })),
          calloutRef: ref,
        },
      });
    }
  });
  
  return markups;
}

/**
 * Normalize agent/pipeline approval payloads into page+markup pairs.
 * Accepts: [{page, markup}], pointer arrays, or { markups|callouts|pointers: [...] }.
 */
function normalizeAgentMarkupPayload(options: {
  payload: unknown;
  page: number;
  pageWidth: number;
  pageHeight: number;
  idPrefix: string;
  messageId: string;
  defaultStyle: MarkupStyle;
}): Array<{ page: number; markup: CanvasMarkup }> {
  const raw = options.payload;
  if (!raw) return [];

  const asArray = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { payload?: unknown }).payload)
      ? (raw as { payload: unknown[] }).payload
      : Array.isArray((raw as { markups?: unknown[] }).markups)
        ? (raw as { markups: unknown[] }).markups
        : Array.isArray((raw as { callouts?: unknown[] }).callouts)
          ? (raw as { callouts: unknown[] }).callouts
          : Array.isArray((raw as { pointers?: unknown[] }).pointers)
            ? (raw as { pointers: unknown[] }).pointers
            : null;

  if (!asArray || asArray.length === 0) return [];

  const first = asArray[0] as Record<string, unknown>;
  if (first && typeof first === 'object' && first.markup && (first.page != null || true)) {
    const legacy = asArray.filter((item): item is { page: number; markup: CanvasMarkup } => {
      const row = item as { page?: number; markup?: CanvasMarkup };
      return !!row?.markup;
    });
    if (legacy.length > 0) {
      return legacy.map(item => ({
        page: item.page || options.page,
        markup: {
          ...item.markup,
          messageId: options.messageId,
          page: item.markup.page || item.page || options.page,
        } as CanvasMarkup,
      }));
    }
  }

  const pointers = asArray.map((item, index) => {
    const row = item as Record<string, unknown>;
    const xPct = Number(row.xPct ?? row.x ?? 50);
    const yPct = Number(row.yPct ?? row.y ?? 50);
    return {
      type: (row.type as 'callout') || 'callout',
      ref: Number(row.ref ?? index + 1),
      xPct: Number.isFinite(xPct) ? xPct : 50,
      yPct: Number.isFinite(yPct) ? yPct : 50,
      boundsPct: row.boundsPct as ChatMarkupPointer['boundsPct'],
      label: typeof row.label === 'string' ? row.label : typeof row.content === 'string' ? row.content : `Callout ${index + 1}`,
      note: typeof row.note === 'string' ? row.note : undefined,
      confidence: typeof row.confidence === 'number' ? row.confidence : undefined,
    };
  });

  const placements = chatPointersToGreenPlacements({
    pointers,
    page: options.page,
    pageWidth: options.pageWidth,
    pageHeight: options.pageHeight,
    idPrefix: options.idPrefix,
  });

  // pageWidth/Height here are document points (originalPage*). Proposals stay in doc space;
  // convertPlacementsToMarkups applies BASE_RENDER_SCALE at the canvas boundary.
  const pageGeom = createPageGeometry({
    pageNumber: options.page,
    docWidth: options.pageWidth,
    docHeight: options.pageHeight,
  });
  const proposals = proposalsFromChatPointers({ pointers, page: pageGeom });
  const verified = proposals.map(proposal => verifyMarkupProposal(proposal, {
    page: pageGeom,
    enableSnap: false,
  }));
  usePlacementDebugStore.getState().setDebugScene({
    page: pageGeom,
    proposals: verified.map(item => item.proposal),
    ocrRects: (useCanvasStore.getState().getTextContent(options.page) || [])
      .slice(0, 80)
      .map(item => ({
        x: item.x / BASE_RENDER_SCALE,
        y: item.y / BASE_RENDER_SCALE,
        width: item.width / BASE_RENDER_SCALE,
        height: item.height / BASE_RENDER_SCALE,
      })),
  });

  return convertPlacementsToMarkups(
    placements,
    options.defaultStyle,
    options.idPrefix,
    BASE_RENDER_SCALE,
    BASE_RENDER_SCALE,
    verified.map(item => ({
      id: item.proposal.id,
      pending: item.requiresConfirmation,
      confidence: item.proposal.confidence,
    })),
  ).map(({ page, markup }) => ({
    page,
    markup: { ...markup, messageId: options.messageId } as CanvasMarkup,
  }));
}
