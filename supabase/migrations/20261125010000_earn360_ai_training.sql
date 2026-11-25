-- Earn360 AI Training: localized daily tasks, private task assets, and idempotent rewards.
create extension if not exists pg_cron with schema pg_catalog;

alter table public.profiles add column if not exists preferred_language text;
alter table public.profiles drop constraint if exists profiles_preferred_language_check;
alter table public.profiles add constraint profiles_preferred_language_check
  check (preferred_language is null or preferred_language in ('en','fr','sw'));

update public.profiles
set preferred_language = case
  when country in ('TG','BJ','BF','CI','SN','NE','ML','GN','GA','CD','CG','TD','CF','MG','CM','RW','BI','HT','FR','BE','CH','LU') then 'fr'
  when country = 'TZ' then 'sw'
  else 'en'
end
where preferred_language is null;

create table if not exists public.earn360_ai_tasks (
  id uuid primary key default gen_random_uuid(),
  task_type text not null check (task_type in ('audio','image','image_labeling','text','translation')),
  language_code text not null default 'en' check (language_code in ('en','fr','sw')),
  title text not null,
  instructions text not null default '',
  prompt text not null,
  audio_text text,
  options jsonb not null default '[]'::jsonb,
  expected_answer text not null,
  asset_path text,
  asset_mime text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint earn360_ai_task_media_check check (
    (task_type = 'audio' and (asset_path is null or asset_mime like 'audio/%')) or
    (task_type in ('image','image_labeling') and (asset_path is null or asset_mime like 'image/%')) or
    task_type in ('text','translation')
  )
);
alter table public.earn360_ai_tasks add column if not exists language_code text not null default 'en';
alter table public.earn360_ai_tasks add column if not exists audio_text text;
alter table public.earn360_ai_tasks drop constraint if exists earn360_ai_tasks_language_code_check;
alter table public.earn360_ai_tasks add constraint earn360_ai_tasks_language_code_check check (language_code in ('en','fr','sw'));
create index if not exists earn360_ai_tasks_language_active_idx
  on public.earn360_ai_tasks(language_code, active);

create table if not exists public.earn360_ai_task_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid not null references public.earn360_ai_tasks(id),
  assigned_date date not null,
  status text not null default 'assigned' check (status in ('assigned','approved')),
  submitted_answer text,
  submitted_at timestamptz,
  checked_at timestamptz,
  created_at timestamptz not null default now(),
  unique(user_id, assigned_date, task_id)
);
create index if not exists earn360_ai_assignments_user_day_idx
  on public.earn360_ai_task_assignments(user_id, assigned_date);

create table if not exists public.earn360_ai_training_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  earning_date date not null,
  tasks_required integer not null,
  tasks_completed integer not null default 0,
  reward_amount numeric(12,2) not null default 0,
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  completed_at timestamptz,
  primary key(user_id, earning_date)
);

alter table public.earn360_ai_tasks enable row level security;
alter table public.earn360_ai_task_assignments enable row level security;
alter table public.earn360_ai_training_days enable row level security;
grant all on public.earn360_ai_tasks to service_role;
grant all on public.earn360_ai_task_assignments to service_role;
grant all on public.earn360_ai_training_days to service_role;

insert into public.earn360_ai_tasks(task_type,language_code,title,instructions,prompt,audio_text,options,expected_answer)
select v.task_type,v.language_code,v.title,v.instructions,v.prompt,v.audio_text,v.options::jsonb,v.expected_answer
from (values
 ('audio','en','Listen and choose','Tap Play audio, listen to the short sentence, then choose the answer.','What greeting did you hear?','Good morning. How are you?','["Good morning","Good night","Goodbye"]','Good morning'),
 ('audio','en','Listen for a number','Listen to the spoken sentence and choose the number.','How many books does the speaker have?','I have three books.','["2","3","4"]','3'),
 ('text','en','Quick reading check','Read the sentence and choose the matching word.','Which word means the opposite of “hot”?',null,'["Cold","Fast","Bright"]','Cold'),
 ('text','en','Positive or negative','Choose the correct label.','The sentence is: “I love this day.” Is the feeling positive or negative?',null,'["Positive","Negative"]','Positive'),
 ('translation','en','Basic English meaning','Choose the correct English meaning.','What does “Bonjour” mean in English?',null,'["Hello","Good night","Thank you"]','Hello'),
 ('translation','en','Translate one word','Choose the correct English meaning.','What does the French word “Chat” mean?',null,'["Cat","Dog","Bird"]','Cat'),
 ('audio','fr','Écoutez et choisissez','Appuyez sur Lire l’audio, écoutez la phrase puis choisissez la réponse.','Quel mot avez-vous entendu ?','Bonjour, comment allez-vous ?','["Bonjour","Bonsoir","Merci"]','Bonjour'),
 ('audio','fr','Écoutez un nombre','Écoutez la phrase et choisissez le bon nombre.','Combien de livres la personne a-t-elle ?','J’ai trois livres.','["2","3","4"]','3'),
 ('text','fr','Lecture facile','Lisez la question et choisissez la bonne réponse.','Quel est le contraire de « chaud » ?',null,'["Froid","Rapide","Grand"]','Froid'),
 ('text','fr','Sentiment simple','Choisissez la bonne étiquette.','La phrase « J’aime cette journée » exprime-t-elle un sentiment positif ou négatif ?',null,'["Positif","Négatif"]','Positif'),
 ('translation','fr','Vocabulaire simple','Choisissez la bonne traduction en français.','Que signifie « Thank you » en français ?',null,'["Merci","Bonjour","Au revoir"]','Merci'),
 ('translation','fr','Mot courant','Choisissez la bonne traduction.','Que signifie le mot anglais « Water » ?',null,'["Eau","Maison","Livre"]','Eau'),
 ('audio','sw','Sikiliza na uchague','Bonyeza Cheza sauti, sikiliza sentensi kisha uchague jibu.','Ni salamu gani umesikia?','Habari za asubuhi.','["Habari za asubuhi","Usiku mwema","Kwaheri"]','Habari za asubuhi'),
 ('text','sw','Kusoma kwa urahisi','Soma swali na uchague jibu sahihi.','Kinyume cha neno “moto” ni nini?',null,'["Baridi","Haraka","Kubwa"]','Baridi'),
 ('text','sw','Hisia rahisi','Chagua jibu sahihi.','Sentensi hii ina hisia chanya au hasi: “Ninaipenda siku hii.”',null,'["Chanya","Hasi"]','Chanya'),
 ('translation','sw','Maneno ya kawaida','Chagua tafsiri sahihi ya Kiswahili.','Neno “Thank you” kwa Kiswahili ni nini?',null,'["Asante","Habari","Kwaheri"]','Asante'),
 ('translation','sw','Tafsiri rahisi','Chagua tafsiri sahihi ya Kiswahili.','Neno “Water” kwa Kiswahili ni nini?',null,'["Maji","Nyumba","Kitabu"]','Maji')
) as v(task_type,language_code,title,instructions,prompt,audio_text,options,expected_answer)
where not exists (
  select 1 from public.earn360_ai_tasks t
  where t.language_code=v.language_code and t.prompt=v.prompt
);

insert into public.earn360_settings(key,value,updated_at)
values ('ai_training', jsonb_build_object('daily_task_count',5,'auto_publish',true,'auto_check',true,'easy_mode',true), now())
on conflict (key) do update
set value = coalesce(public.earn360_settings.value,'{}'::jsonb) ||
  jsonb_build_object('daily_task_count',5,'auto_publish',true,'auto_check',true,'easy_mode',true),
  updated_at = now();

create or replace function public.earn360_assign_daily_ai_training_tasks()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_day date := (now() at time zone 'Africa/Lome')::date;
  v_count integer := 5;
  v_user record;
  v_task record;
  v_added integer := 0;
  v_for_user integer;
begin
  if extract(isodow from v_day) > 5 then return 0; end if;
  select greatest(1, least(20, coalesce((value->>'daily_task_count')::integer,5)))
  into v_count from public.earn360_settings where key='ai_training';
  v_count := coalesce(v_count,5);

  for v_user in
    select distinct m.user_id,
      coalesce(p.preferred_language, case
        when p.country in ('TG','BJ','BF','CI','SN','NE','ML','GN','GA','CD','CG','TD','CF','MG','CM','RW','BI','HT','FR','BE','CH','LU') then 'fr'
        when p.country = 'TZ' then 'sw'
        else 'en' end) as lang
    from public.memberships m
    join public.profiles p on p.id=m.user_id
    where m.status='active'
      and coalesce(m.starts_at,m.purchased_at) <= now()
      and (m.ends_at is null or m.ends_at >= now())
  loop
    select count(*) into v_for_user
    from public.earn360_ai_task_assignments
    where user_id=v_user.user_id and assigned_date=v_day;

    if v_for_user < v_count then
      for v_task in
        select t.id from public.earn360_ai_tasks t
        where t.active=true and t.language_code=v_user.lang
          and (t.task_type not in ('image','image_labeling') or t.asset_path is not null)
          and not exists (
            select 1 from public.earn360_ai_task_assignments a
            where a.user_id=v_user.user_id and a.task_id=t.id and a.assigned_date >= v_day - 30
          )
        order by random() limit (v_count-v_for_user)
      loop
        insert into public.earn360_ai_task_assignments(user_id,task_id,assigned_date)
        values(v_user.user_id,v_task.id,v_day)
        on conflict(user_id,assigned_date,task_id) do nothing;
        v_added := v_added + 1;
      end loop;

      select count(*) into v_for_user
      from public.earn360_ai_task_assignments
      where user_id=v_user.user_id and assigned_date=v_day;

      if v_for_user < v_count then
        for v_task in
          select t.id from public.earn360_ai_tasks t
          where t.active=true and t.language_code=v_user.lang
            and (t.task_type not in ('image','image_labeling') or t.asset_path is not null)
            and not exists (
              select 1 from public.earn360_ai_task_assignments a
              where a.user_id=v_user.user_id and a.task_id=t.id and a.assigned_date=v_day
            )
          order by random() limit (v_count-v_for_user)
        loop
          insert into public.earn360_ai_task_assignments(user_id,task_id,assigned_date)
          values(v_user.user_id,v_task.id,v_day)
          on conflict(user_id,assigned_date,task_id) do nothing;
          v_added := v_added + 1;
        end loop;
      end if;
    end if;
  end loop;
  return v_added;
end;
$$;

create or replace function public.earn360_award_ai_training_day(p_user_id uuid,p_earning_date date)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_required integer;
  v_completed integer;
  v_weekly numeric(12,2);
  v_reward numeric(12,2);
  v_plan_id uuid;
  v_existing uuid;
begin
  perform pg_advisory_xact_lock(hashtext(p_user_id::text||':'||p_earning_date::text));
  if extract(isodow from p_earning_date)>5 then
    return jsonb_build_object('completed',false,'error','AI Training rewards are not available on weekends.');
  end if;

  select count(*), count(*) filter(where status='approved')
  into v_required,v_completed
  from public.earn360_ai_task_assignments
  where user_id=p_user_id and assigned_date=p_earning_date;

  if v_required=0 or v_completed<v_required then
    return jsonb_build_object('completed',false,'tasks_required',v_required,'tasks_completed',v_completed);
  end if;

  select m.plan_id,coalesce(mp.weekly_reward_usd,0)
  into v_plan_id,v_weekly
  from public.memberships m
  join public.membership_plans mp on mp.id=m.plan_id
  where m.user_id=p_user_id and m.status='active'
    and coalesce(m.starts_at,m.purchased_at) <= (p_earning_date::timestamp at time zone 'Africa/Lome')
    and (m.ends_at is null or m.ends_at >= (p_earning_date::timestamp at time zone 'Africa/Lome'))
  order by m.purchased_at desc limit 1;

  if v_plan_id is null then
    return jsonb_build_object('completed',false,'error','No active membership found.');
  end if;

  v_reward := round(v_weekly/5,2);
  insert into public.earn360_ai_training_days(user_id,earning_date,tasks_required,tasks_completed,reward_amount,status,completed_at)
  values(p_user_id,p_earning_date,v_required,v_completed,v_reward,'completed',now())
  on conflict(user_id,earning_date) do update
    set tasks_required=excluded.tasks_required,
        tasks_completed=excluded.tasks_completed,
        reward_amount=excluded.reward_amount,
        status='completed',
        completed_at=coalesce(public.earn360_ai_training_days.completed_at,now());

  select id into v_existing from public.wallet_transactions
  where reference='ai-training:'||p_user_id::text||':'||p_earning_date::text;

  if v_existing is null then
    insert into public.wallets(user_id,balance,updated_at)
    values(p_user_id,0,now()) on conflict(user_id) do nothing;
    update public.wallets set balance=balance+v_reward,updated_at=now()
    where user_id=p_user_id;
    insert into public.wallet_transactions(user_id,transaction_type,amount,reference,status,description)
    values(p_user_id,'task_reward',v_reward,'ai-training:'||p_user_id::text||':'||p_earning_date::text,'successful','Daily AI Training reward');
    update public.memberships
    set earning_days_completed=coalesce(earning_days_completed,0)+1
    where user_id=p_user_id and status='active' and plan_id=v_plan_id;
  end if;

  return jsonb_build_object('completed',true,'tasks_required',v_required,'tasks_completed',v_completed,'reward_amount',v_reward);
end;
$$;

revoke all on function public.earn360_assign_daily_ai_training_tasks() from public, anon, authenticated;
revoke all on function public.earn360_award_ai_training_day(uuid,date) from public, anon, authenticated;
grant execute on function public.earn360_assign_daily_ai_training_tasks() to service_role;
grant execute on function public.earn360_award_ai_training_day(uuid,date) to service_role;

do $$
begin
  if not exists (select 1 from cron.job where jobname='earn360-ai-training-daily-assignment') then
    perform cron.schedule('earn360-ai-training-daily-assignment','5 0 * * *',
      'select public.earn360_assign_daily_ai_training_tasks();');
  end if;
end $$;
