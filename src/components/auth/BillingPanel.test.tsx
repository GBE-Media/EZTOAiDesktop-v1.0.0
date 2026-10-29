// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BillingPanel } from "./BillingPanel";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/services/billing/client", () => ({ openBillingPage: mocks.open }));

afterEach(() => {
  cleanup();
  mocks.open.mockReset();
});

describe("BillingPanel", () => {
  it("opens the website account page to manage the subscription", async () => {
    mocks.open.mockResolvedValue(undefined);
    render(<BillingPanel open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("manage"));
  });

  it("opens pricing for a trial", async () => {
    mocks.open.mockResolvedValue(undefined);
    render(<BillingPanel open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Plans/ }));
    await waitFor(() => expect(mocks.open).toHaveBeenCalledWith("pricing"));
  });

  it("shows a fallback when the browser cannot be opened", async () => {
    mocks.open.mockRejectedValue(new Error("blocked"));
    render(<BillingPanel open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Manage subscription" }));
    expect((await screen.findByRole("alert")).textContent).toContain("bidveraai.com/settings");
  });
});
