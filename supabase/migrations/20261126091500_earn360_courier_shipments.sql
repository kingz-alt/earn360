-- Earn360 courier shipment queue and member assignment fields
create table if not exists public.earn360_courier_shipments (
  id uuid primary key default gen_random_uuid(),
  product_name text not null,
  client_name text not null,
  address text not null,
  city text not null,
  country text not null,
  shipment_reference text not null unique,
  required_action text not null default 'verify_details'
    check (required_action in ('verify_details','confirm_sorting','confirm_dispatch','confirm_scan')),
  handling_instructions text not null default '',
  eligible_rank text not null default 'all',
  eligible_country text,
  status text not null default 'available'
    check (status in ('available','assigned','completed','paused')),
  assigned_user_id uuid references auth.users(id),
  assigned_date date,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(trim(product_name)) between 2 and 140),
  check (length(trim(client_name)) between 2 and 120),
  check (length(trim(address)) between 3 and 180),
  check (length(trim(city)) between 2 and 90),
  check (length(trim(country)) between 2 and 90)
);
alter table public.earn360_courier_shipments enable row level security;
grant all on public.earn360_courier_shipments to service_role;

alter table public.earn360_courier_task_assignments
  add column if not exists shipment_id uuid references public.earn360_courier_shipments(id),
  add column if not exists product_name text,
  add column if not exists client_name text,
  add column if not exists address text,
  add column if not exists city text,
  add column if not exists country text,
  add column if not exists shipment_reference text,
  add column if not exists required_action text,
  add column if not exists handling_instructions text;

create unique index if not exists earn360_courier_assignment_shipment_unique
  on public.earn360_courier_task_assignments(shipment_id) where shipment_id is not null;
create index if not exists earn360_courier_shipments_available_idx
  on public.earn360_courier_shipments(status, eligible_rank, eligible_country, created_at);

create or replace function earn360_private.generate_daily_courier_tasks(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, earn360_private
as $$
declare
  v_day date := (now() at time zone 'Africa/Lome')::date;
  v_added integer := 0;
  v_n integer := 0;
  v_rank text;
  v_country text;
  v_s record;
  v_operation text;
begin
  if extract(isodow from v_day) > 5 then return 0; end if;
  select mp.name, p.country into v_rank, v_country
  from public.memberships m
  join public.membership_plans mp on mp.id=m.plan_id
  join public.profiles p on p.id=m.user_id
  where m.user_id=p_user_id and m.status='active'
    and coalesce(m.starts_at,m.purchased_at)<=now()
    and (m.ends_at is null or m.ends_at>=now())
  order by m.purchased_at desc limit 1;
  if v_rank is null then return 0; end if;
  select count(*) into v_n
  from public.earn360_courier_task_assignments
  where user_id=p_user_id and assigned_date=v_day;
  if v_n >= 4 then return 0; end if;
  for v_s in
    select s.* from public.earn360_courier_shipments s
    where s.status='available'
      and (s.eligible_rank='all' or lower(s.eligible_rank)=lower(v_rank))
      and (s.eligible_country is null or upper(s.eligible_country)=upper(v_country))
    order by s.created_at asc
    for update skip locked
    limit (4-v_n)
  loop
    v_operation := case v_s.required_action
      when 'confirm_sorting' then 'sorting'
      when 'confirm_dispatch' then 'dispatch'
      when 'confirm_scan' then 'intake'
      else 'address_check'
    end;
    insert into public.earn360_courier_task_assignments(
      user_id,assigned_date,task_number,operation,title,parcel_code,
      origin_hub,destination,recipient,prompt,options,expected_answer,status,
      shipment_id,product_name,client_name,address,city,country,
      shipment_reference,required_action,handling_instructions
    ) values (
      p_user_id,v_day,v_n+1,v_operation,'Courier shipment: '||v_s.product_name,
      v_s.shipment_reference,'Assigned courier network',
      v_s.city||', '||v_s.country,v_s.client_name,
      coalesce(nullif(v_s.handling_instructions,''),'Review the parcel details and complete the assigned handling action.'),
      '[]'::jsonb,v_s.required_action,'assigned',
      v_s.id,v_s.product_name,v_s.client_name,v_s.address,v_s.city,v_s.country,
      v_s.shipment_reference,v_s.required_action,v_s.handling_instructions
    )
    on conflict(user_id,assigned_date,task_number) do nothing;
    update public.earn360_courier_shipments
    set status='assigned',assigned_user_id=p_user_id,assigned_date=v_day,updated_at=now()
    where id=v_s.id and status='available';
    v_n := v_n+1;
    v_added := v_added+1;
  end loop;
  return v_added;
end;
$$;
