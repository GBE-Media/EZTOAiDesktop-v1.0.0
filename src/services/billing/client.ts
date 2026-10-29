import { externalAuthClient } from "@/integrations/external-auth/client";

export interface BillingAccount {
  id: string;
  name: string;
  billing_email?: string;
  status: string;
  seats: number;
  suspended: boolean;
  enrolled?: boolean;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  period_end?: string;
  trial_end?: string;
  cancel_at_period_end: boolean;
}
export interface BillingMember {
  user_id: string;
  email: string;
  role: string;
  suspended: boolean;
  monthly_ai_limit_micro_usd: number | null;
}
export interface BillingOverview {
  owner: boolean;
  manager: boolean;
  livemode: boolean;
  grandfathered: boolean;
  settings: {
    enabled: boolean;
    activated_at: string | null;
    ai_charging_enabled: false;
  };
  account: BillingAccount;
  accounts: BillingAccount[];
  members: BillingMember[];
  usage: Array<{
    id: string;
    user_id: string;
    model: string;
    resolved_model?: string;
    status: string;
    input_tokens: number;
    output_tokens: number;
    shadow_micro_usd: number;
    reserved_micro_usd: number;
    created_at: string;
    error_code?: string;
    usage_details?: { pricing_known?: boolean };
  }>;
  audit: Array<{
    action: string;
    created_at: string;
    detail: Record<string, unknown>;
  }>;
}
export async function billingRequest<T>(
  action: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const {
    data: { session },
  } = await externalAuthClient.auth.getSession();
  if (!session) throw new Error("Sign in to manage billing.");
  const base =
    import.meta.env.VITE_EXTERNAL_SUPABASE_URL ||
    "https://einpdmanlpadqyqnvccb.supabase.co";
  const response = await fetch(`${base}/functions/v1/billing-api`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...body, action }),
  });
  if (response.status === 404)
    throw new Error(
      "Billing has not been deployed on the server yet. Customer charging is not available.",
    );
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Billing is temporarily unavailable.");
  return data as T;
}
export function isStripeBillingUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      [
        "checkout.stripe.com",
        "billing.stripe.com",
        "dashboard.stripe.com",
      ].includes(url.hostname) &&
      (!url.port || url.port === "443")
    );
  } catch {
    return false;
  }
}
export async function openStripeBilling(value: string) {
  if (!isStripeBillingUrl(value))
    throw new Error("The server returned an unexpected billing URL.");
  if (window.electronAPI?.openExternal)
    await window.electronAPI.openExternal(value);
  else window.open(value, "_blank", "noopener,noreferrer");
}
