
-- Earn360 backend core alignment for the live schema.
-- Financial operations are server-only. Do not expose service-role credentials in the browser.
create schema if not exists earn360_private;
revoke all on schema earn360_private from public, anon, authenticated;
grant usage on schema earn360_private to service_role;

alter table public.membership_plans
  add column if not exists price_usd numeric(12,2),
  add column if not exists weekly_reward_usd numeric(12,2),
  add column if not exists duration_calendar_days integer not null default 35,
  add column if not exists earning_days integer not null default 25;
update public.membership_plans set
  price_usd = case name when 'Starter' then 25 when 'Bronze' then 45 when 'Silver' then 75 when 'Gold' then 100 when 'Platinum' then 150 else coalesce(price_php,0) end,
  weekly_reward_usd = case name when 'Starter' then 8 when 'Bronze' then 14 when 'Silver' then 24 when 'Gold' then 32 when 'Platinum' then 48 else 0 end
where price_usd is null or weekly_reward_usd is null;
insert into public.membership_plans(name,price_php,price_usd,weekly_reward_usd,active)
values ('Starter',25,25,8,true),('Bronze',45,45,14,true),('Silver',75,75,24,true),('Gold',100,100,32,true),('Platinum',150,150,48,true)
on conflict(name) do update set price_usd=excluded.price_usd,weekly_reward_usd=excluded.weekly_reward_usd,active=true;

alter table public.memberships
 add column if not exists starts_at timestamptz,
 add column if not exists ends_at timestamptz,
 add column if not exists earning_days_completed integer not null default 0;
alter table public.deposits
 add column if not exists purpose text not null default 'Wallet funding',
 add column if not exists membership_id uuid references public.memberships(id),
 add column if not exists reviewed_by uuid references auth.users(id),
 add column if not exists reviewed_at timestamptz;
alter table public.withdrawal_requests
 add column if not exists payout_reference text,
 add column if not exists request_key text,
 add column if not exists admin_note text,
 add column if not exists updated_at timestamptz not null default now();
create unique index if not exists withdrawal_requests_request_key_uidx on public.withdrawal_requests(user_id,request_key) where request_key is not null;
alter table public.wallet_transactions add column if not exists description text;
alter table public.earn360_referrals
 add column if not exists commission_paid_at timestamptz,
 add column if not exists commission_amount numeric(12,2),
 add column if not exists commission_subscription_id uuid references public.memberships(id);
alter table public.wallet_transactions drop constraint if exists wallet_transactions_transaction_type_check;
alter table public.wallet_transactions add constraint wallet_transactions_transaction_type_check
 check(transaction_type in ('deposit','task_reward','withdrawal','refund','referral_commission'));

create table if not exists public.support_tickets (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 subject text not null check(length(trim(subject)) between 1 and 160),
 message text not null check(length(trim(message)) between 1 and 5000),
 status text not null default 'open' check(status in ('open','in_progress','closed')),
 created_at timestamptz not null default now()
);
create table if not exists public.earn360_settings (
 key text primary key,value jsonb not null default '{}'::jsonb,
 updated_at timestamptz not null default now(),updated_by uuid references auth.users(id)
);
create table if not exists public.earn360_activity_submissions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 activity_type text not null check(activity_type in ('watch','walk')),
 earning_date date not null,
 videos_completed integer not null default 0 check(videos_completed between 0 and 4),
 verified_steps integer not null default 0 check(verified_steps between 0 and 100000),
 evidence_path text,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 admin_note text,reviewed_by uuid references auth.users(id),reviewed_at timestamptz,
 reward_amount numeric(12,2) not null default 0,created_at timestamptz not null default now(),
 unique(user_id,earning_date)
);
create table if not exists public.earn360_videos (
 id uuid primary key default gen_random_uuid(),title text not null,storage_path text not null unique,
 duration_seconds integer,sequence_number integer not null unique,active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists public.earn360_video_assignments (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 earning_date date not null,video_id uuid not null references public.earn360_videos(id),
 position smallint not null check(position between 1 and 4),completed_at timestamptz,
 watched_seconds integer not null default 0 check(watched_seconds>=0),created_at timestamptz not null default now(),
 unique(user_id,earning_date,video_id),unique(user_id,earning_date,position)
);

alter table public.support_tickets enable row level security;
alter table public.earn360_settings enable row level security;
alter table public.earn360_activity_submissions enable row level security;
alter table public.earn360_videos enable row level security;
alter table public.earn360_video_assignments enable row level security;
drop policy if exists "Members can read own support tickets" on public.support_tickets;
create policy "Members can read own support tickets" on public.support_tickets for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "Members can create own support tickets" on public.support_tickets;
create policy "Members can create own support tickets" on public.support_tickets for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists "Members can read own activity submissions" on public.earn360_activity_submissions;
create policy "Members can read own activity submissions" on public.earn360_activity_submissions for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "Members can read own video assignments" on public.earn360_video_assignments;
create policy "Members can read own video assignments" on public.earn360_video_assignments for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "deny client settings" on public.earn360_settings;
create policy "deny client settings" on public.earn360_settings for all to anon,authenticated using(false) with check(false);
drop policy if exists "deny client video library" on public.earn360_videos;
create policy "deny client video library" on public.earn360_videos for all to anon,authenticated using(false) with check(false);

drop policy if exists "Update own profile" on public.profiles;
drop policy if exists "profile update own" on public.profiles;
revoke insert,update,delete on public.profiles from anon,authenticated;
revoke insert,update,delete on public.wallets,public.membership_plans,public.memberships,public.wallet_transactions,
 public.withdrawal_requests,public.deposits,public.earn360_referral_codes,public.earn360_referrals,
 public.earn360_activity_submissions,public.earn360_videos,public.earn360_video_assignments,public.earn360_settings
 from anon,authenticated;
grant select on public.profiles,public.wallets,public.membership_plans,public.memberships,public.wallet_transactions,
 public.withdrawal_requests,public.deposits,public.earn360_referral_codes,public.earn360_referrals,
 public.earn360_activity_submissions,public.earn360_video_assignments to authenticated;
grant insert,select on public.support_tickets to authenticated;

drop policy if exists "Read own profile" on public.profiles;
create policy "Read own profile" on public.profiles for select to authenticated using(id=(select auth.uid()));
drop policy if exists "Read own wallet" on public.wallets;
create policy "Read own wallet" on public.wallets for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "Read own memberships" on public.memberships;
create policy "Read own memberships" on public.memberships for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "Read own submissions" on public.task_submissions;
create policy "Read own submissions" on public.task_submissions for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "Submit own tasks" on public.task_submissions;
create policy "Submit own tasks" on public.task_submissions for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists "Read own transactions" on public.wallet_transactions;
create policy "Read own transactions" on public.wallet_transactions for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "Read own withdrawals" on public.withdrawal_requests;
create policy "Read own withdrawals" on public.withdrawal_requests for select to authenticated using(user_id=(select auth.uid()));
drop policy if exists "Request own withdrawals" on public.withdrawal_requests;
create policy "Request own withdrawals" on public.withdrawal_requests for insert to authenticated with check(user_id=(select auth.uid()));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('earn360-private','earn360-private',false,5242880,array['image/jpeg','image/png','image/webp','video/mp4','video/webm'])
on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=array['image/jpeg','image/png','image/webp','video/mp4','video/webm'];

create or replace function earn360_private.request_withdrawal(p_user_id uuid,p_amount numeric,p_method text,p_destination text,p_request_key text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare w public.wallets%rowtype; v public.withdrawal_requests%rowtype;
begin
 if p_amount not in (12,30,50,70,100) then raise exception 'Choose $12, $30, $50, $70 or $100.'; end if;
 if lower(coalesce(p_method,''))<>'paypal' then raise exception 'PayPal is the only supported payout method.'; end if;
 if p_destination !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid PayPal email address.'; end if;
 if coalesce(p_request_key,'')='' then raise exception 'Request key is required.'; end if;
 select * into v from public.withdrawal_requests where user_id=p_user_id and request_key=p_request_key;
 if found then return jsonb_build_object('id',v.id,'amount',v.amount,'fee',v.fee,'net_amount',v.net_amount,'status',v.status,'duplicate',true); end if;
 select * into w from public.wallets where user_id=p_user_id for update;
 if not found or w.balance<p_amount then raise exception 'Insufficient available wallet balance.'; end if;
 update public.wallets set balance=balance-p_amount,updated_at=now() where user_id=p_user_id;
 insert into public.withdrawal_requests(user_id,amount,fee,net_amount,payment_method,account_details,status,request_key)
 values(p_user_id,p_amount,round(p_amount*0.15,2),round(p_amount*0.85,2),'PayPal',p_destination,'pending',p_request_key) returning * into v;
 insert into public.wallet_transactions(user_id,transaction_type,amount,reference,status,description)
 values(p_user_id,'withdrawal',p_amount,'withdrawal:'||v.id,'pending','PayPal withdrawal reserved pending admin review');
 return jsonb_build_object('id',v.id,'amount',v.amount,'fee',v.fee,'net_amount',v.net_amount,'status',v.status);
end $$;
revoke all on function earn360_private.request_withdrawal(uuid,numeric,text,text,text) from public,anon,authenticated;
grant execute on function earn360_private.request_withdrawal(uuid,numeric,text,text,text) to service_role;

create or replace function earn360_private.review_withdrawal(p_admin_id uuid,p_withdrawal_id uuid,p_action text,p_payout_reference text,p_admin_note text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare v public.withdrawal_requests%rowtype;
begin
 if not exists(select 1 from public.profiles where id=p_admin_id and role in ('admin','super_admin')) then raise exception 'Administrator access required.'; end if;
 select * into v from public.withdrawal_requests where id=p_withdrawal_id for update;
 if not found or v.status<>'pending' then raise exception 'Withdrawal is not pending.'; end if;
 if p_action='paid' then
  if length(trim(coalesce(p_payout_reference,'')))<3 then raise exception 'Payout confirmation reference is required.'; end if;
  update public.withdrawal_requests set status='paid',payout_reference=left(p_payout_reference,180),updated_at=now() where id=v.id;
  update public.wallet_transactions set status='successful',description='PayPal payout sent: '||left(p_payout_reference,180) where reference='withdrawal:'||v.id;
 elsif p_action='reject' then
  if length(trim(coalesce(p_admin_note,'')))<2 then raise exception 'A rejection reason is required.'; end if;
  update public.withdrawal_requests set status='rejected',admin_note=left(p_admin_note,500),updated_at=now() where id=v.id;
  update public.wallets set balance=balance+v.amount,updated_at=now() where user_id=v.user_id;
  update public.wallet_transactions set status='failed' where reference='withdrawal:'||v.id;
  insert into public.wallet_transactions(user_id,transaction_type,amount,reference,status,description)
  values(v.user_id,'refund',v.amount,'withdrawal-refund:'||v.id,'successful','Withdrawal refund: '||left(p_admin_note,350));
 else raise exception 'Invalid withdrawal action.'; end if;
 return jsonb_build_object('id',v.id,'status',case when p_action='paid' then 'paid' else 'rejected' end);
end $$;
revoke all on function earn360_private.review_withdrawal(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function earn360_private.review_withdrawal(uuid,uuid,text,text,text) to service_role;

create or replace function earn360_private.review_deposit(p_admin_id uuid,p_deposit_id uuid,p_action text,p_admin_note text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare d public.deposits%rowtype; m public.memberships%rowtype; p public.membership_plans%rowtype;
 is_wallet boolean; commission numeric(12,2); referral public.earn360_referrals%rowtype;
begin
 if not exists(select 1 from public.profiles where id=p_admin_id and role in ('admin','super_admin')) then raise exception 'Administrator access required.'; end if;
 select * into d from public.deposits where id=p_deposit_id for update;
 if not found or d.status<>'pending' then raise exception 'Deposit is not pending.'; end if;
 if p_action='reject' then
  if length(trim(coalesce(p_admin_note,'')))<2 then raise exception 'A rejection reason is required.'; end if;
  update public.deposits set status='rejected',admin_note=left(p_admin_note,500),reviewed_by=p_admin_id,reviewed_at=now(),updated_at=now() where id=d.id;
  return jsonb_build_object('id',d.id,'status','rejected');
 end if;
 if p_action<>'approve' then raise exception 'Invalid deposit action.'; end if;
 is_wallet := lower(coalesce(d.purpose,'')) in ('wallet funding','wallet top-up','wallet top up','wallet topup');
 if is_wallet then
  update public.wallets set balance=balance+d.amount,updated_at=now() where user_id=d.user_id;
  if not found then raise exception 'Member wallet was not found.'; end if;
  insert into public.wallet_transactions(user_id,transaction_type,amount,reference,status,description)
  values(d.user_id,'deposit',d.amount,'deposit:'||d.id,'successful','Verified PayPal wallet funding');
 else
  if d.membership_id is not null then
   select * into m from public.memberships where id=d.membership_id and user_id=d.user_id for update;
  else
   select ms.* into m from public.memberships ms join public.membership_plans mp on mp.id=ms.plan_id
    where ms.user_id=d.user_id and ms.status='pending' and lower(mp.name)=lower(d.purpose)
    order by ms.purchased_at desc limit 1 for update of ms;
  end if;
  if m.id is null then raise exception 'No matching pending membership request was found.'; end if;
  select * into p from public.membership_plans where id=m.plan_id and active=true;
  if not found then raise exception 'Membership plan is no longer active.'; end if;
  if d.amount<p.price_usd then raise exception 'Verified payment amount is below the membership price.'; end if;
  update public.memberships set status='active',starts_at=now(),ends_at=now()+interval '35 days' where id=m.id;
  insert into public.wallet_transactions(user_id,transaction_type,amount,reference,status,description)
  values(d.user_id,'deposit',d.amount,'subscription-payment:'||d.id,'successful','Verified PayPal subscription payment: '||p.name);
  select * into referral from public.earn360_referrals where referred_user_id=d.user_id for update;
  if found and referral.referrer_user_id is not null and referral.commission_paid_at is null
   and not exists(select 1 from public.memberships old where old.user_id=d.user_id and old.id<>m.id and old.status in ('active','expired')) then
   commission:=round(p.price_usd*0.12,2);
   update public.wallets set balance=balance+commission,updated_at=now() where user_id=referral.referrer_user_id;
   insert into public.wallet_transactions(user_id,transaction_type,amount,reference,status,description)
   values(referral.referrer_user_id,'referral_commission',commission,'referral-commission:'||d.user_id,'successful','12% commission on first verified subscription purchase');
   update public.earn360_referrals set commission_paid_at=now(),commission_amount=commission,commission_subscription_id=m.id where referred_user_id=d.user_id;
  end if;
 end if;
 update public.deposits set status='approved',admin_note=nullif(left(coalesce(p_admin_note,''),500),''),reviewed_by=p_admin_id,reviewed_at=now(),updated_at=now() where id=d.id;
 return jsonb_build_object('id',d.id,'status','approved','wallet_funding',is_wallet);
end $$;
revoke all on function earn360_private.review_deposit(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function earn360_private.review_deposit(uuid,uuid,text,text) to service_role;

create or replace function earn360_private.review_activity_submission(p_admin_id uuid,p_submission_id uuid,p_action text,p_admin_note text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public
as $$
declare s public.earn360_activity_submissions%rowtype; m public.memberships%rowtype;
 p public.membership_plans%rowtype; reward numeric(12,2); assigned_count integer; done_count integer;
begin
 if not exists(select 1 from public.profiles where id=p_admin_id and role in ('admin','super_admin')) then raise exception 'Administrator access required.'; end if;
 select * into s from public.earn360_activity_submissions where id=p_submission_id for update;
 if not found or s.status<>'pending' then raise exception 'Activity submission is not pending.'; end if;
 if p_action='reject' then
  if length(trim(coalesce(p_admin_note,'')))<2 then raise exception 'A rejection reason is required.'; end if;
  update public.earn360_activity_submissions set status='rejected',admin_note=left(p_admin_note,500),reviewed_by=p_admin_id,reviewed_at=now() where id=s.id;
  return jsonb_build_object('id',s.id,'status','rejected');
 end if;
 if p_action<>'approve' then raise exception 'Invalid activity review action.'; end if;
 if s.activity_type='walk' and s.verified_steps<4000 then raise exception 'At least 4,000 steps are required.'; end if;
 if s.activity_type='watch' then
  select count(*),count(*) filter(where completed_at is not null) into assigned_count,done_count from public.earn360_video_assignments where user_id=s.user_id and earning_date=s.earning_date;
  if assigned_count<>4 or done_count<>4 then raise exception 'All four assigned videos must be completed before approval.'; end if;
 end if;
 select * into m from public.memberships where user_id=s.user_id and status='active' and starts_at<=now() and ends_at>=now() order by starts_at desc limit 1 for update;
 if not found then raise exception 'An active membership is required.'; end if;
 select * into p from public.membership_plans where id=m.plan_id;
 reward:=round(coalesce(p.weekly_reward_usd,0)/5,2);
 if reward<=0 then raise exception 'This membership has no configured daily reward.'; end if;
 update public.wallets set balance=balance+reward,updated_at=now() where user_id=s.user_id;
 insert into public.wallet_transactions(user_id,transaction_type,amount,reference,status,description)
 values(s.user_id,'task_reward',reward,'activity-reward:'||s.id,'successful',case when s.activity_type='walk' then 'Approved Walk & Earn activity' else 'Approved Watch & Earn activity' end);
 update public.earn360_activity_submissions set status='approved',reward_amount=reward,reviewed_by=p_admin_id,reviewed_at=now(),admin_note=nullif(left(coalesce(p_admin_note,''),500),'') where id=s.id;
 update public.memberships set earning_days_completed=least(25,earning_days_completed+1) where id=m.id;
 return jsonb_build_object('id',s.id,'status','approved','reward',reward);
end $$;
revoke all on function earn360_private.review_activity_submission(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function earn360_private.review_activity_submission(uuid,uuid,text,text) to service_role;

create or replace function public.earn360_request_withdrawal(p_user_id uuid,p_amount numeric,p_method text,p_destination text,p_request_key text)
returns jsonb language sql security definer set search_path=pg_catalog,earn360_private
as $$ select earn360_private.request_withdrawal(p_user_id,p_amount,p_method,p_destination,p_request_key); $$;
create or replace function public.earn360_review_withdrawal(p_admin_id uuid,p_withdrawal_id uuid,p_action text,p_payout_reference text,p_admin_note text)
returns jsonb language sql security definer set search_path=pg_catalog,earn360_private
as $$ select earn360_private.review_withdrawal(p_admin_id,p_withdrawal_id,p_action,p_payout_reference,p_admin_note); $$;
create or replace function public.earn360_review_deposit(p_admin_id uuid,p_deposit_id uuid,p_action text,p_admin_note text)
returns jsonb language sql security definer set search_path=pg_catalog,earn360_private
as $$ select earn360_private.review_deposit(p_admin_id,p_deposit_id,p_action,p_admin_note); $$;
create or replace function public.earn360_review_activity_submission(p_admin_id uuid,p_submission_id uuid,p_action text,p_admin_note text)
returns jsonb language sql security definer set search_path=pg_catalog,earn360_private
as $$ select earn360_private.review_activity_submission(p_admin_id,p_submission_id,p_action,p_admin_note); $$;
revoke all on function public.earn360_request_withdrawal(uuid,numeric,text,text,text) from public,anon,authenticated;
revoke all on function public.earn360_review_withdrawal(uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function public.earn360_review_deposit(uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.earn360_review_activity_submission(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.earn360_request_withdrawal(uuid,numeric,text,text,text) to service_role;
grant execute on function public.earn360_review_withdrawal(uuid,uuid,text,text,text) to service_role;
grant execute on function public.earn360_review_deposit(uuid,uuid,text,text) to service_role;
grant execute on function public.earn360_review_activity_submission(uuid,uuid,text,text) to service_role;

create unique index if not exists deposits_transaction_id_unique on public.deposits(transaction_id) where transaction_id is not null and transaction_id<>'';
create index if not exists deposits_membership_id_idx on public.deposits(membership_id);
create index if not exists deposits_reviewed_by_idx on public.deposits(reviewed_by);
create index if not exists deposits_user_id_idx on public.deposits(user_id);
create index if not exists activity_submissions_reviewed_by_idx on public.earn360_activity_submissions(reviewed_by);
create index if not exists referral_codes_owner_idx on public.earn360_referral_codes(owner_user_id);
create index if not exists referrals_commission_subscription_idx on public.earn360_referrals(commission_subscription_id);
create index if not exists referrals_referral_code_idx on public.earn360_referrals(referral_code);
create index if not exists referrals_referrer_idx on public.earn360_referrals(referrer_user_id);
create index if not exists settings_updated_by_idx on public.earn360_settings(updated_by);
create index if not exists video_assignments_video_id_idx on public.earn360_video_assignments(video_id);
create index if not exists memberships_plan_id_idx on public.memberships(plan_id);
create index if not exists memberships_user_id_idx on public.memberships(user_id);
create index if not exists support_tickets_user_id_idx on public.support_tickets(user_id);
create index if not exists task_submissions_task_id_idx on public.task_submissions(task_id);
create index if not exists task_submissions_user_id_idx on public.task_submissions(user_id);
create index if not exists wallet_transactions_user_id_idx on public.wallet_transactions(user_id);
create index if not exists withdrawal_requests_user_id_idx on public.withdrawal_requests(user_id);
create index if not exists deposits_status_created_idx on public.deposits(status,created_at);
create index if not exists withdrawal_status_created_idx on public.withdrawal_requests(status,created_at);
create index if not exists activity_status_created_idx on public.earn360_activity_submissions(status,created_at);
