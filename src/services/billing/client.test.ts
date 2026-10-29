// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
vi.mock("@/integrations/external-auth/client", () => ({
  externalAuthClient: { auth: { getSession: vi.fn() } },
}));
import { isStripeBillingUrl } from "./client";
describe("billing external navigation", () => {
  it("accepts only HTTPS Stripe checkout, portal and dashboard hosts", () => {
    expect(isStripeBillingUrl("https://checkout.stripe.com/c/pay/test")).toBe(
      true,
    );
    expect(
      isStripeBillingUrl("https://billing.stripe.com/p/session/test"),
    ).toBe(true);
    expect(
      isStripeBillingUrl("https://dashboard.stripe.com/customers/cus_test"),
    ).toBe(true);
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "http://checkout.stripe.com/pay",
      "https://checkout.stripe.com.attacker.test/pay",
      "https://user:password@checkout.stripe.com/pay",
      "https://checkout.stripe.com:444/pay",
    ]) {
      expect(isStripeBillingUrl(url)).toBe(false);
    }
  });
});
