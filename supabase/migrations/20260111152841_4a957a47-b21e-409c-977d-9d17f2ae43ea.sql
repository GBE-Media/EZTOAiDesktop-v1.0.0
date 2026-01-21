-- Create product_folders table
CREATE TABLE public.product_folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id UUID REFERENCES public.product_folders(id) ON DELETE CASCADE,
  expanded BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create products table
CREATE TABLE public.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  folder_id UUID REFERENCES public.product_folders(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  unit_of_measure TEXT DEFAULT 'each',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create product_components table
CREATE TABLE public.product_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE NOT NULL,
  name TEXT NOT NULL,
  quantity NUMERIC DEFAULT 1,
  unit TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create product_measurements table
CREATE TABLE public.product_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID REFERENCES public.products(id) ON DELETE CASCADE NOT NULL,
  markup_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  measurement_type TEXT NOT NULL,
  value NUMERIC NOT NULL,
  unit TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS on all tables
ALTER TABLE public.product_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_measurements ENABLE ROW LEVEL SECURITY;

-- Create policies for service role access (edge functions will handle auth)
CREATE POLICY "Service role full access to folders" ON public.product_folders FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to products" ON public.products FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to components" ON public.product_components FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access to measurements" ON public.product_measurements FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Create indexes for better query performance
CREATE INDEX idx_product_folders_user_id ON public.product_folders(user_id);
CREATE INDEX idx_products_user_id ON public.products(user_id);
CREATE INDEX idx_products_folder_id ON public.products(folder_id);
CREATE INDEX idx_product_components_product_id ON public.product_components(product_id);
CREATE INDEX idx_product_measurements_product_id ON public.product_measurements(product_id);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add triggers for updated_at
CREATE TRIGGER update_product_folders_updated_at
  BEFORE UPDATE ON public.product_folders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_products_updated_at
  BEFORE UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();