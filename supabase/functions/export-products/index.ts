import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Get the API key and endpoint from secrets
    const apiKey = Deno.env.get('ESTIMATE_API_KEY')
    const apiEndpoint = Deno.env.get('ESTIMATE_API_ENDPOINT')

    if (!apiKey || !apiEndpoint) {
      return new Response(
        JSON.stringify({ 
          error: 'Export not configured. Please set ESTIMATE_API_KEY and ESTIMATE_API_ENDPOINT secrets.' 
        }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Parse the incoming payload
    const payload = await req.json()

    if (!payload.projectName || !payload.products) {
      return new Response(
        JSON.stringify({ error: 'Invalid payload: missing projectName or products' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Forward the request to the estimate project with API key authentication
    const response = await fetch(apiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    })

    const responseData = await response.json()

    if (!response.ok) {
      console.error('Estimate API error:', responseData)
      return new Response(
        JSON.stringify({ 
          error: responseData.error || `Export failed with status ${response.status}`,
          details: responseData.details
        }),
        { status: response.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: `Successfully exported ${payload.products.length} products`,
        projectName: payload.projectName,
        exportedAt: new Date().toISOString(),
        response: responseData
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (error) {
    console.error('Export error:', error)
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return new Response(
      JSON.stringify({ error: 'Internal server error', details: errorMessage }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
