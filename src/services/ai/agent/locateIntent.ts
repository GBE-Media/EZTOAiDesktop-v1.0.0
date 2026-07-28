/** Shared locate / “show me where” intent detection for intake + routing. */
export const LOCATE_INTENT_PATTERN =
  /\b(where\s+is|show\s+me\s+where|point\s+(me\s+)?to|locate|find\s+on\s+(the\s+)?(page|drawing|plan|sheet))\b/i;

export function isLocateIntent(message: string): boolean {
  return LOCATE_INTENT_PATTERN.test(message.trim());
}
