// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("@/services/billing/usage", async (orig) => ({
  ...(await orig<typeof import("@/services/billing/usage")>()),
  loadUsageRows: mocks.load,
}));

import { UsagePanel, USAGE_REFRESH_MS } from "./UsagePanel";
import { notifyUsageUpdated } from "@/services/billing/usage";

const access = {
  isTeamLead: true,
  status: "active",
  periodStart: new Date("2026-10-10T00:00:00Z"),
  periodEnd: new Date("2026-11-10T00:00:00Z"),
};

afterEach(() => {
  cleanup();
  mocks.load.mockReset();
  vi.useRealTimers();
});

describe("UsagePanel", () => {
  it("shows the team total and each person's usage", async () => {
    mocks.load.mockResolvedValue({
      rows: [
        { user_id: "lead", user_email: "lead@co.com", billed_units: 12000, billing_status: "reported" },
        { user_id: "m1", user_email: "estimator@co.com", billed_units: 34500, billing_status: "reported" },
      ],
      truncated: false,
    });
    render(<UsagePanel open onOpenChange={() => {}} userId="lead" access={access} />);
    await waitFor(() => expect(screen.getByTestId("usage-total").textContent).toBe("$4.65"));
    expect(screen.getByText("estimator@co.com")).toBeTruthy();
    expect(screen.getByText("$3.45")).toBeTruthy();
    expect(screen.getByText("(you)")).toBeTruthy();
    expect(mocks.load).toHaveBeenCalledWith("lead", access.periodStart);
    expect(document.body.textContent).not.toMatch(/markup|20%/i);
  });

  it("refreshes after an AI reply and on a timer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocks.load.mockResolvedValue({ rows: [], truncated: false });
    render(<UsagePanel open onOpenChange={() => {}} userId="lead" access={access} />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/No AI usage yet/)).toBeTruthy();
    act(() => notifyUsageUpdated());
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
    await act(async () => { vi.advanceTimersByTime(USAGE_REFRESH_MS); });
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(3));
  });

  it("does not load while closed", () => {
    render(<UsagePanel open={false} onOpenChange={() => {}} userId="lead" access={access} />);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("shows an error when usage can't load", async () => {
    mocks.load.mockRejectedValue(new Error("down"));
    render(<UsagePanel open onOpenChange={() => {}} userId="lead" access={access} />);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be loaded");
  });
});
