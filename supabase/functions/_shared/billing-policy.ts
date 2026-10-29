/** Shadow retail units for trial/service limits ONLY. Never used to invoice AI. */
export const SHADOW_RATE_VERSION = "trial-shadow-2026-10-v1";
export const AI_CHARGING_ENABLED = false;
export function validatePortalConfiguration(
  config: {
    active?: boolean;
    livemode?: boolean;
    features?: {
      subscription_update?: { enabled?: boolean };
      subscription_cancel?: { enabled?: boolean; mode?: string };
    };
  },
  live: boolean,
) {
  if (
    !config.active ||
    config.livemode !== live ||
    config.features?.subscription_update?.enabled !== false ||
    (config.features?.subscription_cancel?.enabled &&
      config.features.subscription_cancel.mode !== "at_period_end")
  ) {
    throw new Error(
      "The customer portal must disable price/seat edits and use period-end cancellation in the configured Stripe mode.",
    );
  }
}
/** Reject native multimodal content smuggled around the separately bounded images field. */
export function validateBillingRequestShape(request: unknown): void {
  if (!request || typeof request !== "object")
    throw new Error("Invalid AI request.");
  const body = request as Record<string, unknown>;
  if (
    typeof body.model !== "string" ||
    !body.model ||
    body.model.length > 200 ||
    typeof body.provider !== "string" ||
    !["openai", "anthropic", "lovable"].includes(body.provider) ||
    !Array.isArray(body.messages) ||
    !body.messages.length
  ) {
    throw new Error("Invalid provider, model or messages.");
  }
  for (const value of body.messages) {
    if (!value || typeof value !== "object")
      throw new Error("Invalid AI message.");
    const message = value as Record<string, unknown>;
    // Older callers can omit text on image/tool-only messages; normalize that safely.
    if (message.content == null) message.content = "";
    if (
      typeof message.role !== "string" ||
      !["user", "assistant", "system", "tool"].includes(message.role) ||
      typeof message.content !== "string" ||
      (message.images !== undefined &&
        (!Array.isArray(message.images) ||
          !message.images.every((image) => typeof image === "string"))) ||
      (message.toolCalls !== undefined && !Array.isArray(message.toolCalls))
    ) {
      throw new Error(
        "AI messages must use text content and a separate image-string array.",
      );
    }
  }
  if (body.tools !== undefined && !Array.isArray(body.tools))
    throw new Error("Invalid AI tools.");
}
const rates: Record<string, { input: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.6, output: 3.6 },
  "gpt-5.6-sol": { input: 12, output: 60 },
  "gpt-5.5": { input: 15, output: 90 },
  "claude-opus-4-7": { input: 15, output: 75 },
};
export function shadowRate(model: string) {
  const name = model.replace(/^(openai|anthropic)\//, "");
  return (
    rates[name] ||
    Object.entries(rates).find(([key]) => name.startsWith(`${key}-`))?.[1] ||
    null
  );
}
export function shadowCost(
  model: string,
  input: number,
  output: number,
): number {
  const rate = shadowRate(model);
  return rate
    ? Math.ceil(
        Math.max(0, input) * rate.input + Math.max(0, output) * rate.output,
      )
    : 0;
}
export function usageTokens(usage: Record<string, unknown> = {}) {
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.ceil(v) : 0;
  return {
    input:
      number(usage.prompt_tokens ?? usage.input_tokens) +
      number(usage.cache_read_input_tokens) +
      number(usage.cache_creation_input_tokens),
    output: number(usage.completion_tokens ?? usage.output_tokens),
  };
}

/** For the trial's conservative reservation bound, accept known bounded PNG/JPEG only.
 *  Other image formats remain available to paid/legacy accounts, but not unbounded trials.
 */
function boundedImage(image: string): boolean {
  try {
    const raw = image.startsWith("data:")
      ? image.slice(image.indexOf(",") + 1)
      : image;
    if (raw.length > 12_000_000) return false;
    const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const valid = (w: number, h: number) =>
      w > 0 && h > 0 && w <= 4096 && h <= 4096;
    if (
      bytes.length >= 33 &&
      view.getUint32(0) === 0x89504e47 &&
      view.getUint32(4) === 0x0d0a1a0a &&
      view.getUint32(8) === 13 &&
      view.getUint32(12) === 0x49484452
    ) {
      return valid(view.getUint32(16), view.getUint32(20));
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      for (let i = 2; i + 8 < bytes.length;) {
        if (bytes[i] !== 0xff) return false;
        const marker = bytes[i + 1];
        i += 2;
        if (marker === 0xd9 || marker === 0xda) break;
        const length = view.getUint16(i);
        if (length < 2 || i + length > bytes.length) return false;
        if ([0xc0, 0xc1, 0xc2].includes(marker))
          return valid(view.getUint16(i + 5), view.getUint16(i + 3));
        i += length;
      }
    }
  } catch {
    /* unknown image cannot be safely reserved for a trial */
  }
  return false;
}
export function reservationBound(request: {
  model: string;
  maxTokens?: number;
  tools?: unknown;
  messages: Array<{ images?: string[]; [key: string]: unknown }>;
}): { microUsd: number; bounded: boolean } {
  const output = request.maxTokens ?? 16384;
  if (!Number.isInteger(output) || output < 1 || output > 65536)
    throw new Error("maxTokens must be between 1 and 65536.");
  const text = JSON.stringify({
    messages: request.messages.map(({ images: _images, ...m }) => m),
    tools: request.tools,
  });
  // A UTF-8 byte is a conservative bound on text tokens; image allowance is deliberately
  // generous for supported <=4096px inputs. Never silently truncate a count to fit a trial.
  const images = request.messages.flatMap((m) => m.images || []);
  const input =
    new TextEncoder().encode(text).length + images.length * 65536 + 4096;
  return {
    microUsd: shadowCost(request.model, input, output),
    bounded:
      !!shadowRate(request.model) &&
      input <= 262144 &&
      images.every(boundedImage),
  };
}

/** Checkout must never be allowed to create AI-metered or arbitrary client-selected items. */
export function validateSoftwarePrice(
  price: {
    active?: boolean;
    currency?: string;
    unit_amount?: number;
    livemode?: boolean;
    recurring?: {
      interval?: string;
      interval_count?: number;
      usage_type?: string;
    };
  },
  live: boolean,
) {
  if (
    !price.active ||
    price.livemode !== live ||
    price.currency !== "usd" ||
    !Number.isInteger(price.unit_amount) ||
    (price.unit_amount || 0) < 1 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.recurring.usage_type !== "licensed"
  )
    throw new Error(
      "Expected an active monthly USD licensed price in the configured Stripe mode.",
    );
}
