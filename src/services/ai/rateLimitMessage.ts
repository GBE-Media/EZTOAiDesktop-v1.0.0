export interface RateLimitMessageDetails {
  currentTokens?: number;
  tokenLimit?: number;
  currentRequests?: number;
  requestLimit?: number;
  tier?: string;
  /** e.g. "in the last 24 hours" — optional for older proxies */
  windowLabel?: string;
}

/** Shared formatter so UI copy and tests cannot drift. */
export function formatRateLimitExceededMessage(details: RateLimitMessageDetails | undefined): string {
  const windowLabel = details?.windowLabel || 'in the last 24 hours';
  const tier = details?.tier ? ` (${details.tier} tier)` : '';
  return `Rate limit exceeded${tier}. You've used ${details?.currentTokens?.toLocaleString() || '?'} of ${details?.tokenLimit?.toLocaleString() || '?'} tokens ${windowLabel}.`;
}
