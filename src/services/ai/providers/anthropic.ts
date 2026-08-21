/**
 * Anthropic Provider Implementation
 * Supports Claude Sonnet 4, Claude 3.5 Sonnet, and other Claude models
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
import { toAnthropicChatMessages } from './toolMessageAdapters';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const ANTHROPIC_MODELS: AIModelInfo[] = [
  {
    id: 'claude-opus-4-7',
    name: 'Claude Opus 4.7',
    provider: 'anthropic',
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    contextWindow: 1000000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.005, output: 0.025 },
  },
  {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    contextWindow: 1000000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.003, output: 0.015 },
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    capabilities: ['text', 'vision', 'code'],
    contextWindow: 200000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.001, output: 0.005 },
  },
];

/** Default Anthropic model ID — must remain in ANTHROPIC_MODELS. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-4-7';

export { ANTHROPIC_MODELS };
export class AnthropicProvider implements AIProvider {
  name: AIProviderType = 'anthropic';
  private apiKey: string | null = null;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || null;
  }

  setApiKey(apiKey: string) {
    this.apiKey = apiKey;
  }

  isConfigured(): boolean {
    return !!this.apiKey && this.apiKey.startsWith('sk-ant-');
  }

  getModels(): AIModelInfo[] {
    return ANTHROPIC_MODELS;
  }

  getDefaultModel(stage: PipelineStage): string {
    switch (stage) {
      case 'vision':
        return DEFAULT_ANTHROPIC_MODEL;
      case 'estimation':
        return DEFAULT_ANTHROPIC_MODEL;
      case 'placement':
        return DEFAULT_ANTHROPIC_MODEL;
      default:
        return DEFAULT_ANTHROPIC_MODEL;
    }
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('Anthropic API key not configured');
    }

    const model = request.model || DEFAULT_ANTHROPIC_MODEL;
    const { system: systemMessage, messages } = toAnthropicChatMessages(request.messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (systemMessage) {
      body.system = systemMessage;
    }
    if (request.tools?.length && request.toolChoice !== 'none') {
      body.tools = request.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      body.tool_choice = typeof request.toolChoice === 'object'
        ? { type: 'tool', name: request.toolChoice.name }
        : { type: 'auto' };
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Anthropic API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const contentBlocks = data.content || [];
    const content = contentBlocks
      .filter((block: { type?: string }) => block.type === 'text')
      .map((block: { text?: string }) => block.text || '')
      .join('\n');
    const toolCalls = contentBlocks
      .filter((block: { type?: string }) => block.type === 'tool_use')
      .map((block: { id: string; name: string; input: unknown }) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }));

    return {
      content,
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason,
      toolCalls,
    };
  }

  async vision(request: AIVisionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('Anthropic API key not configured');
    }

    const model = request.model || DEFAULT_ANTHROPIC_MODEL;
    const { system: systemMessage, messages } = toAnthropicChatMessages(request.messages);

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.3, // Lower temperature for vision accuracy
    };

    if (systemMessage) {
      body.system = systemMessage;
    }
    if (request.tools?.length && request.toolChoice !== 'none') {
      body.tools = request.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
      body.tool_choice = typeof request.toolChoice === 'object'
        ? { type: 'tool', name: request.toolChoice.name }
        : { type: 'auto' };
    }

    const response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey!,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Anthropic Vision API error: ${error.error?.message || response.statusText}`);
    }

    const data = await response.json();
    const contentBlocks = data.content || [];
    const content = contentBlocks
      .filter((block: { type?: string }) => block.type === 'text')
      .map((block: { text?: string }) => block.text || '')
      .join('\n');
    const toolCalls = contentBlocks
      .filter((block: { type?: string }) => block.type === 'tool_use')
      .map((block: { id: string; name: string; input: unknown }) => ({
        id: block.id,
        name: block.name,
        input: block.input,
      }));

    return {
      content,
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason,
      toolCalls,
    };
  }
}

// Singleton instance
let anthropicProvider: AnthropicProvider | null = null;

export function getAnthropicProvider(): AnthropicProvider {
  if (!anthropicProvider) {
    anthropicProvider = new AnthropicProvider();
  }
  return anthropicProvider;
}
