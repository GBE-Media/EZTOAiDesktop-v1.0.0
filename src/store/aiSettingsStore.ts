/**
 * AI Settings Store
 * Manages AI configuration, API keys, and model preferences
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AIProviderType, PipelineStage, TradeType } from '@/services/ai/providers/types';
import { getAIService } from '@/services/ai/aiService';
import {
  DEFAULT_AGENT_MODELS,
  type AgentModelRole,
  type AgentModelSelection,
  type AgentModelsConfig,
} from '@/services/ai/agent/roles';

export type { AgentModelSelection };
export type ModelSelection = AgentModelSelection;

export interface AISettings {
  // API Keys (stored separately in secure storage for Electron)
  apiKeys: {
    openai?: string;
    anthropic?: string;
    gemini?: string;
  };
  
  // Pipeline model configuration
  pipelineModels: {
    vision: ModelSelection;
    estimation: ModelSelection;
    placement: ModelSelection;
  };

  /** Agent orchestration roles (router / primary / verifier / fallback). */
  agentModels: AgentModelsConfig;
  
  // Default preferences
  defaultTrade: TradeType;
  defaultPlacementMode: 'auto' | 'confirm';
  enableSmartSuggestions: boolean;
  
  // Feature toggles
  showCodeReferences: boolean;
  showConfidenceScores: boolean;
  autoExtractLocation: boolean;

  // Chat display controls (Lovable-like chrome)
  showActivityTimeline: boolean;
  showEvidenceCitations: boolean;
  showModelStageChips: boolean;
  /** Draw OCR/proposal/anchor debug overlay on the PDF canvas. */
  showPlacementDebug: boolean;
}

interface AISettingsState extends AISettings {
  // Loading state
  isLoading: boolean;
  isInitialized: boolean;
  
  // Actions
  setApiKey: (provider: AIProviderType, key: string) => void;
  clearApiKey: (provider: AIProviderType) => void;
  
  setPipelineModel: (stage: PipelineStage, selection: ModelSelection) => void;
  setAgentModel: (role: AgentModelRole, selection: ModelSelection) => void;
  
  setDefaultTrade: (trade: TradeType) => void;
  setDefaultPlacementMode: (mode: 'auto' | 'confirm') => void;
  setEnableSmartSuggestions: (enabled: boolean) => void;
  
  setShowCodeReferences: (show: boolean) => void;
  setShowConfidenceScores: (show: boolean) => void;
  setAutoExtractLocation: (enabled: boolean) => void;
  setShowActivityTimeline: (show: boolean) => void;
  setShowEvidenceCitations: (show: boolean) => void;
  setShowModelStageChips: (show: boolean) => void;
  setShowPlacementDebug: (show: boolean) => void;
  
  // Initialization
  initialize: () => Promise<void>;
  saveToSecureStorage: () => Promise<void>;
  
  // Helpers
  isProviderConfigured: (provider: AIProviderType) => boolean;
  hasAnyProvider: () => boolean;
}

const DEFAULT_PIPELINE_MODELS = {
  vision: { provider: 'lovable' as AIProviderType, model: 'openai/gpt-5.6-sol' },
  estimation: { provider: 'anthropic' as AIProviderType, model: 'claude-opus-4-5' },
  placement: { provider: 'lovable' as AIProviderType, model: 'openai/gpt-5.6-sol' },
};

function applyPipelineModelsToService(pipelineModels: AISettings['pipelineModels']) {
  getAIService().setPipelineConfig({
    visionModel: pipelineModels.vision,
    estimationModel: pipelineModels.estimation,
    placementModel: pipelineModels.placement,
  });
}

function applyAgentModelsToService(agentModels: AgentModelsConfig) {
  getAIService().setAgentModels(agentModels);
}

const DEFAULT_SETTINGS: AISettings = {
  apiKeys: {},
  pipelineModels: DEFAULT_PIPELINE_MODELS,
  agentModels: { ...DEFAULT_AGENT_MODELS },
  defaultTrade: 'electrical',
  defaultPlacementMode: 'confirm',
  enableSmartSuggestions: true,
  showCodeReferences: true,
  showConfidenceScores: false,
  autoExtractLocation: true,
  showActivityTimeline: true,
  showEvidenceCitations: true,
  showModelStageChips: true,
  showPlacementDebug: true,
};

export const useAISettingsStore = create<AISettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULT_SETTINGS,
      isLoading: false,
      isInitialized: false,
      
      // API Key management
      setApiKey: (provider, key) => {
        set(state => ({
          apiKeys: { ...state.apiKeys, [provider]: key },
        }));
        // Also save to secure storage
        get().saveToSecureStorage();
      },
      
      clearApiKey: (provider) => {
        set(state => {
          const newKeys = { ...state.apiKeys };
          delete newKeys[provider];
          return { apiKeys: newKeys };
        });
        get().saveToSecureStorage();
      },
      
      // Pipeline model configuration
      setPipelineModel: (stage, selection) => {
        set(state => ({
          pipelineModels: {
            ...state.pipelineModels,
            [stage]: selection,
          },
        }));
        // Propagate to the live AIService immediately so the change actually
        // takes effect on the next request, not just in the persisted UI state.
        applyPipelineModelsToService({ ...get().pipelineModels, [stage]: selection });
      },

      setAgentModel: (role, selection) => {
        set(state => ({
          agentModels: {
            ...state.agentModels,
            [role]: selection,
          },
        }));
        applyAgentModelsToService({ ...get().agentModels, [role]: selection });
      },
      
      // Default preferences
      setDefaultTrade: (trade) => set({ defaultTrade: trade }),
      setDefaultPlacementMode: (mode) => set({ defaultPlacementMode: mode }),
      setEnableSmartSuggestions: (enabled) => set({ enableSmartSuggestions: enabled }),
      
      // Feature toggles
      setShowCodeReferences: (show) => set({ showCodeReferences: show }),
      setShowConfidenceScores: (show) => set({ showConfidenceScores: show }),
      setAutoExtractLocation: (enabled) => set({ autoExtractLocation: enabled }),
      setShowActivityTimeline: (show) => set({ showActivityTimeline: show }),
      setShowEvidenceCitations: (show) => set({ showEvidenceCitations: show }),
      setShowModelStageChips: (show) => set({ showModelStageChips: show }),
      setShowPlacementDebug: (show) => set({ showPlacementDebug: show }),
      
      // Initialization - load API keys from Electron secure storage
      initialize: async () => {
        set({ isLoading: true });
        
        try {
          // Check if running in Electron
          if (window.electronAPI) {
            // Try to load stored API keys from secure storage
            const storedSession = await window.electronAPI.getStoredSession();
            if (storedSession) {
              try {
                const sessionData = JSON.parse(storedSession);
                if (sessionData.aiApiKeys) {
                  set({ apiKeys: sessionData.aiApiKeys });
                }
              } catch {
                // Ignore parse errors
              }
            }
          }
          
          // Models are subscription-managed — always apply product defaults,
          // ignoring any previously persisted user picks from the old dropdowns.
          const pipelineModels = { ...DEFAULT_PIPELINE_MODELS };
          const agentModels = { ...DEFAULT_AGENT_MODELS };
          set({ pipelineModels, agentModels });
          applyPipelineModelsToService(pipelineModels);
          applyAgentModelsToService(agentModels);

          set({ isInitialized: true });
        } catch (error) {
          console.error('Failed to initialize AI settings:', error);
        } finally {
          set({ isLoading: false });
        }
      },
      
      // Save API keys to Electron secure storage
      saveToSecureStorage: async () => {
        if (!window.electronAPI) return;
        
        try {
          const storedSession = await window.electronAPI.getStoredSession();
          let sessionData: Record<string, unknown> = {};
          
          if (storedSession) {
            try {
              sessionData = JSON.parse(storedSession);
            } catch {
              // Start fresh if parse fails
            }
          }
          
          // Add AI API keys to session data
          sessionData.aiApiKeys = get().apiKeys;
          
          await window.electronAPI.storeSession(JSON.stringify(sessionData));
        } catch (error) {
          console.error('Failed to save AI settings to secure storage:', error);
        }
      },
      
      // Helpers
      isProviderConfigured: (provider) => {
        const key = get().apiKeys[provider];
        if (!key) return false;
        
        switch (provider) {
          case 'openai':
            return key.startsWith('sk-');
          case 'anthropic':
            return key.startsWith('sk-ant-');
          case 'gemini':
            return key.length > 0;
          default:
            return false;
        }
      },
      
      hasAnyProvider: () => {
        const state = get();
        return (
          state.isProviderConfigured('openai') ||
          state.isProviderConfigured('anthropic') ||
          state.isProviderConfigured('gemini')
        );
      },
    }),
    {
      name: 'ai-settings-storage',
      // Don't persist API keys in localStorage - they go to secure storage
      partialize: (state) => ({
        // Models are managed by BidveraAi — do not persist user overrides.
        defaultTrade: state.defaultTrade,
        defaultPlacementMode: state.defaultPlacementMode,
        enableSmartSuggestions: state.enableSmartSuggestions,
        showCodeReferences: state.showCodeReferences,
        showConfidenceScores: state.showConfidenceScores,
        autoExtractLocation: state.autoExtractLocation,
        showActivityTimeline: state.showActivityTimeline,
        showEvidenceCitations: state.showEvidenceCitations,
        showModelStageChips: state.showModelStageChips,
        showPlacementDebug: state.showPlacementDebug,
      }),
      // Merge stored state with defaults to handle missing/corrupt data
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AISettings> | undefined;

        return {
          ...currentState,
          ...persisted,
          // Always use product-managed model defaults (ignore old dropdown picks).
          pipelineModels: { ...DEFAULT_PIPELINE_MODELS },
          agentModels: { ...DEFAULT_AGENT_MODELS },
          showActivityTimeline: persisted?.showActivityTimeline ?? currentState.showActivityTimeline,
          showEvidenceCitations: persisted?.showEvidenceCitations ?? currentState.showEvidenceCitations,
          showModelStageChips: persisted?.showModelStageChips ?? currentState.showModelStageChips,
          showPlacementDebug: persisted?.showPlacementDebug ?? currentState.showPlacementDebug,
        };
      },
    }
  )
);

// Selectors
export const selectApiKeys = (state: AISettingsState) => state.apiKeys;
export const selectPipelineModels = (state: AISettingsState) => state.pipelineModels;
export const selectDefaultTrade = (state: AISettingsState) => state.defaultTrade;
export const selectIsInitialized = (state: AISettingsState) => state.isInitialized;
export const selectHasAnyProvider = (state: AISettingsState) => state.hasAnyProvider();
