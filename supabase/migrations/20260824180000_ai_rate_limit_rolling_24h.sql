-- Rolling 24-hour AI rate limits (replaces monthly window from 20260128000001).
-- Limits are applied by summing ai_usage EVENT rows with created_at in the last 24 hours.
--
-- NOTE: Applying this migration on the live Lovable-managed Supabase project
-- (einpdmanlpadqyqnvccb) is required for production — merging this file alone
-- does not change the live DB.
--
-- ============================================================================OVER POLICY (approach A — archive + delete):
-- The prior schema stored ONE monthly aggregate row per (user, provider, model,
-- period_start), bumping updated_at on each call while leaving created_at as the
-- first insert of the month. If we naively SUM(created_at >= now()-24h) against
-- those rows we would either:
--   • over-count (a fresh monthly aggregate created today carries a full month
--     of tokens into the 24h window), or
--   • under-count (an older aggregate's created_at is >24h ago so recent usage
--     inside that aggregate is invisible).
-- Rate limits are not a billing ledger. At cutover we ARCHIVE every existing
-- ai_usage row into ai_usage_legacy_monthly_archive and DELETE them from
-- ai_usage so the rolling-24h SUM starts from a clean slate (fresh window for
-- every user). New upserts append one event row per request.
--
-- Verification after first apply:
--   SELECT * FROM ai_usage_cutover_state;
--     → one row with cutover_completed_at and legacy_rows_archived
--   SELECT COUNT(*) FROM ai_usage;           -- 0 right after cutover
--   SELECT COUNT(*) FROM ai_usage_legacy_monthly_archive;
--     → equals legacy_rows_archived from the marker
--
-- Re-apply safety (second run of this file must be a no-op for data):
--   INSERT a fake event into ai_usage, re-run the cutover DO block (or whole file),
--   then confirm that fake row is STILL in ai_usage and archive row count is unchanged.

-- ---------------------------------------------------------------------------
-- 1) One-shot archive of legacy monthly aggregates BEFORE function changes
-- ---------------------------------------------------------------------------
-- LIKE ... INCLUDING DEFAULTS only (no CONSTRAINTS/INDEXES) so we do not collide
-- with live ai_usage constraint names on the same database.
CREATE TABLE IF NOT EXISTS ai_usage_legacy_monthly_archive (
  LIKE ai_usage INCLUDING DEFAULTS
);

COMMENT ON TABLE ai_usage_legacy_monthly_archive IS
  'Frozen copy of pre-rolling-24h monthly aggregate ai_usage rows. Not used by check_ai_rate_limit. Populated once at cutover then left untouched.';

-- Durable one-shot marker: at most one row ever (boolean PK default true + CHECK(id)).
CREATE TABLE IF NOT EXISTS ai_usage_cutover_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  cutover_completed_at TIMESTAMPTZ NOT NULL,
  legacy_rows_archived INTEGER NOT NULL
);

COMMENT ON TABLE ai_usage_cutover_state IS
  'Sentinel that the monthly→rolling-24h ai_usage cutover has already run. Presence of a row means archive+delete must never run again.';

-- Archive + delete ONLY on the first successful cutover. Re-running this migration
-- (or this DO block) must NOT move post-cutover event rows into the archive or
-- wipe live ai_usage — that would reset every user's rate-limit window.
DO $$
DECLARE
  v_archived INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM ai_usage_cutover_state) THEN
    RAISE NOTICE 'ai_usage rolling-24h cutover already completed; skipping archive+delete.';
    RETURN;
  END IF;

  INSERT INTO ai_usage_legacy_monthly_archive
  SELECT * FROM ai_usage
  WHERE NOT EXISTS (
    SELECT 1 FROM ai_usage_legacy_monthly_archive a WHERE a.id = ai_usage.id
  );

  GET DIAGNOSTICS v_archived = ROW_COUNT;

  DELETE FROM ai_usage;

  INSERT INTO ai_usage_cutover_state (id, cutover_completed_at, legacy_rows_archived)
  VALUES (TRUE, NOW(), v_archived);

  RAISE NOTICE 'ai_usage rolling-24h cutover complete; archived % legacy rows.', v_archived;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Provider + uniqueness changes for event-style rows
-- ---------------------------------------------------------------------------
-- Allow lovable gateway as a tracked provider (ai-proxy uses provider='lovable').
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_provider_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini', 'lovable'));

-- Drop monthly uniqueness so each request can be recorded as its own row.
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_user_id_provider_model_period_start_key;

-- Rename limit columns to reflect the 24h window (keep values until UPDATE below).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_rate_limits' AND column_name = 'monthly_token_limit'
  ) THEN
    ALTER TABLE ai_rate_limits RENAME COLUMN monthly_token_limit TO token_limit_24h;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_rate_limits' AND column_name = 'monthly_request_limit'
  ) THEN
    ALTER TABLE ai_rate_limits RENAME COLUMN monthly_request_limit TO request_limit_24h;
  END IF;
END $$;

-- Free: enough for heavy vision + multi-tool estimating in a workday.
-- Pro: matches the intended subscriber tier (5M tokens / 2000 requests / 24h).
UPDATE ai_rate_limits SET token_limit_24h = 1000000, request_limit_24h = 500 WHERE tier = 'free';
UPDATE ai_rate_limits SET token_limit_24h = 5000000, request_limit_24h = 2000 WHERE tier = 'pro';
UPDATE ai_rate_limits SET token_limit_24h = -1, request_limit_24h = -1 WHERE tier = 'enterprise';

CREATE OR REPLACE FUNCTION upsert_ai_usage(
  p_user_id UUID,
  p_provider TEXT,
  p_model TEXT,
  p_tokens_input INTEGER,
  p_tokens_output INTEGER
)
RETURNS void AS $$
BEGIN
  -- Append a usage EVENT; rate limits sum events in the rolling 24h window.
  -- Never update legacy monthly aggregates (those were archived at cutover).
  INSERT INTO ai_usage (user_id, provider, model, tokens_input, tokens_output, request_count, period_start)
  VALUES (p_user_id, p_provider, p_model, p_tokens_input, p_tokens_output, 1, CURRENT_DATE);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION check_ai_rate_limit(p_user_id UUID)
RETURNS TABLE (
  within_limits BOOLEAN,
  current_tokens BIGINT,
  current_requests BIGINT,
  token_limit INTEGER,
  request_limit INTEGER,
  tier TEXT,
  window_label TEXT
) AS $$
DECLARE
  v_tier TEXT;
  v_token_limit INTEGER;
  v_request_limit INTEGER;
  v_current_tokens BIGINT;
  v_current_requests BIGINT;
BEGIN
  SELECT COALESCE(ut.tier, 'free') INTO v_tier
  FROM user_ai_tier ut
  WHERE ut.user_id = p_user_id;

  IF v_tier IS NULL THEN
    v_tier := 'free';
  END IF;

  SELECT rl.token_limit_24h, rl.request_limit_24h
  INTO v_token_limit, v_request_limit
  FROM ai_rate_limits rl
  WHERE rl.tier = v_tier;

  IF v_token_limit IS NULL THEN
    v_token_limit := 1000000;
    v_request_limit := 500;
  END IF;

  -- Only event rows in ai_usage participate. Legacy monthly aggregates live in
  -- ai_usage_legacy_monthly_archive and are intentionally excluded.
  SELECT
    COALESCE(SUM(u.tokens_input + u.tokens_output), 0),
    COALESCE(SUM(u.request_count), 0)
  INTO v_current_tokens, v_current_requests
  FROM ai_usage u
  WHERE u.user_id = p_user_id
    AND u.created_at >= NOW() - INTERVAL '24 hours';

  RETURN QUERY SELECT
    (v_token_limit = -1 OR v_current_tokens < v_token_limit) AND
    (v_request_limit = -1 OR v_current_requests < v_request_limit),
    v_current_tokens,
    v_current_requests,
    v_token_limit,
    v_request_limit,
    v_tier,
    'in the last 24 hours'::TEXT;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ---------------------------------------------------------------------------
-- Post-apply / re-run verification (manual)
-- ---------------------------------------------------------------------------
-- Confirm cutover is marked complete (exactly one row):
--   SELECT id, cutover_completed_at, legacy_rows_archived FROM ai_usage_cutover_state;
--
-- Confirm a second execution of THIS FILE is a no-op for live usage data:
--   1) INSERT INTO ai_usage (id, user_id, provider, model, tokens_input, tokens_output,
--        request_count, period_start, created_at, updated_at)
--      VALUES (gen_random_uuid(), '<some-user-uuid>', 'lovable', 'test-model', 42, 0,
--        1, CURRENT_DATE, NOW(), NOW());
--   2) Re-run the cutover DO $$ ... END $$; block (or the whole migration file).
--   3) Expect NOTICE: 'ai_usage rolling-24h cutover already completed; skipping...'
--   4) SELECT tokens_input FROM ai_usage WHERE model = 'test-model';  -- still 42
--   5) SELECT COUNT(*) FROM ai_usage_legacy_monthly_archive;
--      -- unchanged vs step before the re-run (fake row was NOT archived)
