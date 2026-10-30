/**
 * Lovable AI Gateway Provider
 * Frontier models (OpenAI GPT-6 and 5.x, Google Gemini 4 and 3.x) served through the
 * Lovable AI Gateway and billed as workspace credits. Requests are made with
 * { provider: 'lovable', model: 'openai/gpt-6.1-sol', ... } via the ai-proxy
 * Edge Function; there is no direct (local API key) call path.
 */

import type {
  AIProvider,
  AIProviderType,
  AICompletionRequest,
  AICompletionResponse,
  AIVisionRequest,
  AIModelInfo,
  PipelineStage,
} from './types';

const LOVABLE_MODELS: AIModelInfo[] = [
  {
    id: 'openai/gpt-6.1-sol',
    name: 'GPT-6.1 Sol (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 1050000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.002, output: 0.01 },
  },
  {
    id: 'openai/gpt-6-astra',
    name: 'GPT-6 Astra (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 1050000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.01, output: 0.05 },
  },
  {
    id: 'openai/gpt-6-luna',
    name: 'GPT-6 Luna (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code'],
    contextWindow: 1050000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.0001, output: 0.0005 },
  },
  {
    id: 'google/gemini-4-argon',
    name: 'Gemini 4 Argon (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 1000000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.002, output: 0.01 },
  },
  {
    id: 'openai/gpt-5.6-sol',
    name: 'GPT-5.6 Sol (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 1050000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.004, output: 0.02 },
  },
  {
    id: 'openai/gpt-5.6-terra',
    name: 'GPT-5.6 Terra (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 1050000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.0025, output: 0.015 },
  },
  {
    id: 'openai/gpt-5.6-luna',
    name: 'GPT-5.6 Luna (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code'],
    contextWindow: 1050000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.0005, output: 0.002 },
  },
  {
    id: 'openai/gpt-5.5',
    name: 'GPT-5.5 (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 400000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.00125, output: 0.01 },
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro Preview (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 1000000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.002, output: 0.012 },
  },
  {
    id: 'google/gemini-3.6-flash',
    name: 'Gemini 3.6 Flash (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code'],
    contextWindow: 1000000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.0003, output: 0.0025 },
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    name: 'Gemini 3.1 Flash Lite (Lovable)',
    provider: 'lovable',
    capabilities: ['text', 'vision', 'structured-output', 'code'],
    contextWindow: 1000000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.0001, output: 0.0004 },
  },
];

export class LovableProvider implements AIProvider {
  name: AIProviderType = 'lovable';

  setApiKey(_apiKey: string) {
    // Gateway credentials live server-side (LOVABLE_API_KEY on the Edge
    // Function); nothing to store locally.
  }

  isConfigured(): boolean {
    // Available whenever the proxy is - the gateway key is managed server-side.
    return true;
  }

  getModels(): AIModelInfo[] {
    return LOVABLE_MODELS;
  }

  getDefaultModel(stage: PipelineStage): string {
    switch (stage) {
      case 'vision':
        return 'openai/gpt-6.1-sol';
      case 'estimation':
        return 'openai/gpt-6.1-sol';
      case 'placement':
        return 'openai/gpt-6.1-sol';
      default:
        return 'openai/gpt-6.1-sol';
    }
  }

  async complete(_request: AICompletionRequest): Promise<AICompletionResponse> {
    throw new Error('Lovable gateway models are only available through the AI proxy.');
  }

  async vision(_request: AIVisionRequest): Promise<AICompletionResponse> {
    throw new Error('Lovable gateway models are only available through the AI proxy.');
  }
}

// Singleton instance
let lovableProvider: LovableProvider | null = null;

export function getLovableProvider(): LovableProvider {
  if (!lovableProvider) {
    lovableProvider = new LovableProvider();
  }
  return lovableProvider;
}
