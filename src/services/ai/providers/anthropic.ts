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

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

const ANTHROPIC_MODELS: AIModelInfo[] = [
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    contextWindow: 200000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.003, output: 0.015 },
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    contextWindow: 200000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.003, output: 0.015 },
  },
  {
    id: 'claude-3-opus-20240229',
    name: 'Claude 3 Opus',
    provider: 'anthropic',
    capabilities: ['text', 'vision', 'code', 'reasoning'],
    contextWindow: 200000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.015, output: 0.075 },
  },
  {
    id: 'claude-3-haiku-20240307',
    name: 'Claude 3 Haiku',
    provider: 'anthropic',
    capabilities: ['text', 'vision', 'code'],
    contextWindow: 200000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.00025, output: 0.00125 },
  },
];

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
        return 'claude-sonnet-4-20250514'; // Excellent vision capabilities
      case 'estimation':
        return 'claude-sonnet-4-20250514'; // Best reasoning for construction estimation
      case 'placement':
        return 'claude-3-haiku-20240307'; // Fast and accurate for structured output
      default:
        return 'claude-sonnet-4-20250514';
    }
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('Anthropic API key not configured');
    }

    const model = request.model || 'claude-sonnet-4-20250514';
    
    // Extract system message if present
    const systemMessage = request.messages.find(m => m.role === 'system')?.content;
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(msg => ({
        role: msg.role as 'user' | 'assistant',
        content: msg.content,
      }));

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.7,
    };

    if (systemMessage) {
      body.system = systemMessage;
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

    return {
      content: data.content?.[0]?.text || '',
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason,
    };
  }

  async vision(request: AIVisionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('Anthropic API key not configured');
    }

    const model = request.model || 'claude-sonnet-4-20250514';
    
    // Extract system message if present
    const systemMessage = request.messages.find(m => m.role === 'system')?.content;
    
    // Build messages with images
    const messages = request.messages
      .filter(m => m.role !== 'system')
      .map(msg => {
        if (msg.role === 'user' && msg.images && msg.images.length > 0) {
          // Create content array with images and text
          const content: Array<{
            type: string;
            text?: string;
            source?: {
              type: string;
              media_type: string;
              data: string;
            };
          }> = [];
          
          // Add images first (Anthropic prefers images before text)
          for (const image of msg.images) {
            // Extract base64 data and media type
            let mediaType = 'image/png';
            let base64Data = image;
            
            if (image.startsWith('data:')) {
              const match = image.match(/^data:([^;]+);base64,(.+)$/);
              if (match) {
                mediaType = match[1];
                base64Data = match[2];
              }
            }
            
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data,
              },
            });
          }
          
          // Add text content
          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }
          
          return { role: msg.role as 'user' | 'assistant', content };
        }
        
        return { role: msg.role as 'user' | 'assistant', content: msg.content };
      });

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: request.maxTokens ?? 4096,
      temperature: request.temperature ?? 0.3, // Lower temperature for vision accuracy
    };

    if (systemMessage) {
      body.system = systemMessage;
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

    return {
      content: data.content?.[0]?.text || '',
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: data.usage.input_tokens + data.usage.output_tokens,
      } : undefined,
      finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason,
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
