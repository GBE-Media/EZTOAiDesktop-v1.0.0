/**
 * AI Settings Store
 * Manages AI configuration, API keys, and model preferences
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AIProviderType, PipelineStage, TradeType } from '@/services/ai/providers/types';
import { getAIService } from '@/services/ai/aiService';

export interface ModelSelection {
  provider: AIProviderType;
  model: string;
}

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
  
  // Default preferences
  defaultTrade: TradeType;
  defaultPlacementMode: 'auto' | 'confirm';
  enableSmartSuggestions: boolean;
  
  // Feature toggles
  showCodeReferences: boolean;
  showConfidenceScores: boolean;
  autoExtractLocation: boolean;
}

interface AISettingsState extends AISettings {
  // Loading state
  isLoading: boolean;
  isInitialized: boolean;
  
  // Actions
  setApiKey: (provider: AIProviderType, key: string) => void;
  clearApiKey: (provider: AIProviderType) => void;
  
  setPipelineModel: (stage: PipelineStage, selection: ModelSelection) => void;
  
  setDefaultTrade: (trade: TradeType) => void;
  setDefaultPlacementMode: (mode: 'auto' | 'confirm') => void;
  setEnableSmartSuggestions: (enabled: boolean) => void;
  
  setShowCodeReferences: (show: boolean) => void;
  setShowConfidenceScores: (show: boolean) => void;
  setAutoExtractLocation: (enabled: boolean) => void;
  
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

const DEFAULT_SETTINGS: AISettings = {
  apiKeys: {},
  pipelineModels: DEFAULT_PIPELINE_MODELS,
  defaultTrade: 'electrical',
  defaultPlacementMode: 'confirm',
  enableSmartSuggestions: true,
  showCodeReferences: true,
  showConfidenceScores: false,
  autoExtractLocation: true,
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
      
      // Default preferences
      setDefaultTrade: (trade) => set({ defaultTrade: trade }),
      setDefaultPlacementMode: (mode) => set({ defaultPlacementMode: mode }),
      setEnableSmartSuggestions: (enabled) => set({ enableSmartSuggestions: enabled }),
      
      // Feature toggles
      setShowCodeReferences: (show) => set({ showCodeReferences: show }),
      setShowConfidenceScores: (show) => set({ showConfidenceScores: show }),
      setAutoExtractLocation: (enabled) => set({ autoExtractLocation: enabled }),
      
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
          
          // Apply the persisted (or default) pipeline model selection to the
          // live AIService singleton, since it otherwise only ever uses its
          // own hardcoded defaults until a settings change fires.
          applyPipelineModelsToService(get().pipelineModels);

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
        pipelineModels: state.pipelineModels,
        defaultTrade: state.defaultTrade,
        defaultPlacementMode: state.defaultPlacementMode,
        enableSmartSuggestions: state.enableSmartSuggestions,
        showCodeReferences: state.showCodeReferences,
        showConfidenceScores: state.showConfidenceScores,
        autoExtractLocation: state.autoExtractLocation,
      }),
      // Merge stored state with defaults to handle missing/corrupt data
      merge: (persistedState, currentState) => {
        const persisted = persistedState as Partial<AISettings> | undefined;
        
        // Ensure pipelineModels has all required fields
        const pipelineModels = {
          vision: persisted?.pipelineModels?.vision || DEFAULT_PIPELINE_MODELS.vision,
          estimation: persisted?.pipelineModels?.estimation || DEFAULT_PIPELINE_MODELS.estimation,
          placement: persisted?.pipelineModels?.placement || DEFAULT_PIPELINE_MODELS.placement,
        };
        
        // Remap stale persisted selections onto the models the backend
        // actually serves. Without this, users who already have settings
        // saved in localStorage would stay pinned to broken IDs forever,
        // since persisted values normally take precedence over new defaults.
        const STALE_OPENAI_TO_LOVABLE = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']);
        const RETIRED_OPENAI_MODELS = new Set(['gpt-4o-mini', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo']);
        const STALE_ANTHROPIC_REMAP: Record<string, string> = {
          'claude-opus-4-8': 'claude-opus-4-5',
          'claude-sonnet-4-20250514': 'claude-sonnet-4-5',
          'claude-sonnet-4-5-20250514': 'claude-sonnet-4-5',
          'claude-3-5-sonnet-20241022': 'claude-sonnet-4-5',
          'claude-3-opus-20240229': 'claude-opus-4-5',
          'claude-3-haiku-20240307': 'claude-haiku-4-5',
        };
        (['vision', 'estimation', 'placement'] as const).forEach((stage) => {
          const selection = pipelineModels[stage];
          if (selection.provider === 'openai' && STALE_OPENAI_TO_LOVABLE.has(selection.model)) {
            // 5.6-series models moved behind the Lovable AI Gateway.
            pipelineModels[stage] = { provider: 'lovable', model: `openai/${selection.model}` };
          } else if (selection.provider === 'openai' && RETIRED_OPENAI_MODELS.has(selection.model)) {
            pipelineModels[stage] = { provider: 'openai', model: 'gpt-5' };
          } else if (selection.provider === 'anthropic' && STALE_ANTHROPIC_REMAP[selection.model]) {
            pipelineModels[stage] = { provider: 'anthropic', model: STALE_ANTHROPIC_REMAP[selection.model] };
          }
        });
        
        return {
          ...currentState,
          ...persisted,
          pipelineModels,
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
