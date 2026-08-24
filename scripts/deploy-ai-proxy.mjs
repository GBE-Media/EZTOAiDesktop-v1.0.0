#!/usr/bin/env node
/**
 * Deploy the ai-proxy Edge Function to the Supabase project the desktop app calls.
 *
 * Usage:
 *   npm run deploy:ai-proxy
 *
 * Requires:
 *   - Supabase CLI available (`npx supabase` is fine)
 *   - SUPABASE_ACCESS_TOKEN (or an interactive `supabase login`)
 *   - Optional: SUPABASE_PROJECT_REF (overrides auto-detection)
 *
 * Project ref resolution order:
 *   1. SUPABASE_PROJECT_REF
 *   2. Hostname in src/services/ai/proxyClient.ts AI_PROXY_URL (production app target)
 *   3. project_id in supabase/config.toml
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function readProxyClientProjectRef() {
  const path = join(root, 'src', 'services', 'ai', 'proxyClient.ts');
  if (!existsSync(path)) return null;
  const source = readFileSync(path, 'utf8');
  const match = source.match(/https:\/\/([a-z0-9]+)\.supabase\.co\/functions\/v1\/ai-proxy/i);
  return match?.[1] || null;
}

function readConfigTomlProjectRef() {
  const path = join(root, 'supabase', 'config.toml');
  if (!existsSync(path)) return null;
  const source = readFileSync(path, 'utf8');
  const match = source.match(/^\s*project_id\s*=\s*"([^"]+)"/m);
  return match?.[1] || null;
}

function resolveProjectRef() {
  if (process.env.SUPABASE_PROJECT_REF?.trim()) {
    return process.env.SUPABASE_PROJECT_REF.trim();
  }
  const fromProxy = readProxyClientProjectRef();
  if (fromProxy) {
    console.log(`[deploy:ai-proxy] Using project ref from proxyClient.ts: ${fromProxy}`);
    return fromProxy;
  }
  const fromToml = readConfigTomlProjectRef();
  if (fromToml) {
    console.log(`[deploy:ai-proxy] Using project ref from supabase/config.toml: ${fromToml}`);
    return fromToml;
  }
  throw new Error(
    'Could not resolve Supabase project ref. Set SUPABASE_PROJECT_REF or ensure proxyClient.ts / supabase/config.toml are present.',
  );
}

const EXPECTED_PROJECT_REF = 'einpdmanlpadqyqnvccb';

const projectRef = resolveProjectRef();
if (projectRef !== EXPECTED_PROJECT_REF) {
  console.error(
    `[deploy:ai-proxy] Refusing to deploy: resolved project ref "${projectRef}" ` +
    `does not match the live app project "${EXPECTED_PROJECT_REF}". ` +
    'Check SUPABASE_PROJECT_REF / proxyClient.ts / supabase/config.toml.',
  );
  process.exit(1);
}

console.log(`[deploy:ai-proxy] Deploying function "ai-proxy" to project "${projectRef}"…`);
console.log('[deploy:ai-proxy] Reminder: merge alone does NOT update production — this deploy step is required.');

try {
  execFileSync(
    'npx',
    ['supabase', 'functions', 'deploy', 'ai-proxy', '--project-ref', projectRef],
    { stdio: 'inherit', cwd: root, shell: true, env: process.env },
  );
  console.log('[deploy:ai-proxy] Deploy finished successfully.');
} catch (error) {
  console.error('[deploy:ai-proxy] Deploy failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
