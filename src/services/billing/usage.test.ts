import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  subs: [] as unknown[],
  usagePages: [] as unknown[][],
  ranges: [] as Array<[number, number]>,
  filters: [] as Array<[string, string, unknown]>,
  fail: false,
}));

vi.mock("@/integrations/external-auth/client", () => {
  const builder = (table: string) => {
    const q: Record<string, unknown> = {};
    const chain = () => q;
    q.select = chain;
    q.order = chain;
    q.eq = (col: string, val: unknown) => { state.filters.push([table, col, val]); return q; };
    q.gte = (col: string, val: unknown) => { state.filters.push([table, col, val]); return q; };
    q.limit = () => Promise.resolve({ data: state.subs, error: state.fail ? { message: "x" } : null });
    q.range = (a: number, b: number) => {
      state.ranges.push([a, b]);
      const page = state.usagePages.shift() ?? [];
      return Promise.resolve({ data: page, error: state.fail ? { message: "x" } : null });
    };
    return q;
  };
  return { externalAuthClient: { from: builder } };
});

import { formatUsd, loadUsageAccess, loadUsageRows, summarizeUsage, type UsageRow } from "./usage";

afterEach(() => {
  state.subs = [];
  state.usagePages = [];
  state.ranges = [];
  state.filters = [];
  state.fail = false;
});

const row = (user_id: string, billed_units: number, billing_status = "reported", user_email: string | null = `${user_id}@co.com`): UsageRow =>
  ({ user_id, user_email, billed_units, billing_status });

describe("summarizeUsage", () => {
  it("totals each person's invoiced usage and counts trial requests as free", () => {
    const s = summarizeUsage([row("a", 1500), row("b", 20000), row("a", 500), row("b", 0, "trial_free"), row("c", 9999, "report_failed")]);
    expect(s.people.map((p) => p.userId)).toEqual(["b", "a", "c"]);
    expect(s.people[0]).toMatchObject({ requests: 2, freeRequests: 1, chargeUsd: 2 });
    expect(s.people[1].chargeUsd).toBeCloseTo(0.2);
    // A failed meter report never reaches the invoice, so the meter must not show it as owed.
    expect(s.people[2].chargeUsd).toBe(0);
    expect(s.totalUsd).toBeCloseTo(2.2);
    expect(s.totalRequests).toBe(5);
    expect(s.freeRequests).toBe(1);
  });

  it("formats dollars", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
  });
});

describe("loadUsageAccess", () => {
  const now = new Date("2026-10-29T12:00:00Z");

  it("treats a paying subscriber as team lead and uses the billing period", async () => {
    state.subs = [{ status: "active", current_period_start: "2026-10-10T00:00:00Z", current_period_end: "2026-11-10T00:00:00Z" }];
    const a = await loadUsageAccess("u1", now);
    expect(a.isTeamLead).toBe(true);
    expect(a.periodStart.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(a.periodEnd?.toISOString()).toBe("2026-11-10T00:00:00.000Z");
    expect(state.filters).toContainEqual(["subscriptions", "user_id", "u1"]);
  });

  it("hides the meter from team members and canceled accounts", async () => {
    state.subs = [];
    expect((await loadUsageAccess("u1", now)).isTeamLead).toBe(false);
    state.subs = [{ status: "canceled", current_period_start: null, current_period_end: null }];
    expect((await loadUsageAccess("u1", now)).isTeamLead).toBe(false);
  });

  it("falls back to the calendar month when the stored period is stale", async () => {
    state.subs = [{ status: "trialing", current_period_start: "2026-09-01T00:00:00Z", current_period_end: "2026-10-01T00:00:00Z" }];
    const a = await loadUsageAccess("u1", now);
    expect(a.isTeamLead).toBe(true);
    expect(a.periodStart.getDate()).toBe(1);
    expect(a.periodStart.getMonth()).toBe(now.getMonth());
    expect(a.periodEnd).toBeNull();
  });
});

describe("loadUsageRows", () => {
  it("reads every page billed to the payer", async () => {
    state.usagePages = [Array.from({ length: 1000 }, () => row("a", 1)), [row("b", 2)]];
    const { rows, truncated } = await loadUsageRows("lead", new Date("2026-10-10T00:00:00Z"));
    expect(rows).toHaveLength(1001);
    expect(truncated).toBe(false);
    expect(state.ranges).toEqual([[0, 999], [1000, 1999]]);
    expect(state.filters).toContainEqual(["ai_usage_charges", "payer_user_id", "lead"]);
    expect(state.filters).toContainEqual(["ai_usage_charges", "created_at", "2026-10-10T00:00:00.000Z"]);
  });

  it("reports a load failure", async () => {
    state.fail = true;
    await expect(loadUsageRows("lead", new Date())).rejects.toThrow("could not be loaded");
  });
});
