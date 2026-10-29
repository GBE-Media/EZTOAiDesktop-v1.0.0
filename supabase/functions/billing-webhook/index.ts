import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  billingDb,
  json,
  stripe,
  syncSubscription,
} from "../_shared/billing-runtime.ts";
import { verifyWebhookSignature } from "../_shared/billing-webhook-signature.ts";

serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const raw = await req.text();
    if (
      !(await verifyWebhookSignature(
        raw,
        req.headers.get("stripe-signature") || "",
        Deno.env.get("STRIPE_WEBHOOK_SECRET") || "",
      ))
    ) {
      return json({ error: "Invalid signature" }, 400);
    }
    const event = JSON.parse(raw);
    if (event.livemode !== (Deno.env.get("STRIPE_LIVEMODE") === "true"))
      return json({ error: "Stripe mode mismatch" }, 400);
    const supported = [
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
      "checkout.session.completed",
      "invoice.paid",
      "invoice.payment_failed",
    ];
    if (!supported.includes(event.type))
      return json({ received: true, ignored: true });
    const object = event.data.object;
    const rawId = event.type.startsWith("customer.subscription.")
      ? object.id
      : object.subscription ||
        object.parent?.subscription_details?.subscription;
    const subId = typeof rawId === "string" ? rawId : rawId?.id;
    if (!subId) return json({ received: true, ignored: true });
    // Retrieve current authoritative state instead of trusting an old delivery snapshot.
    const subscription = await stripe(
      `/subscriptions/${encodeURIComponent(subId)}`,
    );
    if (subscription.livemode !== event.livemode)
      throw new Error("Stripe mode mismatch");
    const applied = await syncSubscription(
      billingDb(),
      subscription,
      event.id,
      event.created,
      event.type,
    );
    // Unrelated subscriptions in the same business are deliberately ignored.
    return json({ received: true, applied });
  } catch (error) {
    console.error(
      "[billing-webhook]",
      error instanceof Error ? error.message : "Webhook failure",
    );
    return json({ error: "Webhook processing failed; retry required." }, 500);
  }
});
