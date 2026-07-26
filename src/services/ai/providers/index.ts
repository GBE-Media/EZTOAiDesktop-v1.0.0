/**
 * AI Providers Index
 * Export all providers and utilities
 */

export * from './types';
export { OpenAIProvider, getOpenAIProvider } from './openai';
export { AnthropicProvider, getAnthropicProvider } from './anthropic';
export { LovableProvider, getLovableProvider } from './lovable';

import type { AIProvider, AIProviderType } from './types';
import { getOpenAIProvider } from './openai';
import { getAnthropicProvider } from './anthropic';
import { getLovableProvider } from './lovable';

/**
 * Get a provider instance by type
 */
export function getProvider(type: AIProviderType): AIProvider {
  switch (type) {
    case 'openai':
      return getOpenAIProvider();
    case 'anthropic':
      return getAnthropicProvider();
    case 'lovable':
      return getLovableProvider();
    case 'gemini':
      // TODO: Implement Gemini provider
      throw new Error('Gemini provider not yet implemented');
    default:
      throw new Error(`Unknown provider type: ${type}`);
  }
}

/**
 * Get all available providers
 */
export function getAllProviders(): AIProvider[] {
  return [
    getLovableProvider(),
    getOpenAIProvider(),
    getAnthropicProvider(),
  ];
}

/**
 * Check if any provider is configured
 */
export function hasConfiguredProvider(): boolean {
  return getAllProviders().some(p => p.isConfigured());
}
