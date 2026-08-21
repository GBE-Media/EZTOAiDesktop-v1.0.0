#!/usr/bin/env node
/**
 * CI guard: if supabase/functions/ai-proxy/index.ts changed vs base, fail with a
 * deploy reminder. Does not perform the deploy (credentials usually unavailable in CI).
 */

import { execFileSync } from 'node:child_process';

const TARGET = 'supabase/functions/ai-proxy/index.ts';
const base = process.env.GITHUB_BASE_REF
  ? `origin/${process.env.GITHUB_BASE_REF}`
  : (process.env.AI_PROXY_DIFF_BASE || 'origin/main');

function changedFiles() {
  try {
    execFileSync('git', ['fetch', '--depth=1', 'origin', process.env.GITHUB_BASE_REF || 'main'], {
      stdio: 'ignore',
    });
  } catch {
    // Best-effort fetch; diff may still work against local base.
  }

  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8',
    });
    return out.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch (error) {
    console.warn('[check-ai-proxy-deploy] Could not diff against base; skipping hard fail.', error);
    return [];
  }
}

const files = changedFiles();
if (files.includes(TARGET)) {
  console.error('');
  console.error(`ERROR: ${TARGET} changed in this PR/branch.`);
  console.error('Merging alone does NOT update the live Edge Function the desktop app calls.');
  console.error('After merge (or now, with credentials), run:');
  console.error('  npm run deploy:ai-proxy');
  console.error('Or set SUPABASE_PROJECT_REF / SUPABASE_ACCESS_TOKEN and deploy manually.');
  console.error('');
  process.exit(1);
}

console.log(`[check-ai-proxy-deploy] OK — ${TARGET} unchanged vs ${base}.`);
