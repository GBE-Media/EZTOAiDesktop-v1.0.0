// Live AI usage for the person who pays (the team lead).
// Reads the website's ai_usage_charges ledger. Row-level security lets a payer read
// every row billed to them, so no extra server endpoint is needed.
import { externalAuthClient } from "@/integrations/external-auth/client";

/** One meter unit is $0.0001 on the invoice. */
export const UNIT_USD = 0.0001;
/** Subscription states that still produce an AI usage bill. */
const PAYING_STATUSES = new Set(["active", "trialing", "past_due", "unpaid"]);
const PAGE_SIZE = 1000;
const MAX_ROWS = 50000;
export const USAGE_UPDATED_EVENT = "ai-usage-updated";

export interface UsageAccess {
  isTeamLead: boolean;
  status: string | null;
  periodStart: Date;
  periodEnd: Date | null;
}

export interface UsageRow {
  user_id: string;
  user_email: string | null;
  billed_units: number;
  billing_status: string;
}

export interface PersonUsage {
  userId: string;
  email: string;
  requests: number;
  freeRequests: number;
  chargeUsd: number;
}

export interface UsageSummary {
  people: PersonUsage[];
  totalUsd: number;
  totalRequests: number;
  freeRequests: number;
  truncated: boolean;
}

function startOfMonth(now: Date) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** Team lead = holds a BidveraAi subscription that pays for AI usage. */
export async function loadUsageAccess(userId: string, now = new Date()): Promise<UsageAccess> {
  const { data, error } = await externalAuthClient
    .from("subscriptions")
    .select("status, current_period_start, current_period_end")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(1);
  if (error) throw new Error("Usage access could not be checked.");
  const sub = (data as Array<{ status: string; current_period_start: string | null; current_period_end: string | null }> | null)?.[0];
  const isTeamLead = !!sub && PAYING_STATUSES.has(sub.status);
  const start = sub?.current_period_start ? new Date(sub.current_period_start) : null;
  const end = sub?.current_period_end ? new Date(sub.current_period_end) : null;
  // If the stored period has already ended (webhook not caught up), fall back to this month.
  const periodValid = start && !Number.isNaN(start.getTime()) && start <= now && (!end || end > now);
  return {
    isTeamLead,
    status: sub?.status ?? null,
    periodStart: periodValid ? start! : startOfMonth(now),
    periodEnd: periodValid ? end : null,
  };
}

/** Every usage row billed to this payer since `from`, read in pages. */
export async function loadUsageRows(payerId: string, from: Date): Promise<{ rows: UsageRow[]; truncated: boolean }> {
  const rows: UsageRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await externalAuthClient
      .from("ai_usage_charges")
      .select("user_id, user_email, billed_units, billing_status")
      .eq("payer_user_id", payerId)
      .gte("created_at", from.toISOString())
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error("AI usage could not be loaded right now.");
    const page = (data as UsageRow[] | null) ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

export function summarizeUsage(rows: UsageRow[], truncated = false): UsageSummary {
  const byUser = new Map<string, PersonUsage>();
  for (const r of rows) {
    const p = byUser.get(r.user_id) ?? {
      userId: r.user_id,
      email: r.user_email || "Unknown user",
      requests: 0,
      freeRequests: 0,
      chargeUsd: 0,
    };
    p.requests += 1;
    if (r.billing_status === "trial_free") p.freeRequests += 1;
    // Only "reported" rows reach the Stripe meter, so only they appear on the invoice.
    else if (r.billing_status === "reported") p.chargeUsd += (Number(r.billed_units) || 0) * UNIT_USD;
    if (r.user_email && p.email === "Unknown user") p.email = r.user_email;
    byUser.set(r.user_id, p);
  }
  const people = [...byUser.values()].sort((a, b) => b.chargeUsd - a.chargeUsd || b.requests - a.requests);
  return {
    people,
    totalUsd: people.reduce((s, p) => s + p.chargeUsd, 0),
    totalRequests: people.reduce((s, p) => s + p.requests, 0),
    freeRequests: people.reduce((s, p) => s + p.freeRequests, 0),
    truncated,
  };
}

export function formatUsd(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Tell any open usage meter to refresh after an AI reply. */
export function notifyUsageUpdated() {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(USAGE_UPDATED_EVENT));
}
