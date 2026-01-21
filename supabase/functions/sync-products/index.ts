import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ProductFolder {
  id: string;
  name: string;
  parentId: string | null;
  expanded: boolean;
}

interface ProductComponent {
  id: string;
  name: string;
  quantity: number;
  unit: string;
  notes?: string;
}

interface ProductMeasurement {
  id: string;
  markupId: string;
  documentId: string;
  page: number;
  type: string;
  value: number;
  unit: string;
  groupId?: string;
  groupLabel?: string;
}

interface Product {
  id: string;
  name: string;
  folderId: string | null;
  description: string;
  unitOfMeasure: string;
  components: ProductComponent[];
  measurements: ProductMeasurement[];
}

interface SyncPayload {
  folders: ProductFolder[];
  products: Product[];
}

async function verifyExternalToken(token: string): Promise<{ userId: string } | null> {
  // Verify token against external Supabase auth
  const externalUrl = 'https://einpdmanlpadqyqnvccb.supabase.co';
  const externalAnonKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpbnBkbWFubHBhZHF5cW52Y2NiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxMjU4OTYsImV4cCI6MjA4MDcwMTg5Nn0.3D-GgnpM-jf8-mUSRqcjFK6QP_OOXWaANtozQqalszA';
  
  const externalClient = createClient(externalUrl, externalAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  
  const { data, error } = await externalClient.auth.getUser(token);
  if (error || !data.user) {
    console.error('Token verification failed:', error);
    return null;
  }
  
  return { userId: data.user.id };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const authResult = await verifyExternalToken(token);
    
    if (!authResult) {
      return new Response(
        JSON.stringify({ error: 'Invalid token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const userId = authResult.userId;
    
    // Create Supabase client for this project (using service role for RLS bypass)
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const url = new URL(req.url);
    const method = req.method;

    // GET - Load user's products
    if (method === 'GET') {
      const [foldersRes, productsRes, componentsRes, measurementsRes] = await Promise.all([
        supabase.from('product_folders').select('*').eq('user_id', userId),
        supabase.from('products').select('*').eq('user_id', userId),
        supabase.from('product_components').select('*'),
        supabase.from('product_measurements').select('*'),
      ]);

      if (foldersRes.error || productsRes.error) {
        throw new Error(foldersRes.error?.message || productsRes.error?.message);
      }

      // Get product IDs for filtering components and measurements
      const productIds = productsRes.data?.map(p => p.id) || [];
      
      // Filter components and measurements to only include those belonging to user's products
      const components = componentsRes.data?.filter(c => productIds.includes(c.product_id)) || [];
      const measurements = measurementsRes.data?.filter(m => productIds.includes(m.product_id)) || [];

      return new Response(
        JSON.stringify({
          folders: foldersRes.data || [],
          products: productsRes.data || [],
          components,
          measurements,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // POST - Sync products (full replace)
    if (method === 'POST') {
      const payload: SyncPayload = await req.json();
      
      // Delete existing data for user
      await supabase.from('product_folders').delete().eq('user_id', userId);
      await supabase.from('products').delete().eq('user_id', userId);
      
      // Insert folders (need to handle parent references)
      if (payload.folders.length > 0) {
        // First pass: insert folders without parent references
        const foldersToInsert = payload.folders.map(f => ({
          id: f.id,
          user_id: userId,
          name: f.name,
          parent_id: null, // Set to null initially
          expanded: f.expanded,
        }));
        
        const { error: folderError } = await supabase
          .from('product_folders')
          .insert(foldersToInsert);
        
        if (folderError) {
          console.error('Folder insert error:', folderError);
          throw new Error(`Failed to insert folders: ${folderError.message}`);
        }
        
        // Second pass: update parent references
        for (const folder of payload.folders) {
          if (folder.parentId) {
            await supabase
              .from('product_folders')
              .update({ parent_id: folder.parentId })
              .eq('id', folder.id);
          }
        }
      }
      
      // Insert products
      if (payload.products.length > 0) {
        const productsToInsert = payload.products.map(p => ({
          id: p.id,
          user_id: userId,
          folder_id: p.folderId,
          name: p.name,
          description: p.description || '',
          unit_of_measure: p.unitOfMeasure || 'each',
        }));
        
        const { error: productError } = await supabase
          .from('products')
          .insert(productsToInsert);
        
        if (productError) {
          console.error('Product insert error:', productError);
          throw new Error(`Failed to insert products: ${productError.message}`);
        }
        
        // Insert components
        const allComponents = payload.products.flatMap(p => 
          (p.components || []).map(c => ({
            id: c.id,
            product_id: p.id,
            name: c.name,
            quantity: c.quantity || 1,
            unit: c.unit || '',
            notes: c.notes || '',
          }))
        );
        
        if (allComponents.length > 0) {
          const { error: compError } = await supabase
            .from('product_components')
            .insert(allComponents);
          
          if (compError) {
            console.error('Component insert error:', compError);
          }
        }
        
        // Insert measurements
        const allMeasurements = payload.products.flatMap(p => 
          (p.measurements || []).map(m => ({
            id: m.id,
            product_id: p.id,
            markup_id: m.markupId,
            document_id: m.documentId,
            page: m.page,
            measurement_type: m.type,
            value: m.value,
            unit: m.unit,
            group_id: m.groupId || null,
            group_label: m.groupLabel || '',
          }))
        );
        
        if (allMeasurements.length > 0) {
          const { error: measError } = await supabase
            .from('product_measurements')
            .insert(allMeasurements);
          
          if (measError) {
            console.error('Measurement insert error:', measError);
          }
        }
      }
      
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
    
  } catch (error) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : 'Internal server error';
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
