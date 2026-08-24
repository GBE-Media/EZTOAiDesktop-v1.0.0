#!/usr/bin/env node
/**
 * CI reminder: if supabase/functions/ai-proxy/index.ts changed vs base, emit a
 * visible deploy warning. Does NOT fail the job — PRs that legitimately change
 * the edge function must still get green CI; deploy remains a human post-merge
 * step (`npm run deploy:ai-proxy`).
 *
 * In GitHub Actions, prints a ::warning:: annotation. Locally, prints to stderr
 * and exits 0 either way.
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
    console.warn('[check-ai-proxy-deploy] Could not diff against base; skipping reminder.', error);
    return [];
  }
}

const files = changedFiles();
if (files.includes(TARGET)) {
  const message = [
    `${TARGET} changed in this PR/branch.`,
    'Merging alone does NOT update the live Edge Function the desktop app calls.',
    'After merge, run: npm run deploy:ai-proxy',
    '(Requires SUPABASE_ACCESS_TOKEN; optional SUPABASE_PROJECT_REF — see scripts/deploy-ai-proxy.mjs.)',
  ].join(' ');

  // Non-blocking GitHub Actions annotation (does not fail the step).
  console.log(`::warning file=${TARGET},title=ai-proxy deploy required::${message}`);
  console.warn('');
  console.warn(`[check-ai-proxy-deploy] WARNING: ${message}`);
  console.warn('[check-ai-proxy-deploy] CI continues (reminder only — not a hard failure).');
  console.warn('');
  process.exit(0);
}

console.log(`[check-ai-proxy-deploy] OK — ${TARGET} unchanged vs ${base}.`);
process.exit(0);
