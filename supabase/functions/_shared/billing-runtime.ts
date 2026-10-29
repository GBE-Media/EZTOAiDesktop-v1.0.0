import { createClient } from "https://esm.sh/@supabase/supabase-js@2.38.4";
export const billingDb = () =>
  createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    },
  );
export const billingCors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...billingCors,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
export function checked<T>(r: {
  data: T;
  error: { message: string } | null;
}): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}
export const isPlatformOwner = (userId: string) =>
  (Deno.env.get("BILLING_OWNER_USER_IDS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(userId);
export async function signedIn(req: Request, db: ReturnType<typeof billingDb>) {
  const token = (req.headers.get("authorization") || "").replace(
    /^Bearer /i,
    "",
  );
  if (!token) throw new Error("AUTH_REQUIRED");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user || !data.user.email_confirmed_at)
    throw new Error("AUTH_REQUIRED");
  return data.user;
}
export async function stripe(
  path: string,
  method = "GET",
  params?: Record<string, unknown>,
  key?: string,
) {
  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret) throw new Error("Stripe is not configured on the server.");
  const form = new URLSearchParams();
  const add = (prefix: string, value: unknown) => {
    if (value == null) return;
    if (typeof value === "object") {
      Object.entries(value).forEach(([k, v]) =>
        add(prefix ? `${prefix}[${k}]` : k, v),
      );
    } else form.append(prefix, String(value));
  };
  if (params) add("", params);
  const response = await fetch(
    `https://api.stripe.com/v1${path}${method === "GET" && params ? `?${form}` : ""}`,
    {
      method,
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2025-06-30.basil",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(method !== "GET" ? { body: form } : {}),
    },
  );
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      body.error?.message || `Stripe request failed (${response.status})`,
    );
  return body;
}
export async function hashToken(token: string) {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(hash)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
export async function syncSubscription(
  db: ReturnType<typeof billingDb>,
  sub: any,
  eventId: string,
  eventCreated: number,
  eventType = "manual_refresh",
) {
  const customer =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const token = checked(
    await db.rpc("billing_claim_sync", { p_customer: customer }),
  );
  if (!token) return false;
  try {
    // Serialize fetch + apply. Out-of-order/same-second deliveries cannot replay stale snapshots.
    sub = await stripe(`/subscriptions/${encodeURIComponent(sub.id)}`);
    if (sub.livemode !== (Deno.env.get("STRIPE_LIVEMODE") === "true"))
      throw new Error("Stripe mode mismatch.");
    if (
      (typeof sub.customer === "string" ? sub.customer : sub.customer.id) !==
      customer
    )
      throw new Error("Subscription customer mismatch.");
    const items = sub.items?.data || [];
    if (
      items.length !== 1 ||
      items[0].price?.recurring?.usage_type !== "licensed" ||
      items[0].price?.currency !== "usd" ||
      !Number.isInteger(items[0].quantity) ||
      items[0].quantity < 1 ||
      items[0].quantity > 100
    )
      throw new Error("Unexpected subscription items; manual review required.");
    const iso = (n: number | null) =>
      n ? new Date(n * 1000).toISOString() : null;
    return checked(
      await db.rpc("billing_apply_subscription", {
        p_event_id: eventId,
        p_event_type: eventType,
        p_event_created: eventCreated,
        p_customer: customer,
        p_subscription: sub.id,
        p_status: sub.status,
        p_price: items[0].price.id,
        p_seats: items[0].quantity,
        p_trial_end: iso(sub.trial_end),
        p_period_end: iso(
          items[0].current_period_end || sub.current_period_end,
        ),
        p_cancel: !!sub.cancel_at_period_end,
        p_trial_start: iso(sub.trial_start),
        p_sync_token: token,
      }),
    );
  } finally {
    checked(
      await db
        .from("billing_accounts")
        .update({ sync_token: null, sync_lock_until: null })
        .eq("stripe_customer_id", customer)
        .eq("sync_token", token),
    );
  }
}
