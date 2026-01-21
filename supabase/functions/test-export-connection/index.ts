import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const apiKey = Deno.env.get('ESTIMATE_API_KEY')
    const apiEndpoint = Deno.env.get('ESTIMATE_API_ENDPOINT')

    // Check if secrets are configured
    if (!apiKey) {
      return new Response(
        JSON.stringify({
          configured: false,
          status: 'error',
          message: 'ESTIMATE_API_KEY is not configured',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!apiEndpoint) {
      return new Response(
        JSON.stringify({
          configured: false,
          status: 'error',
          message: 'ESTIMATE_API_ENDPOINT is not configured',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Validate URL format before parsing
    let endpointUrl: URL
    try {
      endpointUrl = new URL(apiEndpoint)
    } catch {
      return new Response(
        JSON.stringify({
          configured: true,
          status: 'error',
          message: `Invalid URL format: "${apiEndpoint}". Please use a full URL like https://example.com/api/endpoint`,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Mask the endpoint for display (show domain only)
    const maskedEndpoint = `${endpointUrl.protocol}//${endpointUrl.hostname}/***`

    // Try a lightweight OPTIONS request to check if endpoint is reachable
    try {
      const testResponse = await fetch(apiEndpoint, {
        method: 'OPTIONS',
        headers: {
          'Content-Type': 'application/json',
        },
      })

      // If we get any response (even 4xx for OPTIONS), the endpoint is reachable
      return new Response(
        JSON.stringify({
          configured: true,
          status: 'ready',
          endpoint: maskedEndpoint,
          message: 'API connection is configured and ready',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } catch (fetchError) {
      // Endpoint is not reachable
      return new Response(
        JSON.stringify({
          configured: true,
          status: 'error',
          endpoint: maskedEndpoint,
          message: 'Could not reach the API endpoint. Please verify the URL is correct.',
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

  } catch (error) {
    console.error('Test connection error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return new Response(
      JSON.stringify({ 
        configured: false, 
        status: 'error', 
        message: `Test failed: ${errorMessage}` 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
