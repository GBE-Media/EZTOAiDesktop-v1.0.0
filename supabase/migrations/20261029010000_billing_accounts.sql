-- Additive billing schema. Does not alter the drifted legacy ai_usage tables.
-- All writes/reads go through authenticated Edge Functions using service_role.
create table public.billing_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  activated_at timestamptz,
  stripe_price_id text not null default 'price_1TpH6yB4o4bAPKFnLiZRI6vz',
  trial_days integer not null default 7 check (trial_days = 7),
  trial_micro_usd_per_seat bigint not null default 2000000 check (trial_micro_usd_per_seat = 2000000),
  ai_charging_enabled boolean not null default false check (not ai_charging_enabled),
  updated_at timestamptz not null default now(),
  check (not enabled or activated_at is not null)
);
insert into public.billing_settings(id) values (true);

create table public.billing_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id),
  name text not null,
  billing_email text,
  billing_address jsonb,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  stripe_price_id text,
  status text not null default 'not_enrolled',
  seats integer not null default 1 check (seats between 1 and 100),
  trial_end timestamptz,
  trial_start timestamptz,
  period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  suspended boolean not null default false,
  enrolled boolean not null default false,
  trial_used boolean not null default false,
  checkout_attempt_id uuid not null default gen_random_uuid(),
  checkout_session_id text,
  checkout_lock_until timestamptz,
  checkout_token uuid,
  sync_token uuid,
  sync_lock_until timestamptz,
  last_stripe_event_at bigint not null default 0,
  created_at timestamptz not null default now()
);
create table public.billing_members (
  user_id uuid primary key references auth.users(id),
  account_id uuid not null references public.billing_accounts(id),
  email text not null,
  role text not null default 'member' check (role in ('owner','admin','member')),
  suspended boolean not null default false,
  monthly_ai_limit_micro_usd bigint check (monthly_ai_limit_micro_usd >= 0),
  created_at timestamptz not null default now()
);
create index billing_members_account on public.billing_members(account_id);
create table public.billing_invitations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.billing_accounts(id),
  email text not null,
  token_hash text unique not null,
  expires_at timestamptz not null default now() + interval '7 days',
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.billing_usage_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.billing_accounts(id),
  user_id uuid not null references auth.users(id),
  task_id text,
  feature text not null default 'assistant',
  provider text not null,
  model text not null,
  resolved_model text,
  status text not null default 'reserved' check (status in ('reserved','succeeded','failed')),
  reserved_micro_usd bigint not null check (reserved_micro_usd >= 0),
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  shadow_micro_usd bigint not null default 0,
  billable_micro_usd bigint not null default 0 check (billable_micro_usd = 0),
  rate_version text not null default 'trial-shadow-2026-10-v1',
  usage_details jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index billing_usage_user_date on public.billing_usage_events(user_id, created_at);
create index billing_usage_account_date on public.billing_usage_events(account_id, created_at);
create table public.billing_audit (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id),
  account_id uuid references public.billing_accounts(id),
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create table public.billing_webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);

-- Return or create a user's personal account once; joining a team is explicit.
create function public.billing_ensure_member(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare a uuid; u auth.users%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 771));
  select account_id into a from billing_members where user_id = p_user_id;
  if a is not null then return a; end if;
  select * into strict u from auth.users where id = p_user_id;
  insert into billing_accounts(owner_user_id, name, billing_email)
    values(p_user_id, 'Personal account', u.email) returning id into a;
  insert into billing_members(user_id, account_id, email, role)
    values(p_user_id, a, coalesce(u.email, ''), 'owner');
  return a;
end $$;

-- Serialized reservations prevent concurrent calls overspending a trial/user cap.
-- Stale reservations are intentionally NOT auto-released: reconcile uncertain attempts.
create function public.billing_reserve_usage(
  p_user_id uuid, p_provider text, p_model text, p_reserve bigint,
  p_task_id text default null, p_feature text default 'assistant', p_bounded boolean default false
) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  aid uuid; a billing_accounts%rowtype; m billing_members%rowtype;
  cfg billing_settings%rowtype; joined_at timestamptz; spent bigint; eid uuid; legacy boolean;
begin
  if p_reserve < 0 or p_reserve > 1000000000 then raise exception 'Invalid reservation'; end if;
  aid := billing_ensure_member(p_user_id);
  select * into strict a from billing_accounts where id = aid for update;
  select * into strict m from billing_members where user_id = p_user_id for update;
  select * into strict cfg from billing_settings where id;
  select created_at into strict joined_at from auth.users where id = p_user_id;
  legacy := not a.enrolled and cfg.activated_at is not null and joined_at < cfg.activated_at;
  if a.suspended or m.suspended then
    return jsonb_build_object('allowed', false, 'code', 'billing_suspended', 'message', 'AI access is paused. Contact your billing administrator.');
  end if;
  if cfg.enabled and not legacy then
    if (select count(*) from billing_members where account_id=aid) > a.seats then
      return jsonb_build_object('allowed',false,'code','seat_limit_exceeded','message','This billing account has more assigned users than subscribed seats. Ask your billing administrator to reconcile seats.');
    end if;
    if a.status not in ('active','trialing') or not a.enrolled then
      return jsonb_build_object('allowed', false, 'code', 'checkout_required', 'message', 'Start your card-required seven-day trial in Billing & Users to use AI. Saved documents remain available.');
    end if;
    if a.period_end is null or a.period_end <= now() then
      return jsonb_build_object('allowed', false, 'code', 'billing_sync_required', 'message', 'Subscription verification is due. Open Billing & Users to refresh your subscription.');
    end if;
    if a.status = 'trialing' then
      if not p_bounded then
        return jsonb_build_object('allowed', false, 'code', 'trial_request_unbounded', 'message', 'This model or image size cannot be safely covered by the trial budget. Use a supported model and images no larger than 4096 pixels per side.');
      end if;
      if a.trial_end is null or a.trial_end <= now() then
        return jsonb_build_object('allowed', false, 'code', 'trial_expired', 'message', 'Your trial ended. Refresh billing to verify your paid subscription.');
      end if;
      select coalesce(sum(case when status = 'reserved' then reserved_micro_usd else shadow_micro_usd end),0)
        into spent from billing_usage_events where account_id = aid and status <> 'failed'
        and created_at >= coalesce(a.trial_start,a.created_at);
      if spent + p_reserve > cfg.trial_micro_usd_per_seat * a.seats then
        return jsonb_build_object('allowed', false, 'code', 'trial_budget_exceeded', 'message', 'Your trial cannot cover the maximum AI usage of this request. No AI overage will be charged.',
          'usedMicroUsd', spent, 'limitMicroUsd', cfg.trial_micro_usd_per_seat * a.seats);
      end if;
    end if;
  end if;
  if m.monthly_ai_limit_micro_usd is not null then
    if not p_bounded then return jsonb_build_object('allowed',false,'code','user_budget_unbounded','message','This request cannot be bounded by your administrator-set AI service limit.'); end if;
    select coalesce(sum(case when status = 'reserved' then reserved_micro_usd else shadow_micro_usd end),0)
      into spent from billing_usage_events where user_id = p_user_id
      and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' and status <> 'failed';
    if spent + p_reserve > m.monthly_ai_limit_micro_usd then
      return jsonb_build_object('allowed', false, 'code', 'user_budget_exceeded', 'message', 'Your administrator-set AI service limit cannot cover this request. No AI overage will be charged.');
    end if;
  end if;
  insert into billing_usage_events(account_id, user_id, provider, model, reserved_micro_usd, task_id, feature)
    values(aid, p_user_id, p_provider, p_model, p_reserve, left(p_task_id,128), left(p_feature,64))
    returning id into eid;
  return jsonb_build_object('allowed',true,'eventId',eid,'accountId',aid,'grandfathered',legacy,'aiChargingEnabled',false);
end $$;

create function public.billing_settle_usage(
  p_event_id uuid, p_success boolean, p_input bigint, p_output bigint, p_shadow bigint,
  p_model text, p_details jsonb default null, p_error text default null
) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if least(p_input,p_output,p_shadow) < 0 then raise exception 'Invalid usage'; end if;
  update billing_usage_events set status = case when p_success then 'succeeded' else 'failed' end,
    input_tokens = p_input, output_tokens = p_output,
    shadow_micro_usd = case when p_success then p_shadow else 0 end,
    resolved_model = p_model, usage_details = p_details, error_code = left(p_error,120),
    settled_at = now()
  where id = p_event_id and status = 'reserved';
end $$;

-- Verify external state before calling this. Event receipt and snapshot apply atomically.
create function public.billing_apply_subscription(
  p_event_id text, p_event_type text, p_event_created bigint, p_customer text,
  p_subscription text, p_status text, p_price text, p_seats integer,
  p_trial_end timestamptz, p_period_end timestamptz, p_cancel boolean, p_trial_start timestamptz default null,
  p_sync_token uuid default null
) returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare a billing_accounts%rowtype;
begin
  select * into a from billing_accounts where stripe_customer_id = p_customer for update;
  if a.id is null then return false; end if;
  if p_sync_token is null or a.sync_token is distinct from p_sync_token or a.sync_lock_until <= now() then
    raise exception 'Subscription reconciliation lease expired';
  end if;
  if exists(select 1 from billing_webhook_events where stripe_event_id = p_event_id) then return true; end if;
  if a.stripe_subscription_id is not null and a.stripe_subscription_id <> p_subscription then
    raise exception 'Account already has a different subscription';
  end if;
  -- The caller fetches current Stripe state AFTER obtaining the exclusive lease.
  -- Thus even an old delivery refreshes current state rather than replaying its payload.
    update billing_accounts set stripe_subscription_id=p_subscription, status=p_status, stripe_price_id=p_price,
      seats=p_seats, trial_end=p_trial_end, trial_start=p_trial_start, period_end=p_period_end, cancel_at_period_end=p_cancel,
      enrolled = enrolled or p_status in ('active','trialing'),
      trial_used = trial_used or p_trial_end is not null,
      last_stripe_event_at=greatest(p_event_created,last_stripe_event_at)
      where id=a.id;
  insert into billing_webhook_events(stripe_event_id,event_type) values(p_event_id,p_event_type) on conflict do nothing;
  return true;
end $$;

create function public.billing_claim_sync(p_customer text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare a billing_accounts%rowtype; token uuid := gen_random_uuid();
begin
  select * into a from billing_accounts where stripe_customer_id=p_customer for update;
  if a.id is null then return null; end if;
  if a.sync_lock_until > now() then raise exception 'Subscription reconciliation is busy; retry required'; end if;
  update billing_accounts set sync_token=token,sync_lock_until=now()+interval '2 minutes' where id=a.id;
  return token;
end $$;

create function public.billing_lock_checkout(p_account_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare a billing_accounts%rowtype; token uuid := gen_random_uuid();
begin
  select * into strict a from billing_accounts where id=p_account_id for update;
  if a.checkout_lock_until > now() then raise exception 'Checkout is already being prepared. Retry shortly.'; end if;
  update billing_accounts set checkout_lock_until=now()+interval '2 minutes',checkout_token=token where id=a.id;
  return to_jsonb(a) || jsonb_build_object('checkout_token',token);
end $$;

create function public.billing_accept_invitation(p_user_id uuid, p_token_hash text)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare inv billing_invitations%rowtype; a billing_accounts%rowtype; old billing_accounts%rowtype; u auth.users%rowtype; n int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,771));
  select * into strict u from auth.users where id=p_user_id;
  select * into inv from billing_invitations where token_hash=p_token_hash for update;
  if inv.id is null or inv.accepted_at is not null or inv.expires_at <= now()
    or lower(inv.email) <> lower(u.email) or u.email_confirmed_at is null then raise exception 'Invitation is invalid or not for this verified email'; end if;
  select * into strict a from billing_accounts where id=inv.account_id for update;
  if a.suspended or a.status not in ('trialing','active') then raise exception 'Team billing must be active'; end if;
  select count(*) into n from billing_members where account_id=a.id;
  if n >= a.seats then raise exception 'No available paid seat'; end if;
  select ba.* into old from billing_accounts ba join billing_members bm on bm.account_id=ba.id where bm.user_id=p_user_id;
  if old.id = a.id then raise exception 'Already a team member'; end if;
  if old.id is not null and (old.enrolled or (select count(*) from billing_members where account_id=old.id)>1) then
    raise exception 'Existing paid or multi-user accounts require an owner-reviewed transfer before joining';
  end if;
  insert into billing_members(user_id,account_id,email,role) values(p_user_id,a.id,u.email,'member')
    on conflict(user_id) do update set account_id=excluded.account_id, role='member';
  update billing_invitations set accepted_at=now() where id=inv.id;
  insert into billing_audit(actor_user_id,account_id,action,detail)
    values(p_user_id,a.id,'invitation_accepted',jsonb_build_object('previousAccountId',old.id));
  return a.id;
end $$;

do $$
declare t text; f record;
begin
  foreach t in array array['billing_settings','billing_accounts','billing_members','billing_invitations','billing_usage_events','billing_audit','billing_webhook_events'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant all on public.%I to service_role',t);
  end loop;
  for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('billing_ensure_member','billing_reserve_usage','billing_settle_usage','billing_apply_subscription','billing_accept_invitation','billing_lock_checkout','billing_claim_sync') loop
    execute format('revoke all on function %s from public, anon, authenticated',f.signature);
    execute format('grant execute on function %s to service_role',f.signature);
  end loop;
end $$;
