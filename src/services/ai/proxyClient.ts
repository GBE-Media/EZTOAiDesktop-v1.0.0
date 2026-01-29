/**
 * AI Proxy Client
 * Handles communication with the Supabase Edge Function AI proxy
 */

import { externalAuthClient } from '@/integrations/external-auth/client';
import type { AICompletionResponse, AIProviderType } from './providers/types';

const AI_PROXY_URL = 'https://einpdmanlpadqyqnvccb.supabase.co/functions/v1/ai-proxy';

export interface ProxyRequest {
  provider: AIProviderType;
  model: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system';
    content: string;
    images?: string[];
  }>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
}

export interface ProxyResponse {
  content: string;
  model: string;
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
  };
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
      throw new Error('AI service not found. The Edge Function needs to be deployed. Please contact support.');
    }
    throw new Error(`AI service error (${response.status}). Please try again later.`);
  }

  let data: unknown;
  try {
    data = await response.json();
  } catch (parseError) {
    console.error('[AI Proxy] JSON parse error:', parseError);
    throw new Error('Invalid response from AI service. Please try again.');
  }

  console.log('[AI Proxy] Response status:', response.status);

  if (!response.ok) {
    const errorData = data as { error?: string; details?: unknown };
    console.error('[AI Proxy] Error response:', errorData);

    // Check for rate limit error
    if (response.status === 429) {
      const rateLimitError = data as RateLimitError;
      throw new Error(
        `Rate limit exceeded. You've used ${rateLimitError.details?.currentTokens?.toLocaleString() || '?'} of ${rateLimitError.details?.tokenLimit?.toLocaleString() || '?'} tokens this month.`
      );
    }

    // Check for auth error
    if (response.status === 401) {
      throw new Error('Session expired. Please log in again.');
    }

    throw new Error(errorData.error || `AI request failed (${response.status})`);
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
    finishReason: 'stop',
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
