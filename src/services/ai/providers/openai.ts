/**
 * OpenAI Provider Implementation
 * Supports GPT-4 Vision, GPT-4, and other OpenAI models
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
import { toOpenAIChatMessages } from './toolMessageAdapters';
import { resolveRequestTemperature } from './modelRequestConstraints';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const OPENAI_MODELS: AIModelInfo[] = [
  {
    id: 'gpt-5',
    name: 'GPT-5',
    provider: 'openai',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 400000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.00125, output: 0.01 },
  },
  {
    id: 'gpt-5-mini',
    name: 'GPT-5 Mini',
    provider: 'openai',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code'],
    contextWindow: 400000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.00025, output: 0.002 },
  },
  {
    id: 'gpt-5-nano',
    name: 'GPT-5 Nano',
    provider: 'openai',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code'],
    contextWindow: 400000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.00005, output: 0.0004 },
  },
  {
    id: 'gpt-4.1',
    name: 'GPT-4.1',
    provider: 'openai',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 1000000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.002, output: 0.008 },
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code', 'reasoning'],
    contextWindow: 128000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.005, output: 0.015 },
  },
];

export class OpenAIProvider implements AIProvider {
  name: AIProviderType = 'openai';
  private apiKey: string | null = null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || null;
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.startsWith('sk-');
  }

  getModels(): AIModelInfo[] {
    return OPENAI_MODELS;
  }

  getDefaultModel(stage: PipelineStage): string {
    switch (stage) {
      case 'vision':
        return 'gpt-5'; // Strongest direct-API vision + reasoning
      case 'estimation':
        return 'gpt-5'; // Strongest reasoning for estimation
      case 'placement':
        return 'gpt-5'; // Structured output for coordinates
      default:
        return 'gpt-5';
    }
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('OpenAI API key not configured');
    }

    const model = request.model || 'gpt-5';
    const messages = toOpenAIChatMessages(request.messages);
    const temperature = resolveRequestTemperature(model, request.temperature ?? 0.7);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };
    if (temperature != null) body.temperature = temperature;

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    if (request.tools?.length) {
      body.tools = request.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = request.toolChoice === 'none'
        ? 'none'
        : typeof request.toolChoice === 'object'
          ? { type: 'function', function: { name: request.toolChoice.name } }
          : 'auto';
    }

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`OpenAI API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls || []).map((call: {
      id: string;
      function?: { name?: string; arguments?: string };
    }) => ({
      id: call.id,
      name: call.function?.name || '',
      input: (() => {
        try { return JSON.parse(call.function?.arguments || '{}'); } catch { return {}; }
      })(),
    }));

    return {
      content: choice?.message?.content || '',
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      finishReason: choice?.finish_reason as AICompletionResponse['finishReason'],
      toolCalls,
    };
  }

  async vision(request: AIVisionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('OpenAI API key not configured');
    }

    const model = request.model || 'gpt-5';
    const messages = toOpenAIChatMessages(request.messages);
    const temperature = resolveRequestTemperature(model, request.temperature ?? 0.3);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
    };
    if (temperature != null) body.temperature = temperature;

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }
    if (request.tools?.length) {
      body.tools = request.tools.map(tool => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      body.tool_choice = request.toolChoice === 'none'
        ? 'none'
        : typeof request.toolChoice === 'object'
          ? { type: 'function', function: { name: request.toolChoice.name } }
          : 'auto';
    }

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`OpenAI Vision API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const toolCalls = (choice?.message?.tool_calls || []).map((call: {
      id: string;
      function?: { name?: string; arguments?: string };
    }) => ({
      id: call.id,
      name: call.function?.name || '',
      input: (() => {
        try { return JSON.parse(call.function?.arguments || '{}'); } catch { return {}; }
      })(),
    }));

    return {
      content: choice?.message?.content || '',
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      finishReason: choice?.finish_reason as AICompletionResponse['finishReason'],
      toolCalls,
    };
  }
}

// Singleton instance
let openaiProvider: OpenAIProvider | null = null;

export function getOpenAIProvider(): OpenAIProvider {
  if (!openaiProvider) {
    openaiProvider = new OpenAIProvider();
  }
  return openaiProvider;
}
