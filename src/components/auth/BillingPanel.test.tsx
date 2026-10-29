// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { BillingPanel } from "./BillingPanel";
import type { BillingOverview } from "@/services/billing/client";
const mocks = vi.hoisted(() => ({ request: vi.fn(), open: vi.fn() }));
vi.mock("@/services/billing/client", () => ({
  billingRequest: mocks.request,
  openStripeBilling: mocks.open,
}));
function fixture(): BillingOverview {
  return {
    owner: true,
    manager: true,
    livemode: false,
    grandfathered: false,
    settings: {
      enabled: false,
      activated_at: null,
      ai_charging_enabled: false,
    },
    account: {
      id: "a",
      name: "Personal account",
      billing_email: "owner@example.test",
      status: "not_enrolled",
      seats: 1,
      suspended: false,
      cancel_at_period_end: false,
    },
    accounts: [
      {
        id: "a",
        name: "Personal account",
        billing_email: "owner@example.test",
        status: "not_enrolled",
        seats: 1,
        suspended: false,
        cancel_at_period_end: false,
      },
    ],
    members: [
      {
        user_id: "u",
        email: "owner@example.test",
        role: "owner",
        suspended: false,
        monthly_ai_limit_micro_usd: null,
      },
    ],
    usage: [],
    audit: [],
  };
}
beforeEach(() => {
  mocks.request.mockReset();
  mocks.open.mockReset();
  mocks.request.mockResolvedValue(fixture());
});
afterEach(cleanup);
describe("Billing & Users panel", () => {
  it("shows billing disabled and cannot start checkout before activation", async () => {
    render(<BillingPanel open onOpenChange={() => {}} />);
    await screen.findByText("Customer charging is OFF");
    expect(
      (
        screen.getByRole("button", {
          name: "Start trial in Stripe",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("discloses the seat total in a confirmation before creating checkout", async () => {
    const data = fixture();
    data.settings.enabled = true;
    mocks.request.mockResolvedValue(data);
    render(<BillingPanel open onOpenChange={() => {}} />);
    await screen.findByText("Stripe test mode");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Seats" }), {
      target: { value: "3" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Start trial in Stripe" }),
    );
    expect(screen.getByText(/\$900\/month after the trial/)).toBeTruthy();
    expect(
      mocks.request.mock.calls.every((call) => call[0] === "overview"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    await waitFor(() =>
      expect(screen.queryByText("Start your seven-day trial?")).toBeNull(),
    );
    expect(
      mocks.request.mock.calls.every((call) => call[0] === "overview"),
    ).toBe(true);
  });
  it("separates member, customer billing admin and platform-owner controls", async () => {
    const data = fixture();
    data.owner = false;
    data.manager = false;
    data.members[0].role = "member";
    mocks.request.mockResolvedValue(data);
    render(<BillingPanel open onOpenChange={() => {}} />);
    await screen.findByText("Customer charging is OFF");
    expect(
      screen.queryByRole("button", { name: "Start trial in Stripe" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Pause account AI" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Create team invitation" }),
    ).toBeNull();
    cleanup();
    data.manager = true;
    data.members[0].role = "owner";
    data.account.stripe_customer_id = "cus_test";
    render(<BillingPanel open onOpenChange={() => {}} />);
    await screen.findByRole("button", { name: "Manage payment & invoices" });
    expect(screen.queryByRole("button", { name: "Save limit" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Pause AI" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Create team invitation" }),
    ).toBeTruthy();
  });
  it("shows a backend deployment error rather than implying charging is live", async () => {
    mocks.request.mockRejectedValue(
      new Error("Billing has not been deployed on the server yet."),
    );
    render(<BillingPanel open onOpenChange={() => {}} />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "not been deployed",
    );
    expect(
      screen.queryByRole("button", { name: "Start trial in Stripe" }),
    ).toBeNull();
  });
  it("confirms cancellation before sending a financial write", async () => {
    const data = fixture();
    data.account.status = "active";
    data.account.stripe_subscription_id = "sub_test";
    data.account.stripe_customer_id = "cus_test";
    data.account.period_end = "2026-12-01T00:00:00Z";
    mocks.request.mockResolvedValue(data);
    render(<BillingPanel open onOpenChange={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel at period end" }),
    );
    expect(screen.getByText(/No refund is issued by this action/)).toBeTruthy();
    expect(
      mocks.request.mock.calls.every((call) => call[0] === "overview"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "cancel_at_period_end",
        expect.objectContaining({ accountId: "a", confirm: true }),
      ),
    );
  });
});
