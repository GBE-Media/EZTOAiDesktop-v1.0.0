/**
 * Per-model request constraints that differ from the generic defaults.
 * Keep this list aligned with provider registry / gateway behavior.
 */

/** Models that reject any explicit temperature (only the API default is allowed). */
const TEMPERATURE_FIXED_DEFAULT_PATTERNS: RegExp[] = [
  /^(openai\/)?gpt-5(\b|[.-])/i,
  /^(openai\/)?o1(\b|[.-])/i,
  /^(openai\/)?o3(\b|[.-])/i,
  /^(openai\/)?o4(\b|[.-])/i,
];

export function modelRejectsCustomTemperature(model: string | undefined | null): boolean {
  if (!model || typeof model !== 'string') return false;
  const trimmed = model.trim();
  if (!trimmed) return false;
  return TEMPERATURE_FIXED_DEFAULT_PATTERNS.some(pattern => pattern.test(trimmed));
}

/**
 * Return the temperature to send to the provider, or `undefined` to omit the
 * field entirely (required for models that only accept the default).
 */
export function resolveRequestTemperature(
  model: string | undefined | null,
  requested: number | undefined,
): number | undefined {
  if (modelRejectsCustomTemperature(model)) return undefined;
  return requested;
}
