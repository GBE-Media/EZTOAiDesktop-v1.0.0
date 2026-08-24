/**
 * AI Proxy Edge Function
 * Proxies AI requests to OpenAI/Anthropic with company API keys
 * Handles authentication, rate limiting, and usage tracking
 *
 * IMPORTANT: Changes to this file require running `npm run deploy:ai-proxy`
 * (or equivalent) to take effect in production. Committing/merging alone
 * does NOT deploy this Edge Function — the desktop app calls a fixed
 * already-deployed Supabase Function URL (see src/services/ai/proxyClient.ts).
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.38.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') || '';
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';
const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY') || '';

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// Lovable AI Gateway - OpenAI-compatible chat completions endpoint serving
// models like "openai/gpt-5.6-sol" and "google/gemini-3.1-pro-preview".
const LOVABLE_API_URL = 'https://ai.gateway.lovable.dev/v1/chat/completions';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface AIRequest {
  provider: 'openai' | 'anthropic' | 'lovable';
  model: string;
  messages: Array<{
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    images?: string[];
    toolCallId?: string;
    name?: string;
    toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  }>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  toolChoice?: 'auto' | 'none' | { name: string };
}

type ProxyMessage = AIRequest['messages'][number];

/** OpenAI / Lovable: role "tool" + tool_call_id. */
function toOpenAIMessages(messages: ProxyMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId || msg.name || 'tool_call',
        content: msg.content ?? '',
        ...(msg.name ? { name: msg.name } : {}),
      });
      continue;
    }
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: msg.content || '',
        tool_calls: msg.toolCalls.map(call => {
          const input = (call as { input?: unknown; arguments?: unknown }).input
            ?? (call as { arguments?: unknown }).arguments
            ?? {};
          return {
            id: call.id,
            type: 'function',
            function: {
              name: call.name,
              arguments: typeof input === 'string' ? input : JSON.stringify(input ?? {}),
            },
          };
        }),
      });
      continue;
    }
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const image of msg.images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
            detail: 'high',
          },
        });
      }
      out.push({ role: 'user', content });
      continue;
    }
    out.push({ role: msg.role, content: msg.content ?? '' });
  }
  return out;
}

/**
 * Anthropic: no "tool" role — tool results are user messages with tool_result blocks.
 * Consecutive tool messages are merged into one user message.
 */
function toAnthropicMessages(messages: ProxyMessage[]): {
  system?: string;
  messages: unknown[];
} {
  const system = messages.find(m => m.role === 'system')?.content;
  const out: unknown[] = [];
  let pendingTools: ProxyMessage[] = [];

  const flushTools = () => {
    if (pendingTools.length === 0) return;
    out.push({
      role: 'user',
      content: pendingTools.map(msg => ({
        type: 'tool_result',
        tool_use_id: msg.toolCallId || msg.name || 'tool_call',
        content: msg.content ?? '',
      })),
    });
    pendingTools = [];
  };

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'tool') {
      pendingTools.push(msg);
      continue;
    }
    flushTools();
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (msg.content?.trim()) blocks.push({ type: 'text', text: msg.content });
      for (const call of msg.toolCalls) {
        const rawInput = (call as { input?: unknown; arguments?: unknown }).input
          ?? (call as { arguments?: unknown }).arguments
          ?? {};
        let input: unknown = rawInput;
        if (typeof rawInput === 'string') {
          try { input = JSON.parse(rawInput); } catch { input = {}; }
        }
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const content: Array<Record<string, unknown>> = [];
      for (const image of msg.images) {
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
          source: { type: 'base64', media_type: mediaType, data: base64Data },
        });
      }
      if (msg.content) content.push({ type: 'text', text: msg.content });
      out.push({ role: 'user', content });
      continue;
    }
    out.push({ role: msg.role, content: msg.content ?? '' });
  }
  flushTools();
  return { system, messages: out };
}

interface RateLimitResult {
  within_limits: boolean;
  current_tokens: number;
  current_requests: number;
  token_limit: number;
  request_limit: number;
  tier: string;
  window_label?: string;
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Validate request method
    if (req.method !== 'POST') {
      return new Response(
        JSON.stringify({ error: 'Method not allowed' }),
        { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Get authorization header
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing or invalid authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');

    // Create Supabase client to validate token
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Verify the user's token
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse request body
    const body: AIRequest = await req.json();
    const { provider, model, messages, temperature, maxTokens, responseFormat, tools, toolChoice } = body;

    // Validate required fields
    if (!provider || !model || !messages || messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: provider, model, messages' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Check rate limits
    const { data: rateLimitData, error: rateLimitError } = await supabase
      .rpc('check_ai_rate_limit', { p_user_id: user.id });

    if (rateLimitError) {
      console.error('Rate limit check error:', rateLimitError);
      // Continue without rate limiting if check fails
    } else if (rateLimitData && rateLimitData.length > 0) {
      const rateLimit: RateLimitResult = rateLimitData[0];
      
      if (!rateLimit.within_limits) {
        return new Response(
          JSON.stringify({
            error: 'Rate limit exceeded',
            details: {
              currentTokens: rateLimit.current_tokens,
              tokenLimit: rateLimit.token_limit,
              currentRequests: rateLimit.current_requests,
              requestLimit: rateLimit.request_limit,
              tier: rateLimit.tier,
              windowLabel: rateLimit.window_label || 'in the last 24 hours',
            },
          }),
          { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Make the AI request
    let aiResponse: Response;
    let tokensInput = 0;
    let tokensOutput = 0;

    if (provider === 'openai') {
      aiResponse = await callOpenAI(model, messages, temperature, maxTokens, responseFormat, tools, toolChoice);
    } else if (provider === 'anthropic') {
      aiResponse = await callAnthropic(model, messages, temperature, maxTokens, tools, toolChoice);
    } else if (provider === 'lovable') {
      aiResponse = await callLovable(model, messages, temperature, maxTokens, responseFormat, tools, toolChoice);
    } else {
      return new Response(
        JSON.stringify({ error: `Unsupported provider: ${provider}` }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Parse AI response
    const aiData = await aiResponse.json();

    if (!aiResponse.ok) {
      return new Response(
        JSON.stringify({ error: aiData.error?.message || 'AI provider error', details: aiData }),
        { status: aiResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Extract token usage (the Lovable gateway is OpenAI-compatible)
    if (provider === 'openai' || provider === 'lovable') {
      tokensInput = aiData.usage?.prompt_tokens || 0;
      tokensOutput = aiData.usage?.completion_tokens || 0;
    } else if (provider === 'anthropic') {
      tokensInput = aiData.usage?.input_tokens || 0;
      tokensOutput = aiData.usage?.output_tokens || 0;
    }

    // Update usage tracking
    if (tokensInput > 0 || tokensOutput > 0) {
      await supabase.rpc('upsert_ai_usage', {
        p_user_id: user.id,
        p_provider: provider,
        p_model: model,
        p_tokens_input: tokensInput,
        p_tokens_output: tokensOutput,
      });
    }

    // Format response consistently
    let content = '';
    let toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
    if (provider === 'openai' || provider === 'lovable') {
      content = aiData.choices?.[0]?.message?.content || '';
      toolCalls = (aiData.choices?.[0]?.message?.tool_calls || []).map((call: any) => ({
        id: call.id,
        name: call.function?.name,
        input: (() => {
          try { return JSON.parse(call.function?.arguments || '{}'); } catch { return {}; }
        })(),
      }));
    } else if (provider === 'anthropic') {
      content = (aiData.content || [])
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text)
        .join('\n');
      toolCalls = (aiData.content || [])
        .filter((block: any) => block.type === 'tool_use')
        .map((block: any) => ({ id: block.id, name: block.name, input: block.input }));
    }

    return new Response(
      JSON.stringify({
        content,
        model: aiData.model || model,
        finishReason: provider === 'anthropic'
          ? aiData.stop_reason
          : aiData.choices?.[0]?.finish_reason,
        toolCalls,
        usage: {
          promptTokens: tokensInput,
          completionTokens: tokensOutput,
          totalTokens: tokensInput + tokensOutput,
        },
        provider,
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('AI Proxy error:', error);
    return new Response(
      JSON.stringify({ error: error.message || 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

async function callOpenAI(
  model: string,
  messages: AIRequest['messages'],
  temperature?: number,
  maxTokens?: number,
  responseFormat?: string,
  tools?: AIRequest['tools'],
  toolChoice?: AIRequest['toolChoice']
): Promise<Response> {
  const openaiMessages = toOpenAIMessages(messages);

  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages,
  };

  // gpt-5 / o-series reject custom temperature — omit rather than send 0.2/0.7.
  if (!/^(gpt-5|o1|o3|o4)(\b|[.-])/i.test(model)) {
    body.temperature = temperature ?? 0.7;
  }

  if (/^gpt-5/i.test(model)) {
    body.max_completion_tokens = maxTokens ?? 16384;
  } else {
    body.max_tokens = maxTokens ?? 4096;
  }

  if (responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }
  if (tools?.length) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    body.tool_choice = toolChoice === 'none'
      ? 'none'
      : typeof toolChoice === 'object'
        ? { type: 'function', function: { name: toolChoice.name } }
        : 'auto';
  }

  return fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function callLovable(
  model: string,
  messages: AIRequest['messages'],
  temperature?: number,
  maxTokens?: number,
  responseFormat?: string,
  tools?: AIRequest['tools'],
  toolChoice?: AIRequest['toolChoice']
): Promise<Response> {
  // Lovable AI Gateway is OpenAI-compatible (including tool role messages).
  const gatewayMessages = toOpenAIMessages(messages);

  const body: Record<string, unknown> = {
    model,
    messages: gatewayMessages,
    max_completion_tokens: maxTokens ?? 16384,
  };

  // openai/gpt-5* (and bare gpt-5*) via Lovable also reject custom temperature.
  if (!/(^|\/)(gpt-5|o1|o3|o4)(\b|[.-])/i.test(model)) {
    body.temperature = temperature ?? 0.7;
  }

  if (responseFormat === 'json') {
    body.response_format = { type: 'json_object' };
  }
  if (tools?.length) {
    body.tools = tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
    body.tool_choice = toolChoice === 'none'
      ? 'none'
      : typeof toolChoice === 'object'
        ? { type: 'function', function: { name: toolChoice.name } }
        : 'auto';
  }

  return fetch(LOVABLE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LOVABLE_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

async function callAnthropic(
  model: string,
  messages: AIRequest['messages'],
  temperature?: number,
  maxTokens?: number,
  tools?: AIRequest['tools'],
  toolChoice?: AIRequest['toolChoice']
): Promise<Response> {
  const { system: systemMessage, messages: anthropicMessages } = toAnthropicMessages(messages);

  const body: Record<string, unknown> = {
    model,
    messages: anthropicMessages,
    max_tokens: maxTokens ?? 4096,
    temperature: temperature ?? 0.7,
  };

  if (systemMessage) {
    body.system = systemMessage;
  }
  if (tools?.length && toolChoice !== 'none') {
    body.tools = tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
    body.tool_choice = typeof toolChoice === 'object'
      ? { type: 'tool', name: toolChoice.name }
      : { type: 'auto' };
  }

  return fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
}
