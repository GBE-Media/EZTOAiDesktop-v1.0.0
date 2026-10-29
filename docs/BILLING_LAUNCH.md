# BidveraAi billing launch and owner operations

This release implements a staged, software-only billing integration. It does not activate customer charging by itself. The migration starts with billing disabled, and GitHub merging is not proof that Lovable's server functions are deployed.

## Approved terms

- **Business:** Bidvera LLC, live Stripe account `acct_1TdgYlB4o4bAPKFn`.
- **Software:** USD $300 per named user per month. The existing licensed monthly price is `price_1TpH6yB4o4bAPKFnLiZRI6vz`.
- **Trial:** Seven days with a card required. The entire trial includes $2 of shadow-retail-valued AI consumption per purchased seat, pooled at the payer account. There are no trial overages.
- **AI invoices:** Disabled. Both the database constraint and application prohibit AI monetary charges. The earlier proposed $10 monthly allowance and $50 overage cap are not part of this launch.
- **Enrollment:** New users after the actual activation timestamp require checkout to use the hosted AI service. Existing users retain access until they voluntarily enroll or an authorized owner explicitly pauses their AI.
- **Data:** Opening billing does not unmount the drawing workspace. Cancellation or AI suspension does not delete saved documents. This is not an offline desktop DRM system: local/manual editing remains available.

## How the owner operates it

Open the user menu, then **Billing & Users**. A server-side owner allowlist enables the cross-account selector; ordinary billing owners/admins can only manage their own payer, and members can only see their own usage.

- **Individuals and teams:** Each payer is one Stripe customer and subscription, with licensed quantity equal to purchased seats. Checkout collects the payer's address. An individual uses one seat; a team purchases multiple seats and invites verified matching emails into vacant seats. Matching postal addresses never merge accounts.
- **Monitoring:** See subscription state, seats, trial/period dates, account members, recent per-user model/token activity, pending reservations, failures and an audit trail. The first release displays the latest 200 ledger events and latest 30 audit entries, not monthly totals or a revenue dashboard. The account selector lists up to 200 ledger accounts. Legacy auth users appear after their first AI request or opening billing, not through a historical directory backfill.
- **Access controls:** The platform owner can pause a user's AI, pause an account, or set an explicit monthly per-user service cap. Customer billing administrators cannot undo those restrictions; they retain payment, invoice, invitation and cancellation access, including when their AI is paused. Caps use UTC calendar months and shadow retail values; they are not invoices or measured provider costs. A paused user still occupies a purchased seat and continues to be billed.
- **Cancellation:** Cancel at period end or undo scheduled cancellation with a confirmation card. Use Stripe for immediate cancellation, refunds or credits. Cancellation is not automatically a refund.
- **Rates and seats:** The owner-only Stripe button opens the associated customer. Make prospective price/quantity changes there after reviewing Stripe's proration preview, then use **Sync subscription**. Launch checkout remains fixed at $300/user/month; changing the default new-sale price requires a reviewed code/config change. Reducing seats below assigned memberships blocks AI until reconciled. A safe membership-removal/ownership-transfer workflow is not included in this first release; do not reduce seats before arranging that migration.
- **Customer portal:** Update payment methods, billing address and invoice information through the reviewed portal configuration. Disable subscription price/quantity editing in the portal so members cannot desynchronize seats. Enable end-of-period cancellation, not immediate cancellation.

Stripe documents licensed subscription quantities and their proration behavior in its [quantity guide](https://docs.stripe.com/billing/subscriptions/quantities). Price amounts are immutable, so changing a rate requires a new Price and an explicit subscription change, not editing historical usage ([Stripe price management](https://docs.stripe.com/products-prices/manage-prices)).

## Deployment gate: Lovable backend access is still required

The desktop targets `einpdmanlpadqyqnvccb`. The connected Supabase account exposed a different inactive project, `fldjadfvpdwkxrpzcqxy`, and denied access to the runtime project. Do not restore, migrate or deploy to that unrelated project; do not substitute credentials to bypass the denied connector access. Use authorized Lovable built-in backend management for the actual project.

### Server configuration

Configure these through Lovable's secure server-secret interface, never in desktop environment variables, git, screenshots or chat:

- `STRIPE_SECRET_KEY`: Restricted server credential with the required customer, Checkout, subscription, Price read and portal operations.
- `STRIPE_WEBHOOK_SECRET`: Signing secret of the endpoint for this exact deployment and Stripe mode.
- `STRIPE_LIVEMODE`: `false` in a sandbox; `true` only for the approved live deployment.
- `STRIPE_EXPECTED_ACCOUNT_ID`: The verified sandbox account during tests; `acct_1TdgYlB4o4bAPKFn` for live.
- `BILLING_OWNER_USER_IDS`: Comma-separated verified Supabase Auth UUIDs for the business owner. Never derive owner status from a user-editable profile, email domain or request body.
- `BILLING_RETURN_URL`: An existing controlled HTTPS page telling the customer to return to the desktop and select **Sync subscription**. Redirects do not grant access.
- `STRIPE_PORTAL_CONFIGURATION_ID`: Reviewed same-mode portal configuration, with payment/address/invoice updates and period-end cancellation enabled, subscription item/quantity edits disabled.
- Existing Supabase service credentials and AI-provider secrets remain server-only.

Checkout uses Stripe API version `2025-06-30.basil`. Webhook handling supports subscription events, Checkout completion and relevant invoice events; it fetches current subscription state rather than trusting redirect parameters or old event snapshots.

### Ordered rollout

1. Inspect and back up the actual live schema through authorized Lovable access. This migration adds isolated `billing_*` tables and does not assume the legacy `ai_usage` schema matches git. Confirm no existing objects have conflicting names before applying it transactionally.
2. First deploy to an isolated authorized sandbox, using a sandbox $300/month licensed Price instead of the migration's live default. Do not use live cards for tests. Configure secrets, portal and controlled return page there.
3. Apply `20261029010000_billing_accounts.sql` with billing disabled. Deploy `billing-api`, `billing-webhook`, their `_shared` dependencies, then `ai-proxy`. The proxy deliberately fails closed if its billing reservation RPC is unavailable, so never deploy it before the migration.
4. Register the webhook at the runtime `billing-webhook` URL, in the matching Stripe account/mode, with subscription created/updated/deleted, checkout.session.completed, invoice.paid and invoice.payment_failed events. Preserve exact raw request bytes for HMAC verification. Confirm webhook retry delivery.
5. Run the sandbox acceptance checklist below. Verify provider token reporting and image bounds with real supported models. Approve the business's tax treatment, legal terms, trial disclosures and cancellation handling before production activation; this code does not automatically enable Stripe Tax or determine tax obligations. Review the existing dependency-audit findings before paid launch: the current audit reports 24 findings in the non-development dependency graph, including three critical findings (`concurrently`, `shell-quote`, `tar`). This is a dependency report, not proof that the shipped app is exploitable; assess reachability and remediation separately. The newly added PGlite development test dependency is not listed in the audit findings.
6. Deploy the approved desktop release and server integration while billing remains disabled. Validate existing accounts and drawing workflows, and bootstrap the verified owner UUID. Confirm no pending migration or backend version mismatch.
7. Only after the previous checks pass, activate through an authorized server-side transaction:

   ```sql
   begin;
   update public.billing_settings
     set enabled=true, activated_at=coalesce(activated_at,now()), updated_at=now()
     where id=true;
   insert into public.billing_audit(action,detail)
     values('rollout_activated',jsonb_build_object('scope','new users only','aiCharges',false));
   commit;
   ```

   The actual activation timestamp, not the time the user approved pricing, is the grandfathering cutoff. Never reset the cutoff when temporarily pausing enforcement.
8. Verify production Checkout displays the correct business, amount, seats, card-required seven-day trial and address collection before accepting a real customer's voluntary enrollment. Observe signed webhook processing and account reconciliation. Do not create a live test charge.

Turning `billing_settings.enabled=false` is an emergency enrollment/enforcement switch, not subscription cancellation. Existing Stripe subscriptions will continue billing until separately canceled. The proxy still requires its ledger to be available and still enforces explicit access pauses and per-user service caps.

## Acceptance checklist

- Card-required sandbox Checkout for one and multiple seats, expiry, cancellation, duplicate clicks, network recovery and mode/account mismatch.
- Trial-to-paid renewal, payment failure, late webhook delivery, duplicate delivery, reversed delivery order, same-second events, sync lease timeout and manual refresh.
- Two authenticated users in different payers cannot read or mutate each other's account through the API; ordinary members cannot create checkout, portal sessions, invitations or account controls.
- Team invitation verified-email mismatch, expiry, reuse, last-seat contention and attempted transfer from an existing paid account.
- Concurrent trial requests reserve before inference; failed provider responses settle to zero; uncertain network outcomes retain reservations for reconciliation.
- Supported image formats/dimensions and unknown models/long context cannot bypass the trial reservation guard. Conservative reservations may refuse a request even when its eventual actual usage would have fit; do not truncate count output silently to fit.
- Database clients cannot write billing rows or execute service-only RPCs; AI charging constraints cannot be enabled accidentally.
- Old-user grandfathering uses the true activation cutoff. New-user hosted AI requests cannot bypass checkout from an older desktop client.
- Cancellation, suspension and switching billing views preserve saved drawings, takeoff counts and runs.

Automated unit/database tests are not proof of real Stripe Checkout, payment collection, live RLS roles or Lovable deployment. Sign off on these sandbox and production checks separately.

## Usage accounting and operational limits

The ledger records provider/model, token counts, user, payer, status and optional task/feature metadata. It does not store prompts, images or documents. Existing callers that do not supply task IDs appear as individual assistant attempts; historical job grouping and actual supplier invoice reconciliation are not implemented.

Trial/service-cap valuation uses `trial-shadow-2026-10-v1`: Luna $0.60/$3.60, Sol $12/$60, GPT-5.5 $15/$90, Opus 4.7 $15/$75 per million input/output tokens. These are shadow retail rates, not provider costs and not approved AI invoice prices. Cached input is conservatively valued at the input rate. An unknown actual model or missing usage is flagged/unresolved rather than represented as verified zero cost.

Reservations lock the payer row, preventing concurrent allowance checks from overspending the available reservation budget. They use conservative UTF-8 text bounds and generous allowances for known PNG/JPEG images up to 4096 pixels per side; unknown formats or models and potentially long-context requests are blocked under trial/service caps. Validate the bound against real gateway behavior before enabling charging; it is not a verified supplier-cost ceiling. Pending reservations are not automatically released on a timer. Reconcile them against provider activity before a service-role correction, and append an audit entry explaining the outcome.

Current limitations: no invoice-based profit dashboard, no automatic owner alerts, no automatic historical backfill, no user deletion/ownership transfer UI, no configurable default sales rates UI, and no paid AI overage meter. A request returning provider HTTP failure is recorded as a failed attempt with zero customer usage; any supplier cost for that failure still requires invoice reconciliation outside this ledger.
