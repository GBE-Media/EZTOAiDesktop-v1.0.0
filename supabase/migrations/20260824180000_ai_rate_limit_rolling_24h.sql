-- Rolling 24-hour AI rate limits (replaces monthly window from 20260128000001).
-- Limits are applied by summing ai_usage rows with created_at in the last 24 hours.
--
-- NOTE: Applying this migration on the live Lovable-managed Supabase project is
-- required for production — merging this file alone does not change the live DB.

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
    WHERE table_name = 'ai_rate_limits' AND column_name = 'monthly_token_limit'
  ) THEN
    ALTER TABLE ai_rate_limits RENAME COLUMN monthly_token_limit TO token_limit_24h;
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'ai_rate_limits' AND column_name = 'monthly_request_limit'
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
  -- Append a usage event; rate limits sum events in the rolling 24h window.
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
