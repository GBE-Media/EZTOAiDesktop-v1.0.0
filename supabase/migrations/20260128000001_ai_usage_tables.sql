-- AI Usage Tracking Tables
-- Tracks per-user AI API usage for rate limiting and billing

-- Table to track AI usage per user per month
CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'gemini')),
  model TEXT NOT NULL,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  request_count INTEGER DEFAULT 1,
  period_start DATE NOT NULL, -- First day of the month for monthly reset
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider, model, period_start)
);

-- Table to define rate limit tiers
CREATE TABLE IF NOT EXISTS ai_rate_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier TEXT NOT NULL UNIQUE CHECK (tier IN ('free', 'pro', 'enterprise')),
  monthly_token_limit INTEGER DEFAULT 100000,
  monthly_request_limit INTEGER DEFAULT 500,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table to track user tier assignments (optional, defaults to 'free')
CREATE TABLE IF NOT EXISTS user_ai_tier (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  tier TEXT NOT NULL DEFAULT 'free' REFERENCES ai_rate_limits(tier),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Insert default rate limit tiers
INSERT INTO ai_rate_limits (tier, monthly_token_limit, monthly_request_limit) VALUES
  ('free', 100000, 500),
  ('pro', 1000000, 5000),
  ('enterprise', -1, -1) -- -1 means unlimited
ON CONFLICT (tier) DO NOTHING;

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_period ON ai_usage(user_id, period_start);
CREATE INDEX IF NOT EXISTS idx_ai_usage_provider ON ai_usage(provider);
CREATE INDEX IF NOT EXISTS idx_user_ai_tier_user ON user_ai_tier(user_id);

-- Enable RLS
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_ai_tier ENABLE ROW LEVEL SECURITY;

-- RLS Policies for ai_usage (users can only see their own usage)
CREATE POLICY "Users can view their own AI usage"
  ON ai_usage FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policies for ai_rate_limits (everyone can read rate limits)
CREATE POLICY "Anyone can view rate limits"
  ON ai_rate_limits FOR SELECT
  USING (true);

-- RLS Policies for user_ai_tier (users can only see their own tier)
CREATE POLICY "Users can view their own tier"
  ON user_ai_tier FOR SELECT
  USING (auth.uid() = user_id);

-- Function to get current month's start date
CREATE OR REPLACE FUNCTION get_period_start()
RETURNS DATE AS $$
BEGIN
  RETURN DATE_TRUNC('month', CURRENT_DATE)::DATE;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function to update or insert usage
CREATE OR REPLACE FUNCTION upsert_ai_usage(
  p_user_id UUID,
  p_provider TEXT,
  p_model TEXT,
  p_tokens_input INTEGER,
  p_tokens_output INTEGER
)
RETURNS void AS $$
BEGIN
  INSERT INTO ai_usage (user_id, provider, model, tokens_input, tokens_output, request_count, period_start)
  VALUES (p_user_id, p_provider, p_model, p_tokens_input, p_tokens_output, 1, get_period_start())
  ON CONFLICT (user_id, provider, model, period_start)
  DO UPDATE SET
    tokens_input = ai_usage.tokens_input + EXCLUDED.tokens_input,
    tokens_output = ai_usage.tokens_output + EXCLUDED.tokens_output,
    request_count = ai_usage.request_count + 1,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to check if user is within rate limits
CREATE OR REPLACE FUNCTION check_ai_rate_limit(p_user_id UUID)
RETURNS TABLE (
  within_limits BOOLEAN,
  current_tokens BIGINT,
  current_requests BIGINT,
  token_limit INTEGER,
  request_limit INTEGER,
  tier TEXT
) AS $$
DECLARE
  v_tier TEXT;
  v_token_limit INTEGER;
  v_request_limit INTEGER;
  v_current_tokens BIGINT;
  v_current_requests BIGINT;
BEGIN
  -- Get user's tier (default to 'free')
  SELECT COALESCE(ut.tier, 'free') INTO v_tier
  FROM user_ai_tier ut
  WHERE ut.user_id = p_user_id;
  
  IF v_tier IS NULL THEN
    v_tier := 'free';
  END IF;
  
  -- Get tier limits
  SELECT rl.monthly_token_limit, rl.monthly_request_limit
  INTO v_token_limit, v_request_limit
  FROM ai_rate_limits rl
  WHERE rl.tier = v_tier;
  
  -- Get current usage for this month
  SELECT 
    COALESCE(SUM(u.tokens_input + u.tokens_output), 0),
    COALESCE(SUM(u.request_count), 0)
  INTO v_current_tokens, v_current_requests
  FROM ai_usage u
  WHERE u.user_id = p_user_id
    AND u.period_start = get_period_start();
  
  -- Check if within limits (-1 means unlimited)
  RETURN QUERY SELECT
    (v_token_limit = -1 OR v_current_tokens < v_token_limit) AND
    (v_request_limit = -1 OR v_current_requests < v_request_limit),
    v_current_tokens,
    v_current_requests,
    v_token_limit,
    v_request_limit,
    v_tier;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
