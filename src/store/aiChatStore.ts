/**
 * AI Chat Store
 * Manages AI chat state, message history, and pipeline status
 */

import { create } from 'zustand';
import type { TradeType, PipelineStage } from '@/services/ai/providers/types';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
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
  
  // Actions
  openDrawer: () => void;
  closeDrawer: () => void;
  toggleDrawer: () => void;
  
  addMessage: (message: Omit<ChatMessage, 'id' | 'timestamp'>) => string;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  clearMessages: () => void;
  
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
    
    set(state => ({
      messages: [...state.messages, newMessage],
      isLoading: message.isLoading ?? false,
    }));
    
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
  
  clearMessages: () => set({ messages: [], pendingPlacements: [] }),
  
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
