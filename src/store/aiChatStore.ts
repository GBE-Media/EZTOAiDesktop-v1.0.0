/**
 * AI Chat Store
 * Manages AI chat state, message history, and pipeline status
 */

import { create } from 'zustand';
import type { TradeType, PipelineStage } from '@/services/ai/providers/types';
import type {
  ApprovalRequest,
  AssistantConversation,
  AssistantMessageBlock,
  AssistantRun,
  RunStep,
} from '@/types/assistant';
import {
  listAssistantSnapshots,
  readAssistantSnapshotById,
  writeAssistantSnapshot,
} from '@/db/assistantDb';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  blocks?: AssistantMessageBlock[];
  timestamp: Date;
  images?: string[];
  isLoading?: boolean;
  error?: string;
  metadata?: {
    stage?: PipelineStage;
    trade?: TradeType;
    tokenUsage?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };
}

export interface PipelineStatus {
  isRunning: boolean;
  currentStage: PipelineStage | 'complete' | 'error' | null;
  progress: number;
  message: string;
}

export type PlacementMode = 'auto' | 'confirm';

interface AIChatState {
  // Drawer state
  isOpen: boolean;
  
  // Chat state
  messages: ChatMessage[];
  isLoading: boolean;
  
  // Trade selection
  selectedTrade: TradeType;
  
  // Placement mode
  placementMode: PlacementMode;
  
  // Pipeline status
  pipelineStatus: PipelineStatus;
  
  // Pending placements (for confirm mode)
  pendingPlacements: Array<{
    id: string;
    type: string;
    page: number;
    data: unknown;
  }>;

  conversation: AssistantConversation | null;
  conversationList: AssistantConversation[];
  conversationContextId: string | null;
  conversationHydrated: boolean;
  runs: Record<string, AssistantRun>;
  approvals: Record<string, ApprovalRequest>;
  
  // Actions
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => string;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  setConversationContext: (contextId: string, title?: string) => Promise<void>;
  createConversation: (title?: string) => void;
  selectConversation: (conversationId: string) => Promise<void>;
  addMessageBlock: (messageId: string, block: AssistantMessageBlock) => void;
  createRun: (messageId: string, summary?: string) => string;
  upsertRunStep: (runId: string, step: RunStep) => void;
  finishRun: (runId: string, status?: AssistantRun['status'], error?: string) => void;
  cancelRun: (runId: string) => void;
  addApproval: (approval: ApprovalRequest) => void;
  resolveApproval: (approvalId: string, status: ApprovalRequest['status'], error?: string) => void;
  
  setSelectedTrade: (trade: TradeType) => void;
  setPlacementMode: (mode: PlacementMode) => void;
  
  setPipelineStatus: (status: Partial<PipelineStatus>) => void;
  resetPipelineStatus: () => void;
  
  addPendingPlacement: (placement: { id: string; type: string; page: number; data: unknown }) => void;
  setPendingPlacements: (placements: Array<{ id: string; type: string; page: number; data: unknown }>) => void;
  confirmPlacement: (id: string) => void;
  rejectPlacement: (id: string) => void;
  confirmAllPlacements: () => void;
  rejectAllPlacements: () => void;
}

const generateId = () => `msg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
const generateRunId = () => `run_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

export const useAIChatStore = create<AIChatState>((set, get) => ({
  // Initial state
  isOpen: false,
  messages: [],
  isLoading: false,
  selectedTrade: 'electrical',
  placementMode: 'confirm',
  pipelineStatus: {
    isRunning: false,
    currentStage: null,
    progress: 0,
    message: '',
  },
  pendingPlacements: [],
  conversation: null,
  conversationList: [],
  conversationContextId: null,
  conversationHydrated: false,
  runs: {},
  approvals: {},
  
  // Drawer actions
  openDrawer: () => set({ isOpen: true }),
  closeDrawer: () => set({ isOpen: false }),
  toggleDrawer: () => set(state => ({ isOpen: !state.isOpen })),
  
  // Message actions
  addMessage: (message) => {
    const id = generateId();
    const newMessage: ChatMessage = {
      ...message,
      id,
      timestamp: new Date(),
    };
    
    set(state => {
      const shouldNameConversation = message.role === 'user'
        && state.messages.every(existing => existing.role !== 'user')
        && state.conversation;
      const conversation = shouldNameConversation
        ? {
            ...state.conversation!,
            title: message.content.slice(0, 48) || 'Document analysis',
            updatedAt: new Date().toISOString(),
          }
        : state.conversation;
      return {
        messages: [...state.messages, newMessage],
        isLoading: message.isLoading ?? false,
        conversation,
        conversationList: conversation
          ? [conversation, ...state.conversationList.filter(item => item.id !== conversation.id)]
          : state.conversationList,
      };
    });
    
    return id;
  },
  
  updateMessage: (id, updates) => {
    set(state => ({
      messages: state.messages.map(msg =>
        msg.id === id ? { ...msg, ...updates } : msg
      ),
      isLoading: updates.isLoading ?? state.isLoading,
    }));
  },
  
  clearMessages: () => {
    set({ messages: [], pendingPlacements: [], runs: {}, approvals: {} });
  },

  setConversationContext: async (contextId, title = 'BidveraAi conversation') => {
    if (get().conversationContextId === contextId && get().conversationHydrated) return;
    const snapshots = await listAssistantSnapshots(contextId);
    const stored = snapshots[0];
    if (stored) {
      set({
        conversation: stored.conversation,
        conversationList: snapshots.map(snapshot => snapshot.conversation),
        conversationContextId: contextId,
        conversationHydrated: true,
        messages: stored.messages.map(message => ({
          ...message,
          timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
        })),
        runs: Object.fromEntries(stored.runs.map(run => [run.id, run])),
        approvals: Object.fromEntries(stored.approvals.map(approval => [approval.id, approval])),
      });
      return;
    }

    const now = new Date().toISOString();
    const conversation: AssistantConversation = {
      id: `conversation_${contextId}_${Date.now()}`,
      contextId,
      title,
      trade: get().selectedTrade,
      createdAt: now,
      updatedAt: now,
    };
    set({
      conversation,
      conversationList: [conversation],
      conversationContextId: contextId,
      conversationHydrated: true,
      messages: [],
      runs: {},
      approvals: {},
    });
  },

  createConversation: (title = 'New conversation') => {
    const contextId = get().conversationContextId;
    if (!contextId) return;
    const now = new Date().toISOString();
    const conversation: AssistantConversation = {
      id: `conversation_${contextId}_${Date.now()}`,
      contextId,
      title,
      trade: get().selectedTrade,
      createdAt: now,
      updatedAt: now,
    };
    set(state => ({
      conversation,
      conversationList: [conversation, ...state.conversationList],
      messages: [],
      runs: {},
      approvals: {},
      pendingPlacements: [],
    }));
  },

  selectConversation: async (conversationId) => {
    const stored = await readAssistantSnapshotById(conversationId);
    if (!stored) return;
    set({
      conversation: stored.conversation,
      messages: stored.messages.map(message => ({
        ...message,
        timestamp: message.timestamp instanceof Date ? message.timestamp : new Date(message.timestamp),
      })),
      runs: Object.fromEntries(stored.runs.map(run => [run.id, run])),
      approvals: Object.fromEntries(stored.approvals.map(approval => [approval.id, approval])),
    });
  },

  addMessageBlock: (messageId, block) => set(state => ({
    messages: state.messages.map(message =>
      message.id === messageId
        ? { ...message, blocks: [...(message.blocks || []), block] }
        : message
    ),
  })),

  createRun: (messageId, summary) => {
    const id = generateRunId();
    const now = new Date().toISOString();
    const conversationId = get().conversation?.id || 'session';
    const run: AssistantRun = {
      id,
      messageId,
      conversationId,
      status: 'running',
      summary,
      steps: [],
      startedAt: now,
    };
    set(state => ({ runs: { ...state.runs, [id]: run } }));
    get().addMessageBlock(messageId, { id: `block_${id}`, type: 'activity', runId: id });
    return id;
  },

  upsertRunStep: (runId, step) => set(state => {
    const run = state.runs[runId];
    if (!run) return state;
    const existingIndex = run.steps.findIndex(candidate => candidate.id === step.id);
    const steps = existingIndex >= 0
      ? run.steps.map(candidate => candidate.id === step.id ? { ...candidate, ...step } : candidate)
      : [...run.steps, step];
    return { runs: { ...state.runs, [runId]: { ...run, steps } } };
  }),

  finishRun: (runId, status = 'completed', error) => set(state => {
    const run = state.runs[runId];
    if (!run) return state;
    return {
      runs: {
        ...state.runs,
        [runId]: {
          ...run,
          status,
          error,
          completedAt: new Date().toISOString(),
        },
      },
    };
  }),

  cancelRun: (runId) => {
    const run = get().runs[runId];
    if (!run) return;
    run.steps
      .filter(step => step.status === 'running' || step.status === 'pending')
      .forEach(step => get().upsertRunStep(runId, { ...step, status: 'cancelled' }));
    get().finishRun(runId, 'cancelled');
  },

  addApproval: (approval) => set(state => ({
    approvals: { ...state.approvals, [approval.id]: approval },
  })),

  resolveApproval: (approvalId, status, error) => set(state => {
    const approval = state.approvals[approvalId];
    if (!approval) return state;
    return {
      approvals: {
        ...state.approvals,
        [approvalId]: {
          ...approval,
          status,
          error,
          resolvedAt: new Date().toISOString(),
        },
      },
    };
  }),
  
  // Trade selection
  setSelectedTrade: (trade) => set({ selectedTrade: trade }),
  
  // Placement mode
  setPlacementMode: (mode) => set({ placementMode: mode }),
  
  // Pipeline status
  setPipelineStatus: (status) => {
    set(state => ({
      pipelineStatus: { ...state.pipelineStatus, ...status },
    }));
  },
  
  resetPipelineStatus: () => {
    set({
      pipelineStatus: {
        isRunning: false,
        currentStage: null,
        progress: 0,
        message: '',
      },
    });
  },
  
  // Pending placements
  addPendingPlacement: (placement) => {
    set(state => ({
      pendingPlacements: [...state.pendingPlacements, placement],
    }));
  },
  
  setPendingPlacements: (placements) => {
    set({ pendingPlacements: placements });
  },
  
  confirmPlacement: (id) => {
    set(state => ({
      pendingPlacements: state.pendingPlacements.filter(p => p.id !== id),
    }));
    // Note: Actual canvas placement is handled by the component
  },
  
  rejectPlacement: (id) => {
    set(state => ({
      pendingPlacements: state.pendingPlacements.filter(p => p.id !== id),
    }));
  },
  
  confirmAllPlacements: () => {
    const placements = get().pendingPlacements;
    set({ pendingPlacements: [] });
    return placements;
  },
  
  rejectAllPlacements: () => {
    set({ pendingPlacements: [] });
  },
}));

// Selectors
export const selectIsOpen = (state: AIChatState) => state.isOpen;
export const selectMessages = (state: AIChatState) => state.messages;
export const selectIsLoading = (state: AIChatState) => state.isLoading;
export const selectSelectedTrade = (state: AIChatState) => state.selectedTrade;
export const selectPlacementMode = (state: AIChatState) => state.placementMode;
export const selectPipelineStatus = (state: AIChatState) => state.pipelineStatus;
export const selectPendingPlacements = (state: AIChatState) => state.pendingPlacements;
export const selectHasPendingPlacements = (state: AIChatState) => state.pendingPlacements.length > 0;

let persistTimer: ReturnType<typeof setTimeout> | null = null;
useAIChatStore.subscribe(state => {
  if (!state.conversationHydrated || !state.conversation || !state.conversationContextId) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const current = useAIChatStore.getState();
    if (!current.conversation || !current.conversationContextId) return;
    const updatedAt = new Date().toISOString();
    void writeAssistantSnapshot({
      id: current.conversation.id,
      contextId: current.conversationContextId,
      conversation: { ...current.conversation, trade: current.selectedTrade, updatedAt },
      messages: current.messages,
      runs: Object.values(current.runs),
      approvals: Object.values(current.approvals),
      updatedAt,
    });
  }, 250);
});
