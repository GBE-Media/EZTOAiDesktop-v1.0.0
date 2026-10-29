import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  billingDb,
  billingCors,
  json,
  checked,
  signedIn,
  stripe,
  isPlatformOwner,
  hashToken,
  syncSubscription,
} from "../_shared/billing-runtime.ts";
import {
  validateSoftwarePrice,
  validatePortalConfiguration,
} from "../_shared/billing-policy.ts";
import { canReadAccount, canManageAccount } from "../_shared/billing-access.ts";

const liveMode = () => Deno.env.get("STRIPE_LIVEMODE") === "true";
const accountFields =
  "id,name,billing_email,status,seats,suspended,enrolled,stripe_customer_id,stripe_subscription_id,trial_end,period_end,cancel_at_period_end";
const exposeAccount = (account: Record<string, unknown>) =>
  Object.fromEntries(
    accountFields.split(",").map((key) => [key, account[key]]),
  );
function returnUrl() {
  const url = new URL(Deno.env.get("BILLING_RETURN_URL") || "");
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("Configure an HTTPS billing return page.");
  return url.href;
}
async function verifyStripe() {
  const account = await stripe("/account");
  const expected = Deno.env.get("STRIPE_EXPECTED_ACCOUNT_ID");
  if (
    !expected ||
    account.id !== expected ||
    (liveMode() && expected !== "acct_1TdgYlB4o4bAPKFn")
  ) {
    throw new Error(
      "Stripe business account does not match the configured billing account.",
    );
  }
}
serve(async (req) => {
  if (req.method === "OPTIONS")
    return new Response("ok", { headers: billingCors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const db = billingDb();
  try {
    const user = await signedIn(req, db);
    const owner = isPlatformOwner(user.id);
    const body = await req.json();
    const action = String(body.action || "overview");
    const personalAccount = checked(
      await db.rpc("billing_ensure_member", { p_user_id: user.id }),
    );
    const member = checked(
      await db
        .from("billing_members")
        .select("*")
        .eq("user_id", user.id)
        .single(),
    );
    const settings = checked(
      await db.from("billing_settings").select("*").eq("id", true).single(),
    );
    const aid =
      typeof body.accountId === "string" ? body.accountId : personalAccount;
    // Client IDs are selectors, never authorization.
    if (!canReadAccount(owner, member, aid))
      return json({ error: "Forbidden" }, 403);
    const account = checked(
      await db.from("billing_accounts").select("*").eq("id", aid).single(),
    );
    const manager = canManageAccount(owner, member, aid);
    const audit = async (name: string, detail: Record<string, unknown> = {}) =>
      checked(
        await db.from("billing_audit").insert({
          actor_user_id: user.id,
          account_id: aid,
          action: name,
          detail,
        }),
      );

    if (action === "accept_invitation") {
      if (typeof body.token !== "string" || body.token.length > 256)
        throw new Error("Invalid invitation code.");
      const id = checked(
        await db.rpc("billing_accept_invitation", {
          p_user_id: user.id,
          p_token_hash: await hashToken(body.token.trim()),
        }),
      );
      return json({ accountId: id });
    }
    if (action === "overview") {
      const accounts = owner
        ? checked(
            await db
              .from("billing_accounts")
              .select(accountFields)
              .order("created_at", { ascending: false })
              .limit(200),
          )
        : [account];
      const membersQuery = db
        .from("billing_members")
        .select("*")
        .eq("account_id", aid);
      const members = checked(
        await (manager ? membersQuery : membersQuery.eq("user_id", user.id)),
      );
      let usageQuery = db
        .from("billing_usage_events")
        .select(
          "id,user_id,provider,model,resolved_model,status,input_tokens,output_tokens,shadow_micro_usd,billable_micro_usd,reserved_micro_usd,created_at,error_code,feature,task_id,usage_details",
        )
        .eq("account_id", aid)
        .order("created_at", { ascending: false })
        .limit(200);
      if (!manager) usageQuery = usageQuery.eq("user_id", user.id);
      const usage = checked(await usageQuery);
      const auditRows = manager
        ? checked(
            await db
              .from("billing_audit")
              .select("action,detail,created_at,actor_user_id")
              .eq("account_id", aid)
              .order("created_at", { ascending: false })
              .limit(30),
          )
        : [];
      // Ordinary team members do not receive payer address, customer IDs or other users' email.
      const safeAccount = manager
        ? exposeAccount(account)
        : {
            id: account.id,
            name: account.name,
            status: account.status,
            seats: account.seats,
            trial_end: account.trial_end,
            period_end: account.period_end,
            suspended: account.suspended,
            cancel_at_period_end: account.cancel_at_period_end,
          };
      return json({
        owner,
        manager,
        account: safeAccount,
        accounts: owner ? accounts : [],
        members,
        usage,
        audit: auditRows,
        settings: {
          enabled: settings.enabled,
          activated_at: settings.activated_at,
          ai_charging_enabled: false,
        },
        grandfathered:
          !account.enrolled &&
          !!settings.activated_at &&
          new Date(user.created_at) < new Date(settings.activated_at),
        livemode: liveMode(),
      });
    }
    if (!manager)
      return json(
        { error: "Only your billing administrator can perform this action." },
        403,
      );
    if (action === "set_member_controls") {
      if (!owner)
        return json(
          {
            error:
              "AI service caps and access restrictions are controlled by the platform owner.",
          },
          403,
        );
      const target = checked(
        await db
          .from("billing_members")
          .select("*")
          .eq("user_id", body.userId)
          .eq("account_id", aid)
          .single(),
      );
      const limit = body.limitMicroUsd;
      if (
        limit !== null &&
        (!Number.isSafeInteger(limit) || limit < 0 || limit > 1_000_000_000)
      )
        throw new Error("Invalid service limit.");
      if (typeof body.suspended !== "boolean")
        throw new Error("Invalid access setting.");
      await audit("member_controls_requested", {
        userId: target.user_id,
        suspended: body.suspended,
        limitMicroUsd: limit,
      });
      checked(
        await db
          .from("billing_members")
          .update({
            suspended: body.suspended,
            monthly_ai_limit_micro_usd: limit,
          })
          .eq("user_id", target.user_id)
          .eq("account_id", aid),
      );
      return json({ ok: true });
    }
    if (action === "suspend_account") {
      if (!owner) return json({ error: "Platform owner only." }, 403);
      if (typeof body.suspended !== "boolean")
        throw new Error("Invalid access setting.");
      await audit("account_access_requested", { suspended: body.suspended });
      checked(
        await db
          .from("billing_accounts")
          .update({ suspended: body.suspended })
          .eq("id", aid),
      );
      return json({ ok: true });
    }
    if (action === "invite") {
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
        throw new Error("Enter a valid email.");
      if (!["active", "trialing"].includes(account.status) || account.suspended)
        throw new Error("Activate team billing before inviting members.");
      const count = await db
        .from("billing_members")
        .select("user_id", { count: "exact", head: true })
        .eq("account_id", aid);
      if (count.error) throw new Error(count.error.message);
      if ((count.count || 0) >= account.seats)
        throw new Error(
          "No available paid seat. Adjust seats through the owner before inviting.",
        );
      const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      await audit("invitation_requested", { email });
      checked(
        await db.from("billing_invitations").insert({
          account_id: aid,
          email,
          token_hash: await hashToken(token),
        }),
      );
      return json({
        token,
        message:
          "Share this code privately with the invited user. It expires in seven days. No email was sent.",
      });
    }
    if (action === "checkout") {
      if (!settings.enabled)
        throw new Error("Customer checkout is not live yet.");
      if (account.suspended || member.suspended)
        throw new Error("Billing access is paused.");
      if (account.stripe_subscription_id || account.enrolled)
        throw new Error(
          "This account already has a subscription. Use Manage billing.",
        );
      const seats = body.seats;
      if (!Number.isInteger(seats) || seats < 1 || seats > 100)
        throw new Error("Choose 1 to 100 seats.");
      await verifyStripe();
      const price = await stripe(`/prices/${settings.stripe_price_id}`);
      validateSoftwarePrice(price, liveMode());
      if (price.unit_amount !== 30000)
        throw new Error(
          "Launch price must be $300 per user per month. A new rate requires a reviewed release.",
        );
      const locked = checked(
        await db.rpc("billing_lock_checkout", { p_account_id: aid }),
      );
      try {
        const updateCheckout = async (patch: Record<string, unknown>) =>
          checked(
            await db
              .from("billing_accounts")
              .update(patch)
              .eq("id", aid)
              .eq("checkout_token", locked.checkout_token)
              .gt("checkout_lock_until", new Date().toISOString())
              .select("id")
              .single(),
          );
        let customer = locked.stripe_customer_id;
        if (!customer) {
          const created = await stripe(
            "/customers",
            "POST",
            {
              email: account.billing_email || user.email,
              name: account.name,
              metadata: { billing_account_id: aid },
            },
            `billing-customer-${aid}`,
          );
          if (created.livemode !== liveMode())
            throw new Error("Stripe mode mismatch.");
          customer = created.id;
          await updateCheckout({ stripe_customer_id: customer });
        }
        // Recover a prior successful API response after a network/database failure.
        const subscriptions = await stripe("/subscriptions", "GET", {
          customer,
          status: "all",
          limit: 100,
        });
        if (subscriptions.data.length || subscriptions.has_more)
          throw new Error(
            "An existing Stripe subscription needs reconciliation before another checkout.",
          );
        const sessions = await stripe("/checkout/sessions", "GET", {
          customer,
          limit: 100,
        });
        const open = sessions.data.find((s: any) => s.status === "open");
        if (open) {
          const lines = await stripe(
            `/checkout/sessions/${open.id}/line_items`,
          );
          if (
            lines.has_more ||
            lines.data.length !== 1 ||
            lines.data[0].quantity !== seats ||
            lines.data[0].price?.id !== settings.stripe_price_id
          ) {
            throw new Error(
              "An open checkout has different seats or pricing. Use its original seat selection or ask the owner to expire it before starting another.",
            );
          }
          await updateCheckout({ checkout_session_id: open.id });
          return json({ url: open.url });
        }
        if (sessions.has_more)
          throw new Error("Checkout history needs manual review.");
        if (locked.checkout_session_id) {
          const previous = await stripe(
            `/checkout/sessions/${locked.checkout_session_id}`,
          );
          if (previous.status !== "expired")
            throw new Error("Previous checkout is still being reconciled.");
          locked.checkout_attempt_id = crypto.randomUUID();
          await updateCheckout({
            checkout_attempt_id: locked.checkout_attempt_id,
            checkout_session_id: null,
          });
        }
        await audit("checkout_requested", {
          seats,
          unitAmount: price.unit_amount,
          currency: "usd",
          trialDays: 7,
          aiCharges: false,
        });
        const session = await stripe(
          "/checkout/sessions",
          "POST",
          {
            customer,
            mode: "subscription",
            client_reference_id: aid,
            line_items: [{ price: settings.stripe_price_id, quantity: seats }],
            payment_method_types: ["card"],
            payment_method_collection: "always",
            billing_address_collection: "required",
            customer_update: { address: "auto", name: "auto" },
            success_url: returnUrl(),
            cancel_url: returnUrl(),
            metadata: { billing_account_id: aid },
            subscription_data: {
              metadata: { billing_account_id: aid },
              trial_period_days: account.trial_used ? undefined : 7,
              trial_settings: {
                end_behavior: { missing_payment_method: "cancel" },
              },
            },
            custom_text: {
              submit: {
                message:
                  "$300 per user/month after 7 days. AI usage is not invoiced. Trial includes $2 of shadow-valued AI usage per seat, with no overages. Cancel before trial end to avoid the software charge.",
              },
            },
          },
          `billing-checkout-${locked.checkout_attempt_id}`,
        );
        if (session.livemode !== liveMode())
          throw new Error("Stripe mode mismatch.");
        await updateCheckout({ checkout_session_id: session.id });
        return json({ url: session.url });
      } finally {
        checked(
          await db
            .from("billing_accounts")
            .update({ checkout_lock_until: null, checkout_token: null })
            .eq("id", aid)
            .eq("checkout_token", locked.checkout_token),
        );
      }
    }
    if (action === "portal") {
      if (!account.stripe_customer_id)
        throw new Error("Complete checkout first.");
      await verifyStripe();
      const configuration = Deno.env.get("STRIPE_PORTAL_CONFIGURATION_ID");
      if (!configuration)
        throw new Error("The reviewed customer portal is not configured.");
      validatePortalConfiguration(
        await stripe(
          `/billing_portal/configurations/${encodeURIComponent(configuration)}`,
        ),
        liveMode(),
      );
      const session = await stripe("/billing_portal/sessions", "POST", {
        customer: account.stripe_customer_id,
        return_url: returnUrl(),
        configuration,
      });
      await audit("portal_session_created");
      return json({ url: session.url });
    }
    if (action === "refresh") {
      if (!account.stripe_customer_id) return json({ ok: true });
      await verifyStripe();
      const list = await stripe("/subscriptions", "GET", {
        customer: account.stripe_customer_id,
        status: "all",
        limit: 100,
      });
      const sub = account.stripe_subscription_id
        ? list.data.find((s: any) => s.id === account.stripe_subscription_id)
        : list.data.length === 1
          ? list.data[0]
          : null;
      if (!sub || list.has_more)
        throw new Error("Subscription reconciliation requires owner review.");
      if (sub.livemode !== liveMode()) throw new Error("Stripe mode mismatch.");
      // Manual refresh does not advance the event watermark: future legitimate events remain valid.
      await syncSubscription(
        db,
        sub,
        `refresh-${crypto.randomUUID()}`,
        account.last_stripe_event_at,
      );
      return json({ ok: true });
    }
    if (action === "cancel_at_period_end" || action === "resume_subscription") {
      if (!account.stripe_subscription_id) throw new Error("No subscription.");
      if (body.confirm !== true) throw new Error("Confirmation required.");
      await verifyStripe();
      await audit(`${action}_requested`);
      const sub = await stripe(
        `/subscriptions/${account.stripe_subscription_id}`,
        "POST",
        {
          cancel_at_period_end: action === "cancel_at_period_end",
        },
        `${action}-${aid}-${body.requestId || ""}`,
      );
      await syncSubscription(
        db,
        sub,
        `control-${crypto.randomUUID()}`,
        account.last_stripe_event_at,
      );
      return json({ ok: true });
    }
    return json({ error: "Unsupported billing action." }, 400);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Billing request failed.";
    console.error("[billing-api]", message);
    return json(
      {
        error:
          message === "AUTH_REQUIRED"
            ? "Sign in with a verified email to manage billing."
            : message,
      },
      message === "AUTH_REQUIRED" ? 401 : 400,
    );
  }
});
