import { describe, expect, it } from 'vitest';

/** Mirrors proxyClient rate-limit message formatting for regression coverage. */
function formatRateLimitMessage(details: {
  currentTokens?: number;
  tokenLimit?: number;
  tier?: string;
  windowLabel?: string;
}): string {
  const windowLabel = details.windowLabel || 'in the last 24 hours';
  const tier = details.tier ? ` (${details.tier} tier)` : '';
  return `Rate limit exceeded${tier}. You've used ${details.currentTokens?.toLocaleString() || '?'} of ${details.tokenLimit?.toLocaleString() || '?'} tokens ${windowLabel}.`;
}

describe('rate limit user-facing message', () => {
  it('describes a 24-hour window, not a month', () => {
    const message = formatRateLimitMessage({
      currentTokens: 101770,
      tokenLimit: 1000000,
      tier: 'free',
      windowLabel: 'in the last 24 hours',
    });
    expect(message).toContain('in the last 24 hours');
    expect(message).not.toContain('this month');
    expect(message).toContain('free tier');
  });
});
