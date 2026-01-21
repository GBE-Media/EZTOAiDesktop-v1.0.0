// External Supabase client for authentication against the web app project
import { createClient } from '@supabase/supabase-js';

const EXTERNAL_SUPABASE_URL =
  import.meta.env.VITE_EXTERNAL_SUPABASE_URL ||
  'https://einpdmanlpadqyqnvccb.supabase.co';
const EXTERNAL_SUPABASE_ANON_KEY =
  import.meta.env.VITE_EXTERNAL_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVpbnBkbWFubHBhZHF5cW52Y2NiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUxMjU4OTYsImV4cCI6MjA4MDcwMTg5Nn0.3D-GgnpM-jf8-mUSRqcjFK6QP_OOXWaANtozQqalszA';

// This client authenticates against the external project (eztoai.thebemedia.com)
// while the main supabase client handles this project's backend features
export const externalAuthClient = createClient(EXTERNAL_SUPABASE_URL, EXTERNAL_SUPABASE_ANON_KEY, {
  auth: {
    storage: localStorage,
    persistSession: true,
    autoRefreshToken: true,
    storageKey: 'external-auth-session', // Separate storage to avoid conflicts
  }
});
