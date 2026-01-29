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

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

const OPENAI_MODELS: AIModelInfo[] = [
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
  {
    id: 'gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    capabilities: ['text', 'vision', 'structured-output', 'function-calling', 'code'],
    contextWindow: 128000,
    supportsVision: true,
    supportsStructuredOutput: true,
    costPer1kTokens: { input: 0.00015, output: 0.0006 },
  },
  {
    id: 'gpt-4-turbo',
    name: 'GPT-4 Turbo',
    provider: 'openai',
    capabilities: ['text', 'vision', 'function-calling', 'code', 'reasoning'],
    contextWindow: 128000,
    supportsVision: true,
    supportsStructuredOutput: false,
    costPer1kTokens: { input: 0.01, output: 0.03 },
  },
  {
    id: 'gpt-4',
    name: 'GPT-4',
    provider: 'openai',
    capabilities: ['text', 'function-calling', 'code', 'reasoning'],
    contextWindow: 8192,
    supportsVision: false,
    supportsStructuredOutput: false,
    costPer1kTokens: { input: 0.03, output: 0.06 },
  },
  {
    id: 'gpt-3.5-turbo',
    name: 'GPT-3.5 Turbo',
    provider: 'openai',
    capabilities: ['text', 'function-calling', 'code'],
    contextWindow: 16385,
    supportsVision: false,
    supportsStructuredOutput: false,
    costPer1kTokens: { input: 0.0005, output: 0.0015 },
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
        return 'gpt-4o'; // Best for image analysis
      case 'estimation':
        return 'gpt-4o'; // Good reasoning for estimation
      case 'placement':
        return 'gpt-4o'; // Structured output for coordinates
      default:
        return 'gpt-4o';
    }
  }

  async complete(request: AICompletionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('OpenAI API key not configured');
    }

    const model = request.model || 'gpt-4o';
    
    const messages = request.messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
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

    return {
      content: choice?.message?.content || '',
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      finishReason: choice?.finish_reason as AICompletionResponse['finishReason'],
    };
  }

  async vision(request: AIVisionRequest): Promise<AICompletionResponse> {
    if (!this.isConfigured()) {
      throw new Error('OpenAI API key not configured');
    }

    const model = request.model || 'gpt-4o';
    
    // Build messages with images
    const messages = request.messages.map(msg => {
      if (msg.role === 'user' && msg.images && msg.images.length > 0) {
        // Create content array with text and images
        const content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];
        
        // Add text content
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        
        // Add image content
        for (const image of msg.images) {
          content.push({
            type: 'image_url',
            image_url: {
              url: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
              detail: 'high', // Use high detail for blueprint analysis
            },
          });
        }
        
        return { role: msg.role, content };
      }
      
      return { role: msg.role, content: msg.content };
    });

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: request.temperature ?? 0.3, // Lower temperature for vision accuracy
      max_tokens: request.maxTokens ?? 4096,
    };

    if (request.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
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

    return {
      content: choice?.message?.content || '',
      model: data.model,
      usage: data.usage ? {
        promptTokens: data.usage.prompt_tokens,
        completionTokens: data.usage.completion_tokens,
        totalTokens: data.usage.total_tokens,
      } : undefined,
      finishReason: choice?.finish_reason as AICompletionResponse['finishReason'],
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
