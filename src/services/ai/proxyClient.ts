/**
 * AI Proxy Client
 * Handles communication with the Supabase Edge Function AI proxy
 */

import { externalAuthClient } from '@/integrations/external-auth/client';
import type {
  AICompletionResponse,
  AIProviderType,
  AIToolCall,
  AIToolDefinition,
} from './providers/types';
import { formatRateLimitExceededMessage } from './rateLimitMessage';

export { formatRateLimitExceededMessage } from './rateLimitMessage';

const AI_PROXY_URL = 'https://einpdmanlpadqyqnvccb.supabase.co/functions/v1/ai-proxy';

export interface ProxyRequest {
  provider: AIProviderType;
  model: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    images?: string[];
    toolCallId?: string;
    name?: string;
    toolCalls?: AIToolCall[];
  }>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  tools?: AIToolDefinition[];
  toolChoice?: 'auto' | 'none' | { name: string };
}

export interface ProxyResponse {
  content: string;
  model: string;
  finishReason?: string;
  toolCalls?: AIToolCall[];
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  provider: AIProviderType;
}

export interface RateLimitError {
  error: string;
  details: {
    currentTokens: number;
    tokenLimit: number;
    currentRequests: number;
    requestLimit: number;
    tier: string;
    /** e.g. "in the last 24 hours" — optional for older proxies */
    windowLabel?: string;
  };
}

/**
 * Thrown when the proxy responds with a non-2xx status. Carries the HTTP
 * status code so callers can decide whether a request is worth retrying
 * against a fallback model/provider (e.g. 400/404/500) versus a
 * user-actionable failure that no amount of retrying will fix (401 auth,
 * 429 rate-limit, 413 payload-too-large).
 */
export class ProxyRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ProxyRequestError';
    this.status = status;
  }
}

/**
 * Send a request through the AI proxy
 */
export async function sendProxyRequest(request: ProxyRequest): Promise<AICompletionResponse> {
  // Get current session token
  const { data: { session }, error: sessionError } = await externalAuthClient.auth.getSession();
  
  if (sessionError || !session) {
    throw new Error('Not authenticated. Please log in to use AI features.');
  }

  let response: Response;
  try {
    console.log('[AI Proxy] Sending request to:', AI_PROXY_URL);
    response = await fetch(AI_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(request),
    });
  } catch (networkError) {
    console.error('[AI Proxy] Network error:', networkError);
    throw new Error('AI service unavailable. The Edge Function may not be deployed yet. Please contact support.');
  }

  // Check for non-JSON responses (like 404 HTML pages)
  const contentType = response.headers.get('content-type');
  if (!contentType?.includes('application/json')) {
    console.error('[AI Proxy] Non-JSON response:', response.status, contentType);
    if (response.status === 404) {
      throw new ProxyRequestError('AI service not found. The Edge Function needs to be deployed. Please contact support.', response.status);
    }
    throw new ProxyRequestError(`AI service error (${response.status}). Please try again later.`, response.status);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (parseError) {
    console.error('[AI Proxy] JSON parse error:', parseError);
    throw new ProxyRequestError('Invalid response from AI service. Please try again.', response.status);
  }

  console.log('[AI Proxy] Response status:', response.status);

  if (!response.ok) {
    const errorData = data as { error?: string; details?: unknown };
    console.error('[AI Proxy] Error response:', errorData);

    // Check for rate limit error
    if (response.status === 429) {
      const rateLimitError = data as RateLimitError;
      throw new ProxyRequestError(
        formatRateLimitExceededMessage(rateLimitError.details),
        response.status
      );
    }

    // Check for auth error
    if (response.status === 401) {
      throw new ProxyRequestError('Session expired. Please log in again.', response.status);
    }

    if (response.status === 413) {
      throw new ProxyRequestError('The blueprint image payload is too large. Reduce the selected page area and try again.', response.status);
    }

    throw new ProxyRequestError(errorData.error || `AI request failed (${response.status})`, response.status);
  }

  const proxyResponse = data as ProxyResponse;

  if (!proxyResponse.content) {
    console.warn('[AI Proxy] Empty content in response:', proxyResponse);
  }

  return {
    content: proxyResponse.content || '',
    model: proxyResponse.model || request.model,
    usage: {
      promptTokens: proxyResponse.usage?.promptTokens || 0,
      completionTokens: proxyResponse.usage?.completionTokens || 0,
      totalTokens: proxyResponse.usage?.totalTokens || 0,
    },
    finishReason: proxyResponse.finishReason === 'length' || proxyResponse.finishReason === 'max_tokens'
      ? 'length'
      : proxyResponse.finishReason === 'content_filter'
        ? 'content_filter'
        : 'stop',
    toolCalls: proxyResponse.toolCalls || [],
  };
}

/**
 * Check if the proxy is available (user is authenticated)
 */
export async function isProxyAvailable(): Promise<boolean> {
  try {
    const { data: { session } } = await externalAuthClient.auth.getSession();
    return !!session;
  } catch {
    return false;
  }
}

/**
 * Get current usage stats
 */
export async function getUsageStats(): Promise<{
  tokensUsed: number;
  tokenLimit: number;
  requestsUsed: number;
  requestLimit: number;
  tier: string;
} | null> {
  try {
    const { data: { session } } = await externalAuthClient.auth.getSession();
    if (!session) return null;

    // Call a usage endpoint (could be added to the proxy or a separate function)
    // For now, return null - usage is tracked server-side
    return null;
  } catch {
    return null;
  }
}
