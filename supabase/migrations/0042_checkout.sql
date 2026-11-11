-- ============================================================================
-- 0042: check-out / check-in with employee acceptance.
--
-- people            who can hold an asset. Seeded from the free-text employee
--                   names already on the register; filled in (email, dept,
--                   leaver flag) by the Microsoft 365 directory sync.
-- checkouts         one hand-over: a person, one or more assets, and whether
--                   that person has confirmed receipt.
-- asset_assignments one row per asset per hand-over; open while
--                   checked_in_at is null. At most one open row per asset.
-- checkout_tokens   hashes of the emailed acceptance links. No policies at
--                   all: only the service role (api/accept.js) reads them.
--
-- All writes to checkouts/assignments go through checkout_assets() and
-- checkin_assets(), so the asset row, the assignment and the event log move
-- in one transaction and the existing history / outbox triggers still fire.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. People
-- ---------------------------------------------------------------------------
create table if not exists public.people (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null check (btrim(full_name) <> ''),
  email       text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  department  text,
  office      text,
  job_title   text,
  active      boolean not null default true,      -- false = left (disabled in M365)
  source      text not null default 'manual' check (source in ('manual','register','m365')),
  m365_id     text unique,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists people_email_unique on public.people (lower(email)) where email is not null;
create index if not exists people_name_idx on public.people (lower(full_name));

alter table public.people enable row level security;

drop policy if exists "role holders read people" on public.people;
create policy "role holders read people"
  on public.people for select to authenticated
  using (public.has_app_role());

drop policy if exists "writers add people" on public.people;
create policy "writers add people"
  on public.people for insert to authenticated
  with check (public.is_super_admin() or public.is_allowed_scanner());

drop policy if exists "writers edit people" on public.people;
create policy "writers edit people"
  on public.people for update to authenticated
  using (public.is_super_admin() or public.is_allowed_scanner())
  with check (public.is_super_admin() or public.is_allowed_scanner());

drop policy if exists "admin delete people" on public.people;
create policy "admin delete people"
  on public.people for delete to authenticated
  using (public.is_admin());

create or replace function public.people_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.full_name := btrim(regexp_replace(new.full_name, '\s+', ' ', 'g'));
  new.email := nullif(lower(btrim(coalesce(new.email, ''))), '');
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists people_touch_trigger on public.people;
create trigger people_touch_trigger
  before insert or update on public.people
  for each row execute function public.people_touch();

-- Everyone already named on the register becomes a person (no email yet).
insert into public.people (full_name, source)
select distinct on (lower(btrim(employee))) btrim(employee), 'register'
  from public.assets
 where coalesce(btrim(employee), '') <> ''
   and deleted_at is null
   and not exists (select 1 from public.people p where lower(p.full_name) = lower(btrim(employee)))
 order by lower(btrim(employee)), btrim(employee);

-- ---------------------------------------------------------------------------
-- 2. Check-outs and assignments
-- ---------------------------------------------------------------------------
create table if not exists public.checkouts (
  id             uuid primary key default gen_random_uuid(),
  person_id      uuid not null references public.people(id),
  person_name    text not null,                 -- snapshot at hand-over
  email          text,                          -- where the acceptance link went
  accept_status  text not null default 'pending'
                 check (accept_status in ('pending','accepted','disputed','not_required')),
  accepted_at    timestamptz,
  accepted_name  text,                          -- name the employee typed
  dispute_note   text,
  emails_sent    int not null default 0,        -- first send + reminders
  last_email_at  timestamptz,
  email_error    text,
  created_by     text,
  created_at     timestamptz not null default now()
);

create index if not exists checkouts_pending_idx on public.checkouts (created_at) where accept_status = 'pending';

create table if not exists public.asset_assignments (
  id              bigserial primary key,
  checkout_id     uuid not null references public.checkouts(id) on delete cascade,
  item_id         text not null references public.assets(item_id) on update cascade,
  person_id       uuid not null references public.people(id),
  person_name     text not null,
  checked_out_at  timestamptz not null default now(),
  checked_out_by  text,
  condition_out   text,
  accessories_out text[] not null default '{}',
  due_back        date,
  notes_out       text,
  checked_in_at   timestamptz,
  checked_in_by   text,
  condition_in    text,
  accessories_missing text[] not null default '{}',
  wiped           boolean,
  notes_in        text
);

create unique index if not exists asset_assignments_one_open on public.asset_assignments (item_id) where checked_in_at is null;
create index if not exists asset_assignments_checkout_idx on public.asset_assignments (checkout_id);
create index if not exists asset_assignments_due_idx on public.asset_assignments (due_back) where checked_in_at is null and due_back is not null;

create table if not exists public.checkout_tokens (
  token_hash   text primary key,                -- sha256 hex of the emailed token
  checkout_id  uuid not null references public.checkouts(id) on delete cascade,
  expires_at   timestamptz not null,
  created_at   timestamptz not null default now()
);

alter table public.checkouts enable row level security;
alter table public.asset_assignments enable row level security;
alter table public.checkout_tokens enable row level security;   -- no policies: service role only

drop policy if exists "role holders read checkouts" on public.checkouts;
create policy "role holders read checkouts"
  on public.checkouts for select to authenticated
  using (public.has_app_role());

drop policy if exists "role holders read assignments" on public.asset_assignments;
create policy "role holders read assignments"
  on public.asset_assignments for select to authenticated
  using (public.has_app_role());

-- ---------------------------------------------------------------------------
-- 3. checkout_assets: hand one or more assets to a person
-- ---------------------------------------------------------------------------
create or replace function public.checkout_assets(
  p_person_id    uuid,
  p_item_ids     text[],
  p_condition    text default null,
  p_accessories  text[] default '{}',
  p_due_back     date default null,
  p_notes        text default null,
  p_request_acceptance boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claims  text := nullif(current_setting('request.jwt.claims', true), '');
  who     text;
  p       public.people%rowtype;
  a       record;
  co_id   uuid;
  status  text;
  n       int := 0;
begin
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not (public.is_super_admin() or public.is_allowed_scanner()) then
    raise exception 'not permitted to check out assets' using errcode = '42501';
  end if;
  who := case when claims is null then null else claims::jsonb ->> 'email' end;

  select * into p from public.people where id = p_person_id;
  if not found then
    raise exception 'person not found' using errcode = '22023';
  end if;
  if not p.active then
    raise exception '% is marked as a leaver and cannot be given assets', p.full_name using errcode = '22023';
  end if;
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    raise exception 'pick at least one asset' using errcode = '22023';
  end if;
  if p_due_back is not null and p_due_back < current_date then
    raise exception 'return date is in the past' using errcode = '22023';
  end if;

  -- lock, then validate every asset before touching any of them
  perform 1 from public.assets where item_id = any(p_item_ids) for update;
  for a in
    select x.item_id as want, s.item_id, s.asset_tag, s.employee, s.deleted_at,
           exists (select 1 from public.asset_assignments o
                    where o.item_id = s.item_id and o.checked_in_at is null) as has_open
      from unnest(p_item_ids) as x(item_id)
      left join public.assets s on s.item_id = x.item_id
  loop
    if a.item_id is null or a.deleted_at is not null then
      raise exception 'asset % not found', a.want using errcode = '22023';
    end if;
    if a.has_open then
      raise exception '% is already checked out - check it in first', coalesce(a.asset_tag, a.item_id) using errcode = '23505';
    end if;
    -- an asset already held by someone else (typed in before check-out existed)
    -- has to come back first; re-recording the same holder is allowed, which is
    -- how existing assignments get a confirmation after the fact
    if coalesce(btrim(a.employee), '') <> '' and lower(btrim(a.employee)) <> lower(p.full_name) then
      raise exception '% is assigned to % - check it in first', coalesce(a.asset_tag, a.item_id), a.employee using errcode = '23505';
    end if;
  end loop;

  status := case when p_request_acceptance and p.email is not null then 'pending' else 'not_required' end;

  insert into public.checkouts (person_id, person_name, email, accept_status, created_by)
  values (p.id, p.full_name, case when status = 'pending' then p.email end, status, who)
  returning id into co_id;

  insert into public.asset_assignments
    (checkout_id, item_id, person_id, person_name, checked_out_by, condition_out, accessories_out, due_back, notes_out)
  select co_id, x.item_id, p.id, p.full_name, who, nullif(btrim(p_condition), ''),
         coalesce(p_accessories, '{}'), p_due_back, nullif(btrim(p_notes), '')
    from (select distinct unnest(p_item_ids) as item_id) x;
  get diagnostics n = row_count;

  update public.assets
     set employee = p.full_name,
         status   = 'In Use',
         extra    = coalesce(extra, '{}'::jsonb)
                    || jsonb_build_object('date_issued', to_char(current_date, 'YYYY-MM-DD'))
                    || case when nullif(btrim(p_condition), '') is null then '{}'::jsonb
                            else jsonb_build_object('condition', btrim(p_condition)) end
   where item_id = any(p_item_ids);

  insert into public.asset_events (item_id, event_type, description, resolved)
  select x.item_id, 'transfer',
         'Checked out to ' || p.full_name
         || case when cardinality(coalesce(p_accessories, '{}')) > 0
                 then ' with ' || array_to_string(p_accessories, ', ') else '' end
         || case when p_due_back is not null then ', due back ' || to_char(p_due_back, 'DD Mon YYYY') else '' end,
         true
    from (select distinct unnest(p_item_ids) as item_id) x;

  return jsonb_build_object('checkout_id', co_id, 'accept_status', status, 'email', p.email, 'assets', n);
end;
$$;

revoke execute on function public.checkout_assets(uuid, text[], text, text[], date, text, boolean) from public, anon;
grant execute on function public.checkout_assets(uuid, text[], text, text[], date, text, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. checkin_assets: take one or more assets back
--    p_returned: accessories that came back. null = everything came back.
--    Works for assets assigned before check-out existed (no open assignment):
--    the asset is still returned to stock and the event logged.
-- ---------------------------------------------------------------------------
create or replace function public.checkin_assets(
  p_item_ids   text[],
  p_condition  text default 'Good',
  p_returned   text[] default null,
  p_wiped      boolean default null,
  p_notes      text default null,
  p_status     text default 'Available'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claims  text := nullif(current_setting('request.jwt.claims', true), '');
  who     text;
  a       record;
  missing text[];
  holder  text;
  results jsonb := '[]'::jsonb;
  cond    text := nullif(btrim(p_condition), '');
begin
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not (public.is_super_admin() or public.is_allowed_scanner()) then
    raise exception 'not permitted to check in assets' using errcode = '42501';
  end if;
  who := case when claims is null then null else claims::jsonb ->> 'email' end;
  if p_item_ids is null or cardinality(p_item_ids) = 0 then
    raise exception 'pick at least one asset' using errcode = '22023';
  end if;

  for a in
    select s.item_id, s.asset_tag, s.employee, s.deleted_at, o.id as assignment_id, o.accessories_out, o.person_name
      from (select distinct unnest(p_item_ids) as item_id) x
      join public.assets s on s.item_id = x.item_id
      left join public.asset_assignments o on o.item_id = s.item_id and o.checked_in_at is null
     for update of s
  loop
    holder := coalesce(a.person_name, nullif(btrim(a.employee), ''));
    missing := case
      when a.assignment_id is null or p_returned is null then '{}'::text[]
      else array(select m from unnest(a.accessories_out) m where not (m = any(p_returned)))
    end;

    if a.assignment_id is not null then
      update public.asset_assignments
         set checked_in_at = now(), checked_in_by = who, condition_in = cond,
             accessories_missing = missing, wiped = p_wiped, notes_in = nullif(btrim(p_notes), '')
       where id = a.assignment_id;
    end if;

    update public.assets
       set employee = null,
           status   = coalesce(nullif(btrim(p_status), ''), 'Available'),
           extra    = case when cond is null then coalesce(extra, '{}'::jsonb)
                           else coalesce(extra, '{}'::jsonb) || jsonb_build_object('condition', cond) end
     where item_id = a.item_id;

    insert into public.asset_events (item_id, event_type, description, resolved)
    values (a.item_id, 'transfer',
            'Checked in' || coalesce(' from ' || holder, '')
            || coalesce(' (' || cond || ')', '')
            || case when p_wiped then ', wiped' else '' end
            || coalesce(': ' || nullif(btrim(p_notes), ''), ''),
            true);

    if lower(coalesce(cond, '')) = 'damaged' then
      insert into public.asset_events (item_id, event_type, description, resolved)
      values (a.item_id, 'issue',
              'Returned damaged' || coalesce(' by ' || holder, '') || coalesce(': ' || nullif(btrim(p_notes), ''), ''),
              false);
    end if;
    if cardinality(missing) > 0 then
      insert into public.asset_events (item_id, event_type, description, resolved)
      values (a.item_id, 'issue',
              'Not returned' || coalesce(' by ' || holder, '') || ': ' || array_to_string(missing, ', '),
              false);
    end if;

    results := results || jsonb_build_object(
      'item_id', a.item_id, 'tag', a.asset_tag, 'from', holder,
      'missing', to_jsonb(missing), 'damaged', lower(coalesce(cond, '')) = 'damaged',
      'had_assignment', a.assignment_id is not null);
  end loop;

  if jsonb_array_length(results) = 0 then
    raise exception 'asset not found' using errcode = '22023';
  end if;
  return results;
end;
$$;

revoke execute on function public.checkin_assets(text[], text, text[], boolean, text, text) from public, anon;
grant execute on function public.checkin_assets(text[], text, text[], boolean, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. Acceptance (service role only: called by api/accept.js with a token hash)
-- ---------------------------------------------------------------------------
create or replace function public.checkout_by_token(p_token_hash text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'checkout_id',   c.id,
    'person_name',   c.person_name,
    'accept_status', c.accept_status,
    'accepted_at',   c.accepted_at,
    'accepted_name', c.accepted_name,
    'created_at',    c.created_at,
    'expired',       t.expires_at < now(),
    'assets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tag', s.asset_tag, 'type', s.asset_type, 'model', s.model, 'serial', s.serial,
               'accessories', to_jsonb(o.accessories_out), 'due_back', o.due_back,
               'condition', o.condition_out, 'returned', o.checked_in_at is not null)
             order by s.asset_tag)
        from public.asset_assignments o
        join public.assets s on s.item_id = o.item_id
       where o.checkout_id = c.id), '[]'::jsonb))
  from public.checkout_tokens t
  join public.checkouts c on c.id = t.checkout_id
  where t.token_hash = p_token_hash;
$$;

create or replace function public.respond_to_checkout(
  p_token_hash text,
  p_accept     boolean,
  p_name       text,
  p_note       text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  t   public.checkout_tokens%rowtype;
  c   public.checkouts%rowtype;
  nm  text := btrim(coalesce(p_name, ''));
begin
  select * into t from public.checkout_tokens where token_hash = p_token_hash;
  if not found then
    raise exception 'link not recognised' using errcode = '22023';
  end if;
  if t.expires_at < now() then
    raise exception 'link expired - ask IT to send a new one' using errcode = '22023';
  end if;
  select * into c from public.checkouts where id = t.checkout_id for update;
  if c.accept_status not in ('pending', 'disputed') then
    raise exception 'already answered' using errcode = '22023';
  end if;
  if char_length(nm) < 2 then
    raise exception 'type your name' using errcode = '22023';
  end if;
  if not p_accept and char_length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'tell IT what is wrong' using errcode = '22023';
  end if;

  update public.checkouts
     set accept_status = case when p_accept then 'accepted' else 'disputed' end,
         accepted_at   = case when p_accept then now() else null end,
         accepted_name = left(nm, 120),
         dispute_note  = case when p_accept then null else left(btrim(p_note), 1000) end
   where id = c.id;

  insert into public.asset_events (item_id, event_type, description, resolved)
  select o.item_id,
         case when p_accept then 'note' else 'issue' end,
         case when p_accept then 'Receipt confirmed by ' || left(nm, 120)
              else 'Hand-over disputed by ' || left(nm, 120) || ': ' || left(btrim(p_note), 500) end,
         p_accept
    from public.asset_assignments o
   where o.checkout_id = c.id and o.checked_in_at is null;

  return jsonb_build_object('checkout_id', c.id, 'accept_status', case when p_accept then 'accepted' else 'disputed' end);
end;
$$;

-- IT re-sends after a dispute is sorted out: back to pending.
create or replace function public.reopen_checkout(p_checkout_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.checkouts
     set accept_status = 'pending', dispute_note = null, accepted_name = null
   where id = p_checkout_id and accept_status = 'disputed';
end;
$$;

revoke execute on function public.checkout_by_token(text) from public, anon, authenticated;
revoke execute on function public.respond_to_checkout(text, boolean, text, text) from public, anon, authenticated;
revoke execute on function public.reopen_checkout(uuid) from public, anon, authenticated;
grant execute on function public.checkout_by_token(text) to service_role;
grant execute on function public.respond_to_checkout(text, boolean, text, text) to service_role;
grant execute on function public.reopen_checkout(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Directory sync (service role only: api/alerts.js and the admin button)
--    p_users: [{id, name, email, department, office, title, enabled}]
--    Match order: m365 id, then email, then an unlinked person with the same
--    name (that is how the seeded register names pick up their email).
--    Someone disabled in M365 becomes active = false: the leaver signal.
-- ---------------------------------------------------------------------------
create or replace function public.sync_people_from_directory(p_users jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u        jsonb;
  pid      uuid;
  added    int := 0;
  updated  int := 0;
  left_    int := 0;
  was      boolean;
  en       boolean;
begin
  for u in select * from jsonb_array_elements(coalesce(p_users, '[]'::jsonb)) loop
    en := coalesce((u ->> 'enabled')::boolean, true);
    pid := null;
    select id, active into pid, was from public.people where m365_id = u ->> 'id';
    if pid is null and nullif(u ->> 'email', '') is not null then
      select id, active into pid, was from public.people where lower(email) = lower(u ->> 'email') limit 1;
    end if;
    if pid is null then
      select id, active into pid, was from public.people
       where m365_id is null and lower(full_name) = lower(btrim(u ->> 'name'))
       order by (email is null) desc limit 1;
    end if;

    if pid is null then
      if not en then continue; end if;            -- never import someone who already left
      insert into public.people (full_name, email, department, office, job_title, active, source, m365_id)
      values (u ->> 'name', nullif(u ->> 'email', ''), nullif(u ->> 'department', ''),
              nullif(u ->> 'office', ''), nullif(u ->> 'title', ''), true, 'm365', u ->> 'id');
      added := added + 1;
    else
      update public.people
         set m365_id    = u ->> 'id',
             full_name  = coalesce(nullif(btrim(u ->> 'name'), ''), full_name),
             email      = coalesce(nullif(u ->> 'email', ''), email),
             department = coalesce(nullif(u ->> 'department', ''), department),
             office     = coalesce(nullif(u ->> 'office', ''), office),
             job_title  = coalesce(nullif(u ->> 'title', ''), job_title),
             active     = en,
             source     = 'm365'
       where id = pid;
      updated := updated + 1;
      if was and not en then left_ := left_ + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('added', added, 'updated', updated, 'newly_left', left_);
end;
$$;

revoke execute on function public.sync_people_from_directory(jsonb) from public, anon, authenticated;
grant execute on function public.sync_people_from_directory(jsonb) to service_role;
