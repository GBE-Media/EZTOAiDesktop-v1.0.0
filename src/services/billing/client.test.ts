// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { BILLING_PAGES, openBillingPage } from "./client";

afterEach(() => {
  delete (window as { electronAPI?: unknown }).electronAPI;
});

describe("billing pages", () => {
  it("only points at fixed BidveraAi website pages", () => {
    expect(Object.values(BILLING_PAGES)).toEqual([
      "https://bidveraai.com/settings",
      "https://bidveraai.com/pricing",
    ]);
  });

  it("opens the page in the system browser and surfaces failures", async () => {
    const openExternal = vi.fn().mockResolvedValue({ success: true });
    (window as { electronAPI?: unknown }).electronAPI = { openExternal };
    await openBillingPage("manage");
    expect(openExternal).toHaveBeenCalledWith("https://bidveraai.com/settings");
    openExternal.mockResolvedValue({ success: false, message: "no browser" });
    await expect(openBillingPage("pricing")).rejects.toThrow("no browser");
  });
});
