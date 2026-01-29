/**
 * AI Settings Store
 * Manages AI configuration, API keys, and model preferences
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AIProviderType, PipelineStage, TradeType } from '@/services/ai/providers/types';

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
  vision: { provider: 'openai' as AIProviderType, model: 'gpt-4o' },
  estimation: { provider: 'anthropic' as AIProviderType, model: 'claude-sonnet-4-20250514' },
  placement: { provider: 'openai' as AIProviderType, model: 'gpt-4o' },
};

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
        
        // Migrate invalid model IDs back to valid ones
        if (pipelineModels.estimation.model === 'claude-sonnet-4-5-20250514') {
          pipelineModels.estimation.model = 'claude-sonnet-4-20250514';
        }
        
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
