import { describe, expect, it } from 'vitest';
import { formatRateLimitExceededMessage } from './rateLimitMessage';

describe('formatRateLimitExceededMessage', () => {
  it('describes a 24-hour window, not a month', () => {
    const message = formatRateLimitExceededMessage({
      currentTokens: 101770,
      tokenLimit: 1000000,
      currentRequests: 10,
      requestLimit: 500,
      tier: 'free',
      windowLabel: 'in the last 24 hours',
    });
    expect(message).toContain('in the last 24 hours');
    expect(message).not.toContain('this month');
    expect(message).toContain('free tier');
  });

  it('defaults window label when proxy omits it', () => {
    const message = formatRateLimitExceededMessage({
      currentTokens: 1,
      tokenLimit: 100,
      currentRequests: 1,
      requestLimit: 50,
      tier: 'pro',
    });
    expect(message).toContain('in the last 24 hours');
  });
});
