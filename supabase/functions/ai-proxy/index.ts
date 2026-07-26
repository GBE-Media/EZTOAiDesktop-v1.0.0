/**
 * AI Proxy Edge Function
 * Proxies AI requests to OpenAI/Anthropic with company API keys
 * Handles authentication, rate limiting, and usage tracking
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
    role: 'user' | 'assistant' | 'system';
    content: string;
    images?: string[];
  }>;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json';
  tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  toolChoice?: 'auto' | 'none' | { name: string };
}

interface RateLimitResult {
  within_limits: boolean;
  current_tokens: number;
  current_requests: number;
  token_limit: number;
  request_limit: number;
  tier: string;
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
  // Build OpenAI messages format
  const openaiMessages = messages.map(msg => {
    // Handle vision (images)
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];
      
      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }
      
      for (const image of msg.images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
            detail: 'high',
          },
        });
      }
      
      return { role: msg.role, content };
    }
    
    return { role: msg.role, content: msg.content };
  });

  const body: Record<string, unknown> = {
    model,
    messages: openaiMessages,
    temperature: temperature ?? 0.7,
  };

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
  // The Lovable AI Gateway is OpenAI-compatible; model IDs are namespaced,
  // e.g. "openai/gpt-5.6-sol" or "google/gemini-3.1-pro-preview".
  const gatewayMessages = messages.map(msg => {
    if (msg.role === 'user' && msg.images && msg.images.length > 0) {
      const content: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [];

      if (msg.content) {
        content.push({ type: 'text', text: msg.content });
      }

      for (const image of msg.images) {
        content.push({
          type: 'image_url',
          image_url: {
            url: image.startsWith('data:') ? image : `data:image/png;base64,${image}`,
            detail: 'high',
          },
        });
      }

      return { role: msg.role, content };
    }

    return { role: msg.role, content: msg.content };
  });

  const body: Record<string, unknown> = {
    model,
    messages: gatewayMessages,
    temperature: temperature ?? 0.7,
    max_completion_tokens: maxTokens ?? 16384,
  };

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
  // Extract system message
  const systemMessage = messages.find(m => m.role === 'system')?.content;
  
  // Build Anthropic messages format
  const anthropicMessages = messages
    .filter(m => m.role !== 'system')
    .map(msg => {
      // Handle vision (images)
      if (msg.role === 'user' && msg.images && msg.images.length > 0) {
        const content: Array<{
          type: string;
          text?: string;
          source?: { type: string; media_type: string; data: string };
        }> = [];
        
        // Add images first
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
            source: {
              type: 'base64',
              media_type: mediaType,
              data: base64Data,
            },
          });
        }
        
        // Add text
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        
        return { role: msg.role, content };
      }
      
      return { role: msg.role, content: msg.content };
    });

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
