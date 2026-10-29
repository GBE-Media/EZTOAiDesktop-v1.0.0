import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  billingRequest,
  openStripeBilling,
  type BillingOverview,
  type BillingMember,
} from "@/services/billing/client";

const money = (micro: number) =>
  (micro / 1_000_000).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  });
const date = (value?: string) =>
  value ? new Date(value).toLocaleDateString() : "Not available";

function MemberRow({
  member,
  manager,
  busy,
  onChange,
}: {
  member: BillingMember;
  manager: boolean;
  busy: boolean;
  onChange: (
    member: BillingMember,
    limit: number | null,
    suspended: boolean,
  ) => void;
}) {
  const [limit, setLimit] = useState(
    member.monthly_ai_limit_micro_usd === null
      ? ""
      : String(member.monthly_ai_limit_micro_usd / 1_000_000),
  );
  const valid =
    limit === "" ||
    (Number.isFinite(Number(limit)) &&
      Number(limit) >= 0 &&
      Number(limit) <= 1000);
  return (
    <tr className="border-b border-border">
      <td className="py-3 pr-4">
        <span className="block break-all">{member.email}</span>
        <span className="text-xs text-muted-foreground">
          {member.role} · {member.suspended ? "AI paused" : "AI enabled"}
        </span>
      </td>
      <td className="py-3 pr-4">
        {manager ? (
          <label className="flex items-center gap-2">
            <span className="sr-only">
              Monthly AI service limit for {member.email}
            </span>
            <Input
              className="w-28"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              type="number"
              min="0"
              max="1000"
              step="0.01"
              placeholder="No cap"
            />
            <span className="text-xs text-muted-foreground">
              USD equivalent
            </span>
          </label>
        ) : member.monthly_ai_limit_micro_usd === null ? (
          "No cap"
        ) : (
          money(member.monthly_ai_limit_micro_usd)
        )}
      </td>
      {manager && (
        <td className="py-3">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={busy || !valid}
              onClick={() =>
                onChange(
                  member,
                  limit === "" ? null : Math.round(Number(limit) * 1e6),
                  member.suspended,
                )
              }
            >
              Save limit
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                onChange(
                  member,
                  member.monthly_ai_limit_micro_usd,
                  !member.suspended,
                )
              }
            >
              {member.suspended ? "Enable AI" : "Pause AI"}
            </Button>
          </div>
        </td>
      )}
    </tr>
  );
}
export function BillingPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [data, setData] = useState<BillingOverview | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [seats, setSeats] = useState(1);
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [invitation, setInvitation] = useState("");
  const [confirm, setConfirm] = useState<{
    title: string;
    description: string;
    run: () => Promise<void>;
  } | null>(null);
  const version = useRef(0);
  const load = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    setError("");
    try {
      const value = await billingRequest<BillingOverview>(
        "overview",
        selected ? { accountId: selected } : {},
      );
      if (current === version.current) setData(value);
    } catch (e) {
      if (current === version.current)
        setError(e instanceof Error ? e.message : "Billing is unavailable.");
    } finally {
      if (current === version.current) setLoading(false);
    }
  }, [selected]);
  const invalidate = useCallback(() => {
    version.current++;
  }, []);
  useEffect(() => {
    if (open) void load();
    return invalidate;
  }, [open, load, invalidate]);
  const run = async (action: string, args: Record<string, unknown> = {}) => {
    setBusy(true);
    setError("");
    try {
      const result = await billingRequest<{
        url?: string;
        token?: string;
        message?: string;
      }>(action, { accountId: data?.account.id, ...args });
      if (result.url) await openStripeBilling(result.url);
      if (result.token) setInvitation(result.token);
      if (action === "accept_invitation") {
        setToken("");
        setSelected("");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Billing request failed.");
    } finally {
      setBusy(false);
    }
  };
  const memberChange = (
    member: BillingMember,
    limit: number | null,
    suspended: boolean,
  ) =>
    setConfirm({
      title: `Update ${member.email}?`,
      description: `AI access will be ${suspended ? "paused" : "enabled"}. The UTC-calendar-month AI service cap will be ${limit === null ? "unlimited by this setting" : money(limit) + " in shadow usage"}. This cap is not an invoice amount. The paid seat and subscription are unchanged.`,
      run: () =>
        run("set_member_controls", {
          userId: member.user_id,
          limitMicroUsd: limit,
          suspended,
        }),
    });
  const account = data?.account;
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="w-[calc(100vw-2rem)] max-w-5xl max-h-[90vh] overflow-y-auto overflow-x-hidden [&>section]:min-w-0 [&>div]:min-w-0">
          <DialogHeader>
            <DialogTitle>Billing &amp; Users</DialogTitle>
            <DialogDescription>
              Individual and team billing, with usage attributed to each user.
              AI usage is tracked, not invoiced.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={busy || loading}
            >
              {loading ? "Loading…" : "Refresh view"}
            </Button>
            {data?.owner && (
              <label className="flex flex-wrap items-center gap-2 text-sm">
                Billing account
                <select
                  aria-label="Billing account"
                  className="max-w-full rounded border border-input bg-background p-2"
                  disabled={busy || loading}
                  value={selected || account?.id}
                  onChange={(e) => {
                    setSelected(e.target.value);
                    setInvitation("");
                    setData(null);
                  }}
                >
                  {data.accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.billing_email || a.name} · {a.status}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {error && (
            <div
              role="alert"
              className="rounded border border-destructive/50 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          )}
          {data && account && (
            <>
              <div className="rounded border border-border bg-muted/30 p-4 text-sm">
                <p className="font-medium">
                  {data.settings.enabled
                    ? data.livemode
                      ? "Live billing rollout"
                      : "Stripe test mode"
                    : "Customer charging is OFF"}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {data.grandfathered
                    ? "Your existing account retains its access. No retroactive software charges."
                    : "New subscriptions: $300 per user/month after a seven-day, card-required trial."}{" "}
                  AI invoice charges are $0. Trial AI allowance is $2 of
                  shadow-valued usage per seat for the entire trial, with no
                  overages.
                </p>
              </div>
              <section aria-label="Subscription" className="space-y-3">
                <h3 className="text-base font-semibold">{account.name}</h3>
                <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">Subscription</dt>
                    <dd className="mt-1 font-medium">
                      {account.status.replace(/_/g, " ")}
                      {account.suspended ? " · AI paused" : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Purchased seats</dt>
                    <dd className="mt-1 font-medium">{account.seats}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {account.cancel_at_period_end
                        ? "Cancels on"
                        : "Period ends"}
                    </dt>
                    <dd className="mt-1 font-medium">
                      {date(account.period_end)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Trial ends</dt>
                    <dd className="mt-1 font-medium">
                      {date(account.trial_end)}
                    </dd>
                  </div>
                </dl>
                {data.manager && (
                  <div className="flex flex-wrap items-center gap-2">
                    {!account.stripe_subscription_id && !account.enrolled && (
                      <>
                        <label className="flex items-center gap-2 text-sm">
                          Seats
                          <Input
                            className="w-20"
                            type="number"
                            min={1}
                            max={100}
                            value={seats}
                            onChange={(e) => setSeats(Number(e.target.value))}
                          />
                        </label>
                        <Button
                          disabled={
                            !data.settings.enabled ||
                            busy ||
                            !Number.isInteger(seats) ||
                            seats < 1 ||
                            seats > 100
                          }
                          onClick={() =>
                            setConfirm({
                              title: "Start your seven-day trial?",
                              description: `You are selecting ${seats} user seat${seats === 1 ? "" : "s"} at $300 each per month: $${seats * 300}/month after the trial. A card and billing address are required. Cancel before trial end to avoid the software charge. AI is not invoiced; the trial includes $${seats * 2} of shadow-valued AI usage in total. You will review the subscription in Stripe before enrolling.`,
                              run: () => run("checkout", { seats }),
                            })
                          }
                        >
                          Start trial in Stripe
                        </Button>
                      </>
                    )}
                    {account.stripe_customer_id && (
                      <>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run("portal")}
                        >
                          Manage payment &amp; invoices
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() => void run("refresh")}
                        >
                          Sync subscription
                        </Button>
                      </>
                    )}
                    {account.stripe_subscription_id &&
                      ["active", "trialing"].includes(account.status) && (
                        <Button
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            setConfirm({
                              title: account.cancel_at_period_end
                                ? "Keep the subscription active?"
                                : "Cancel at the end of this period?",
                              description: account.cancel_at_period_end
                                ? "This removes scheduled cancellation. Recurring software charges continue under the existing subscription terms."
                                : `Access continues through ${date(account.period_end)}. No refund is issued by this action. During a trial, cancel before the trial ends to avoid the software charge.`,
                              run: () =>
                                run(
                                  account.cancel_at_period_end
                                    ? "resume_subscription"
                                    : "cancel_at_period_end",
                                  {
                                    confirm: true,
                                    requestId: crypto.randomUUID(),
                                  },
                                ),
                            })
                          }
                        >
                          {account.cancel_at_period_end
                            ? "Keep subscription"
                            : "Cancel at period end"}
                        </Button>
                      )}
                    {data.owner && account.stripe_customer_id && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          void openStripeBilling(
                            `https://dashboard.stripe.com/${data.livemode ? "" : "test/"}customers/${account.stripe_customer_id}`,
                          ).catch((e) => setError(e.message))
                        }
                      >
                        Owner: rates, seats &amp; refunds in Stripe
                      </Button>
                    )}
                    {data.owner && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            title: account.suspended
                              ? "Enable account AI?"
                              : "Pause all account AI?",
                            description:
                              "This changes AI access only. Software billing, purchased seats, and saved documents are unchanged.",
                            run: () =>
                              run("suspend_account", {
                                suspended: !account.suspended,
                              }),
                          })
                        }
                      >
                        {account.suspended
                          ? "Enable account AI"
                          : "Pause account AI"}
                      </Button>
                    )}
                  </div>
                )}
                {data.owner && (
                  <p className="text-xs text-muted-foreground">
                    Rate changes, seat changes, immediate cancellations and
                    refunds are managed in Stripe for this release. Review
                    prorations there before saving, then sync the subscription.
                    Launch checkout remains $300/user/month. Pausing AI does not
                    stop billing or remove a seat.
                  </p>
                )}
              </section>
              <section className="space-y-3">
                <h3 className="text-base font-semibold">
                  Users &amp; AI service limits
                </h3>
                <p className="text-xs text-muted-foreground">
                  Service caps use shadow retail values, not measured supplier
                  cost or customer charges. No paid-plan AI cap is added
                  automatically. Saved documents are not deleted or transferred.
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[620px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-border text-xs text-muted-foreground">
                        <th className="pb-2">User</th>
                        <th className="pb-2">Monthly AI service cap</th>
                        {data.owner && <th className="pb-2">Controls</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((m) => (
                        <MemberRow
                          key={`${m.user_id}-${m.suspended}-${m.monthly_ai_limit_micro_usd}`}
                          member={m}
                          manager={data.owner}
                          busy={busy}
                          onChange={memberChange}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {data.manager && (
                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="max-w-xs"
                      aria-label="Invited user's email"
                      placeholder="Team member email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      type="email"
                    />
                    <Button
                      variant="outline"
                      disabled={busy || !email}
                      onClick={() => void run("invite", { email })}
                    >
                      Create team invitation
                    </Button>
                  </div>
                )}
                {invitation && (
                  <div className="rounded border p-3 text-sm">
                    <p>
                      Share this code privately with the invited user. It
                      expires in seven days; no email was sent.
                    </p>
                    <code className="mt-2 block select-all break-all text-xs">
                      {invitation}
                    </code>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  <Input
                    className="max-w-xs"
                    aria-label="Invitation code"
                    placeholder="Invitation code"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    disabled={busy || !token}
                    onClick={() =>
                      setConfirm({
                        title: "Join the invited billing account?",
                        description:
                          "Your verified email must match the invitation. The team must have a vacant purchased seat. Existing paid subscriptions are not silently canceled or transferred. Your saved documents stay with you.",
                        run: () => run("accept_invitation", { token }),
                      })
                    }
                  >
                    Accept invitation
                  </Button>
                </div>
              </section>
              <section className="space-y-3">
                <h3 className="text-base font-semibold">Recent AI usage</h3>
                <p className="text-xs text-muted-foreground">
                  Latest 200 attempts for this account (your own attempts if you
                  are a member), not a monthly total. Pending reservations
                  require reconciliation if an attempt's outcome is unknown. All
                  AI invoice charges are $0.
                </p>
                {!data.usage.length ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    No usage recorded in the new billing ledger yet. Historical
                    provider logs are not backfilled.
                  </p>
                ) : (
                  <div className="max-h-72 overflow-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="sticky top-0 bg-background">
                        <tr>
                          <th className="py-2 pr-3">Time / user</th>
                          <th className="pr-3">Model</th>
                          <th className="pr-3">Status</th>
                          <th className="pr-3">Input / output</th>
                          <th>Shadow usage</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.usage.map((u) => (
                          <tr key={u.id} className="border-t border-border">
                            <td className="py-2 pr-3">
                              {new Date(u.created_at).toLocaleString()}
                              <span className="block text-muted-foreground">
                                {data.members.find(
                                  (m) => m.user_id === u.user_id,
                                )?.email || u.user_id}
                              </span>
                            </td>
                            <td className="pr-3">
                              {u.resolved_model || u.model}
                            </td>
                            <td className="pr-3">
                              {u.status}
                              {u.error_code && (
                                <span className="block">{u.error_code}</span>
                              )}
                            </td>
                            <td className="pr-3 tabular-nums">
                              {u.input_tokens.toLocaleString()} /{" "}
                              {u.output_tokens.toLocaleString()}
                            </td>
                            <td className="tabular-nums">
                              {u.status === "reserved"
                                ? `${money(u.reserved_micro_usd)} reserved`
                                : u.usage_details?.pricing_known === false
                                  ? "Unpriced / conservative reserve"
                                  : money(u.shadow_micro_usd)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              {data.manager && (
                <details className="text-xs">
                  <summary className="cursor-pointer font-medium">
                    Recent account audit (latest 30 entries)
                  </summary>
                  <ul className="mt-2 space-y-2">
                    {data.audit.map((a, i) => (
                      <li key={i}>
                        {new Date(a.created_at).toLocaleString()} ·{" "}
                        {a.action.replace(/_/g, " ")}
                        <pre className="whitespace-pre-wrap break-all text-muted-foreground">
                          {JSON.stringify(a.detail)}
                        </pre>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {data.owner && (
                <p className="text-xs text-muted-foreground">
                  The selector shows up to 200 accounts enrolled in this ledger.
                  Users appear after opening billing or making an AI request;
                  this is not a complete historical auth-user directory.
                </p>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={!!confirm}
        onOpenChange={(value) => {
          if (!value) setConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Go back</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = confirm;
                setConfirm(null);
                if (action) void action.run();
              }}
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
