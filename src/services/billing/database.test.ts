import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

let db: PGlite;
const oldUser = "00000000-0000-0000-0000-000000000001";
const newUser = "00000000-0000-0000-0000-000000000002";
const thirdUser = "00000000-0000-0000-0000-000000000003";
const one = async (sql: string, params: unknown[] = []) =>
  (await db.query<Record<string, unknown>>(sql, params)).rows[0];
const reserve = async (user = newUser, amount = 1000000, bounded = true) =>
  (
    await one(
      "select billing_reserve_usage($1,'lovable','openai/gpt-5.6-sol',$2,null,'assistant',$3) as result",
      [user, amount, bounded],
    )
  ).result as { allowed: boolean; code?: string; eventId: string };
const account = async (user = newUser) =>
  String((await one("select billing_ensure_member($1) as id", [user])).id);
const activate = () =>
  db.exec(
    "update billing_settings set enabled=true,activated_at=now()-interval '1 hour'",
  );
const trial = async (user = newUser, seats = 1) => {
  const id = await account(user);
  await db.query(
    "update billing_accounts set enrolled=true,status='trialing',seats=$2,trial_start=now()-interval '1 minute',trial_end=now()+interval '7 days',period_end=now()+interval '7 days' where id=$1",
    [id, seats],
  );
  return id;
};
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,created_at timestamptz,email_confirmed_at timestamptz);`);
  await db.exec(
    readFileSync(
      new URL(
        "../../../supabase/migrations/20261029010000_billing_accounts.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(`truncate billing_invitations,billing_usage_events,billing_audit,billing_webhook_events,billing_members,billing_accounts,auth.users cascade;
    update billing_settings set enabled=false,activated_at=null;`);
  for (const [id, email, age] of [
    [oldUser, "old@example.test", "2 hours"],
    [newUser, "new@example.test", "5 minutes"],
    [thirdUser, "third@example.test", "5 minutes"],
  ]) {
    await db.query(
      "insert into auth.users values($1,$2,now()-$3::interval,now())",
      [id, email, age],
    );
  }
});
describe("billing PostgreSQL migration and invariants", () => {
  it("starts disabled; old users remain grandfathered after activation, new users require checkout", async () => {
    expect((await reserve()).allowed).toBe(true);
    await activate();
    expect((await reserve(oldUser)).allowed).toBe(true);
    expect((await reserve()).code).toBe("checkout_required");
  });
  it("creates exactly one membership/account on repeated initialization", async () => {
    expect(await account()).toBe(await account());
    expect(
      (await one("select count(*)::int as n from billing_accounts")).n,
    ).toBe(1);
  });
  it("reserves the entire trial budget across attempts and settles idempotently", async () => {
    await activate();
    await trial();
    const a = await reserve(newUser, 1500000);
    expect(a.allowed).toBe(true);
    expect((await reserve(newUser, 600000)).code).toBe("trial_budget_exceeded");
    await db.query(
      "select billing_settle_usage($1,true,100,100,200000,'gpt-5.6-sol')",
      [a.eventId],
    );
    await db.query(
      "select billing_settle_usage($1,true,100,100,999999,'gpt-5.6-sol')",
      [a.eventId],
    );
    expect(
      (
        await one(
          "select shadow_micro_usd::int as cost from billing_usage_events where id=$1",
          [a.eventId],
        )
      ).cost,
    ).toBe(200000);
    expect((await reserve(newUser, 1800000)).allowed).toBe(true);
    expect((await reserve(newUser, 1)).allowed).toBe(false);
  });
  it("pools trial budgets by purchased seat, not by address or number of invitations", async () => {
    await activate();
    const id = await trial(newUser, 2);
    await db.query(
      "insert into billing_members values($1,$2,'third@example.test','member',false,null,now())",
      [thirdUser, id],
    );
    expect((await reserve(newUser, 3000000)).allowed).toBe(true);
    expect((await reserve(thirdUser, 1000000)).allowed).toBe(true);
    expect((await reserve(thirdUser, 1)).allowed).toBe(false);
  });
  it("refuses unbounded trial calls and expired trials", async () => {
    await activate();
    const id = await trial();
    expect((await reserve(newUser, 1, false)).code).toBe(
      "trial_request_unbounded",
    );
    await db.query(
      "update billing_accounts set trial_end=now()-interval '1 second' where id=$1",
      [id],
    );
    expect((await reserve()).code).toBe("trial_expired");
  });
  it("does not impose an unapproved paid AI allowance; explicit member caps still work", async () => {
    await activate();
    const id = await trial();
    await db.query("update billing_accounts set status='active' where id=$1", [
      id,
    ]);
    expect((await reserve(newUser, 50000000)).allowed).toBe(true);
    await db.query(
      "update billing_members set monthly_ai_limit_micro_usd=50000000 where user_id=$1",
      [newUser],
    );
    expect((await reserve(newUser, 1)).code).toBe("user_budget_exceeded");
  });
  it("rejects account suspension and under-purchased seats", async () => {
    await activate();
    const id = await trial();
    await db.query("update billing_accounts set suspended=true where id=$1", [
      id,
    ]);
    expect((await reserve()).code).toBe("billing_suspended");
    await db.query("update billing_accounts set suspended=false where id=$1", [
      id,
    ]);
    await db.query(
      "insert into billing_members values($1,$2,'third@example.test','member',false,null,now())",
      [thirdUser, id],
    );
    expect((await reserve()).code).toBe("seat_limit_exceeded");
  });
  it("refuses anonymous/authenticated access to tables and privileged RPCs", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(
        (
          await one(
            "select has_table_privilege($1,'billing_accounts','SELECT') as allowed",
            [role],
          )
        ).allowed,
      ).toBe(false);
      expect(
        (
          await one(
            "select has_function_privilege($1,'billing_ensure_member(uuid)','EXECUTE') as allowed",
            [role],
          )
        ).allowed,
      ).toBe(false);
    }
    expect(
      (
        await one(
          "select relrowsecurity from pg_class where relname='billing_accounts'",
        )
      ).relrowsecurity,
    ).toBe(true);
  });
  it("prohibits AI charges at the database level", async () => {
    await expect(
      db.exec("update billing_settings set enabled=true"),
    ).rejects.toThrow();
    const usage = await reserve();
    await expect(
      db.query(
        "update billing_usage_events set billable_micro_usd=1 where id=$1",
        [usage.eventId],
      ),
    ).rejects.toThrow();
    await expect(
      db.exec("update billing_settings set ai_charging_enabled=true"),
    ).rejects.toThrow();
  });
  it("accepts only verified matching invitations and never exceeds purchased capacity", async () => {
    const id = await trial(newUser, 2);
    await db.query(
      "insert into billing_invitations(account_id,email,token_hash) values($1,'third@example.test','hash')",
      [id],
    );
    await expect(
      db.query("select billing_accept_invitation($1,'hash')", [oldUser]),
    ).rejects.toThrow();
    await account(thirdUser);
    await db.query(
      "update billing_members set suspended=true, monthly_ai_limit_micro_usd=123 where user_id=$1",
      [thirdUser],
    );
    expect(
      (
        await one("select billing_accept_invitation($1,'hash') as id", [
          thirdUser,
        ])
      ).id,
    ).toBe(id);
    expect(
      await one(
        "select suspended,monthly_ai_limit_micro_usd::int as cap from billing_members where user_id=$1",
        [thirdUser],
      ),
    ).toEqual({ suspended: true, cap: 123 });
    await expect(
      db.query("select billing_accept_invitation($1,'hash')", [thirdUser]),
    ).rejects.toThrow();
    await db.query(
      "insert into billing_invitations(account_id,email,token_hash) values($1,'old@example.test','otherhash')",
      [id],
    );
    await expect(
      db.query("select billing_accept_invitation($1,'otherhash')", [oldUser]),
    ).rejects.toThrow("No available paid seat");
  });
  it("serializes checkout preparation", async () => {
    const id = await account();
    await db.query("select billing_lock_checkout($1)", [id]);
    await expect(
      db.query("select billing_lock_checkout($1)", [id]),
    ).rejects.toThrow("Checkout is already being prepared");
  });
  it("requires a valid exclusive sync lease and applies duplicate events only once", async () => {
    const id = await account();
    await db.query(
      "update billing_accounts set stripe_customer_id='cus_test' where id=$1",
      [id],
    );
    const token = String(
      (await one("select billing_claim_sync('cus_test') as token")).token,
    );
    await expect(
      db.exec("select billing_claim_sync('cus_test')"),
    ).rejects.toThrow("busy");
    const apply = (event: string, status: string, created: number) =>
      db.query(
        "select billing_apply_subscription($1,'customer.subscription.updated',$2,'cus_test','sub_test',$3,'price_test',1,null,now()+interval '1 month',false,null,$4)",
        [event, created, status, token],
      );
    await apply("evt_new", "active", 200);
    await apply("evt_new", "canceled", 200);
    expect(
      (await one("select status from billing_accounts where id=$1", [id]))
        .status,
    ).toBe("active");
    // An old delivery carries a newly retrieved authoritative snapshot, not its old payload.
    await apply("evt_old", "canceled", 100);
    expect(
      await one(
        "select status,last_stripe_event_at::int as watermark from billing_accounts where id=$1",
        [id],
      ),
    ).toEqual({ status: "canceled", watermark: 200 });
    await db.query(
      "update billing_accounts set sync_lock_until=now()-interval '1 second' where id=$1",
      [id],
    );
    await expect(apply("evt_expired", "active", 300)).rejects.toThrow(
      "lease expired",
    );
  });
});
