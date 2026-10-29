import { describe, expect, it } from "vitest";
import { webcrypto } from "node:crypto";
import {
  AI_CHARGING_ENABLED,
  reservationBound,
  shadowCost,
  usageTokens,
  validateSoftwarePrice,
  validateBillingRequestShape,
  validatePortalConfiguration,
} from "../../../supabase/functions/_shared/billing-policy";
import {
  canManageAccount,
  canReadAccount,
} from "../../../supabase/functions/_shared/billing-access";
import { verifyWebhookSignature } from "../../../supabase/functions/_shared/billing-webhook-signature";

describe("billing policy", () => {
  it("prevents a portal configuration from enabling unreviewed price or seat edits", () => {
    const config = {
      active: true,
      livemode: false,
      features: {
        subscription_update: { enabled: false },
        subscription_cancel: { enabled: true, mode: "at_period_end" },
      },
    };
    expect(() => validatePortalConfiguration(config, false)).not.toThrow();
    expect(() => validatePortalConfiguration(config, true)).toThrow();
    expect(() =>
      validatePortalConfiguration(
        {
          ...config,
          features: {
            ...config.features,
            subscription_update: { enabled: true },
          },
        },
        false,
      ),
    ).toThrow();
    expect(() =>
      validatePortalConfiguration(
        {
          ...config,
          features: {
            ...config.features,
            subscription_cancel: { enabled: true, mode: "immediately" },
          },
        },
        false,
      ),
    ).toThrow();
  });
  it("rejects native multimodal content that would bypass the image reservation bound", () => {
    const body = {
      provider: "lovable",
      model: "openai/gpt-5.6-sol",
      messages: [{ role: "user", content: "count", images: ["image-data"] }],
    };
    expect(() => validateBillingRequestShape(body)).not.toThrow();
    expect(() =>
      validateBillingRequestShape({
        ...body,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: "https://example.test/large.png" },
              },
            ],
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      validateBillingRequestShape({
        ...body,
        messages: [{ role: "user", content: "count", images: "not-an-array" }],
      }),
    ).toThrow();
  });
  it("never enables AI invoice charges", () =>
    expect(AI_CHARGING_ENABLED).toBe(false));
  it("values measured tokens using versioned shadow rates, not invoice charges", () => {
    expect(shadowCost("openai/gpt-5.6-sol", 4955, 9815)).toBe(648360);
    expect(shadowCost("gpt-5.5", 15836, 283)).toBe(263010);
    expect(shadowCost("unpriced", 100, 100)).toBe(0);
  });
  it("counts Anthropic cached tokens as input", () =>
    expect(
      usageTokens({
        input_tokens: 100,
        cache_read_input_tokens: 50,
        cache_creation_input_tokens: 20,
        output_tokens: 10,
      }),
    ).toEqual({ input: 170, output: 10 }));
  it("uses a positive conservative bound and refuses unknown trial models", () => {
    const known = reservationBound({
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "count" }],
      maxTokens: 4096,
    });
    expect(known.bounded).toBe(true);
    expect(known.microUsd).toBeGreaterThan(shadowCost("gpt-5.6-sol", 5, 4096));
    expect(reservationBound({ model: "unknown", messages: [] }).bounded).toBe(
      false,
    );
    expect(
      reservationBound({
        model: "gpt-5.6-sol",
        messages: [{ images: ["https://example.com/large.png"] }],
      }).bounded,
    ).toBe(false);
    expect(() =>
      reservationBound({ model: "gpt-5.6-sol", messages: [], maxTokens: 0 }),
    ).toThrow();
  });
  it("does not admit unbounded long-context requests to a trial", () => {
    expect(
      reservationBound({
        model: "gpt-5.6-sol",
        messages: [{ content: "x".repeat(262144) }],
      }).bounded,
    ).toBe(false);
  });
  it("requires an active USD monthly licensed price in the matching mode", () => {
    const price = {
      active: true,
      livemode: false,
      currency: "usd",
      unit_amount: 30000,
      recurring: {
        interval: "month",
        interval_count: 1,
        usage_type: "licensed",
      },
    };
    expect(() => validateSoftwarePrice(price, false)).not.toThrow();
    expect(() => validateSoftwarePrice(price, true)).toThrow();
    expect(() =>
      validateSoftwarePrice(
        { ...price, recurring: { ...price.recurring, usage_type: "metered" } },
        false,
      ),
    ).toThrow();
    expect(() =>
      validateSoftwarePrice({ ...price, unit_amount: 0 }, false),
    ).toThrow();
  });
  it("does not trust account selectors or client roles across tenants", () => {
    const member = { account_id: "own", role: "owner", suspended: false };
    expect(canReadAccount(false, member, "other")).toBe(false);
    expect(canManageAccount(false, member, "other")).toBe(false);
    expect(canManageAccount(false, { ...member, role: "member" }, "own")).toBe(
      false,
    );
    expect(canManageAccount(false, { ...member, suspended: true }, "own")).toBe(
      true,
    );
    expect(canManageAccount(false, member, "own")).toBe(true);
    expect(canManageAccount(true, member, "other")).toBe(true);
  });
});
describe("Stripe raw body signature verification", () => {
  it("accepts valid signatures and rejects tampering, replay, missing secrets and malformed headers", async () => {
    const raw = '{"id":"evt_test","livemode":false}';
    const now = 1700000000;
    const key = await webcrypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("test-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(
      await webcrypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${now}.${raw}`),
      ),
    );
    const hex = [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
    const header = `t=${now},v1=${hex}`;
    expect(await verifyWebhookSignature(raw, header, "test-secret", now)).toBe(
      true,
    );
    expect(
      await verifyWebhookSignature(raw + " ", header, "test-secret", now),
    ).toBe(false);
    expect(
      await verifyWebhookSignature(raw, header, "test-secret", now + 301),
    ).toBe(false);
    expect(await verifyWebhookSignature(raw, header, "", now)).toBe(false);
    expect(
      await verifyWebhookSignature(
        raw,
        header + `,t=${now}`,
        "test-secret",
        now,
      ),
    ).toBe(false);
    expect(
      await verifyWebhookSignature(raw, `t=${now},v1=oops`, "test-secret", now),
    ).toBe(false);
  });
});
