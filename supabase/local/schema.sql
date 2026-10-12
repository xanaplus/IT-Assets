


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE EXTENSION IF NOT EXISTS "pg_cron" WITH SCHEMA "pg_catalog";






CREATE EXTENSION IF NOT EXISTS "pg_net" WITH SCHEMA "extensions";






COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."asset_events_guard"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  who    text;
begin
  if TG_OP = 'INSERT' then
    if claims is not null and (claims::jsonb ->> 'role') is distinct from 'service_role' then
      who := claims::jsonb ->> 'email';
      if who is not null then new.created_by := who; end if;   -- never trust the client's claim
    end if;
    return new;
  end if;
  -- updates may close an issue; they may not rewrite what the event was
  new.item_id    := old.item_id;
  new.event_type := old.event_type;
  new.created_by := old.created_by;
  new.created_at := old.created_at;
  return new;
end;
$$;


ALTER FUNCTION "public"."asset_events_guard"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."asset_extra_merge"("p_item_id" "text", "p_patch" "jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
begin
  -- RLS does not apply inside this function (owner-executed DML), so the
  -- role gate the assets UPDATE policy would have provided is spelled out.
  -- Empty claims = migrations/psql (already free to update the table), and
  -- service_role = api/admin-users.js, the sync worker and the scripted
  -- backfills — both keep the merge.
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not (public.is_super_admin() or public.is_allowed_scanner()) then
    raise exception 'not permitted to edit assets' using errcode = '42501';
  end if;
  update public.assets
     set extra = coalesce(extra, '{}'::jsonb) || p_patch
   where item_id = p_item_id;
end;
$$;


ALTER FUNCTION "public"."asset_extra_merge"("p_item_id" "text", "p_patch" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assets_audit_trigger"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  actor text;
  cols  jsonb := '{}'::jsonb;
  k     text;
  tracked constant jsonb :=
    '["title","asset_tag","asset_type","model","serial","employee","status","location","deleted_at","extra"]'::jsonb;
begin
  actor := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email',
    'service_role'
  );

  if TG_OP = 'INSERT' then
    insert into public.asset_history (item_id, op, changed_by, new_row)
    values (NEW.item_id, 'insert', actor, to_jsonb(NEW));
    return NEW;

  elsif TG_OP = 'UPDATE' then
    for k in select value from jsonb_array_elements_text(tracked) loop
      if to_jsonb(OLD) -> k is distinct from to_jsonb(NEW) -> k then
        cols := jsonb_set(cols, array[k],
          jsonb_build_object('old', to_jsonb(OLD) -> k, 'new', to_jsonb(NEW) -> k));
      end if;
    end loop;
    if cols <> '{}'::jsonb then
      insert into public.asset_history (item_id, op, changed_by, fields, old_row, new_row)
      values (NEW.item_id, 'update', actor, cols, to_jsonb(OLD), to_jsonb(NEW));
    end if;
    return NEW;

  else  -- DELETE
    insert into public.asset_history (item_id, op, changed_by, old_row)
    values (OLD.item_id, 'delete', actor, to_jsonb(OLD));
    return OLD;
  end if;
end;
$$;


ALTER FUNCTION "public"."assets_audit_trigger"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assets_guard_choices"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if coalesce(btrim(new.status), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'status' and c.value = btrim(new.status)) then
    raise exception 'Status "%" is not in the admin list (Admin > Lists)', new.status using errcode = '23514';
  end if;
  if coalesce(btrim(new.asset_type), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'asset_type' and c.value = btrim(new.asset_type)) then
    raise exception 'Asset Type "%" is not in the admin list (Admin > Lists)', new.asset_type using errcode = '23514';
  end if;
  if coalesce(btrim(new.location), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'location' and c.value = btrim(new.location)) then
    raise exception 'Location "%" is not in the admin list (Admin > Lists)', new.location using errcode = '23514';
  end if;
  if coalesce(btrim(new.extra ->> 'department'), '') <> ''
     and not exists (select 1 from public.app_choices c where c.category = 'department' and c.value = btrim(new.extra ->> 'department')) then
    raise exception 'Department "%" is not in the admin list (Admin > Lists)', new.extra ->> 'department' using errcode = '23514';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."assets_guard_choices"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assets_guard_lifecycle"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  claims text := current_setting('request.jwt.claims', true);
begin
  if new.deleted_at is not distinct from old.deleted_at then return new; end if;
  if claims is null or claims = '' then return new; end if;
  if (claims::jsonb ->> 'role') = 'service_role' then return new; end if;
  if public.has_role('admin') or public.is_super_admin() then return new; end if;
  raise exception 'only an administrator can move an asset to the recycle bin'
    using errcode = '42501';
end;
$$;


ALTER FUNCTION "public"."assets_guard_lifecycle"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assets_to_outbox"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  pl jsonb;
begin
  if tg_op = 'DELETE' then
    -- asset_id is nulled by the FK right after this row is written, so the
    -- identity travels in payload where nothing can clear it
    insert into public.sharepoint_sync (asset_id, op, graph_item_id, payload)
    values (null, 'delete', old.graph_item_id,
            jsonb_build_object('asset_id', old.id, 'item_id', old.item_id));
    return old;
  end if;

  pl := jsonb_strip_nulls(jsonb_build_object(
    'asset_id',   new.id,
    'item_id',    new.item_id,
    'title',      new.title,
    'asset_tag',  new.asset_tag,
    'asset_type', new.asset_type,
    'model',      new.model,
    'serial',     new.serial,
    'employee',   new.employee,
    'status',     new.status,
    'location',   new.location,
    'extra',      new.extra
  ));

  insert into public.sharepoint_sync (asset_id, op, graph_item_id, payload)
  values (new.id, lower(tg_op), new.graph_item_id, pl);
  return new;
end;
$$;


ALTER FUNCTION "public"."assets_to_outbox"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dispatch_sync_row"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'extensions'
    AS $$
declare
  v_url text;
begin
  select value into v_url from public.app_config where key = 'sync_worker_url';
  if v_url is null or v_url like '%REPLACE%' then
    return new; -- not wired yet; cron/manual drain will pick it up later
  end if;
  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-sync-key',   (select value from public.app_config where key = 'sync_worker_key')
    ),
    body    := jsonb_build_object('ids', jsonb_build_array(new.id)),
    timeout_milliseconds := 8000
  );
  return new;
end;
$$;


ALTER FUNCTION "public"."dispatch_sync_row"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_app_role"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
    where r.user_id = auth.uid()
      and p.active
  );
$$;


ALTER FUNCTION "public"."has_app_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_role"("want" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1
    from public.user_roles r
    join public.profiles p on p.id = r.user_id
    where r.user_id = auth.uid()
      and p.active
      and r.role = want
  );
$$;


ALTER FUNCTION "public"."has_role"("want" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.has_app_role() and (public.has_role('admin') or public.has_role('super_admin'));
$$;


ALTER FUNCTION "public"."is_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_allowed_scanner"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.has_app_role() and (public.has_role('scanner') or public.has_role('admin'));
$$;


ALTER FUNCTION "public"."is_allowed_scanner"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_super_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select public.has_app_role() and public.has_role('super_admin');
$$;


ALTER FUNCTION "public"."is_super_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."next_asset_item_id"() RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  n bigint;
begin
  perform pg_advisory_xact_lock(778899001);   -- one allocator at a time
  update public.asset_id_high_water w
     set next_id = greatest(
           w.next_id + 1,
           (select coalesce(max(a.item_id::bigint), 0) + 1
              from public.assets a where a.item_id ~ '^[0-9]+$'))
   where w.only_row
  returning w.next_id - 1 into n;             -- hand out the value just reserved
  return n::text;
end;
$_$;


ALTER FUNCTION "public"."next_asset_item_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profiles_guard_self"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  claims text := current_setting('request.jwt.claims', true);
begin
  if claims is null or claims = '' then return new; end if;                 -- SQL / migrations
  if (claims::jsonb ->> 'role') = 'service_role' then return new; end if;   -- admin API, worker
  if new.active is distinct from old.active then
    raise exception 'active is managed by an administrator' using errcode = '42501';
  end if;
  if new.email is distinct from old.email then
    raise exception 'email is managed by an administrator' using errcode = '42501';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."profiles_guard_self"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_operational_history"("p_outbox_days" integer DEFAULT 90, "p_audit_days" integer DEFAULT 0) RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  n_out  int;
  n_aud  int := 0;
begin
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not public.is_admin() then
    raise exception 'not permitted' using errcode = '42501';
  end if;

  delete from public.sharepoint_sync
   where status = 'done'
     and coalesce(processed_at, created_at) < now() - make_interval(days => greatest(p_outbox_days, 7));
  get diagnostics n_out = row_count;

  if p_audit_days > 0 then
    delete from public.asset_history
     where changed_at < now() - make_interval(days => p_audit_days);
    get diagnostics n_aud = row_count;
  end if;

  return jsonb_build_object('outbox_deleted', n_out, 'history_deleted', n_aud);
end;
$$;


ALTER FUNCTION "public"."prune_operational_history"("p_outbox_days" integer, "p_audit_days" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."requeue_failed_sync_rows"() RETURNS integer
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with r as (
    update public.sharepoint_sync
       set status = 'pending', attempts = 0, last_error = null, processed_at = null
     where status = 'failed'
    returning 1)
  select count(*)::int from r;
$$;


ALTER FUNCTION "public"."requeue_failed_sync_rows"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) RETURNS "text"[]
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  allowed constant text[] := array['scanner','asset_viewer','dashboard_viewer','admin','super_admin'];
  wanted  text[] := coalesce(p_roles, '{}');
  r       text;
  result  text[];
begin
  if p_user_id is null then
    raise exception 'p_user_id is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'no profile row for %', p_user_id using errcode = '23503';
  end if;
  foreach r in array wanted loop
    if not (r = any(allowed)) then
      raise exception 'unknown role "%"', r using errcode = '22023';
    end if;
  end loop;

  delete from public.user_roles
   where user_id = p_user_id
     and role <> all(wanted);

  insert into public.user_roles (user_id, role)
  select p_user_id, unnest(wanted)
  on conflict do nothing;

  select coalesce(array_agg(role order by role), '{}') into result
    from public.user_roles where user_id = p_user_id;
  return result;
end;
$$;


ALTER FUNCTION "public"."set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_last_seen"() RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update public.profiles
     set last_seen = now()
   where id = auth.uid();
end;
$$;


ALTER FUNCTION "public"."touch_last_seen"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."touch_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."touch_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."update_asset"("p_item_id" "text", "p_row" "jsonb" DEFAULT '{}'::"jsonb", "p_extra" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
declare
  claims text := nullif(current_setting('request.jwt.claims', true), '');
  cols   text;
  n      int;
begin
  if claims is not null
     and (claims::jsonb ->> 'role') is distinct from 'service_role'
     and not (public.is_super_admin() or public.is_allowed_scanner()) then
    raise exception 'not permitted to edit assets' using errcode = '42501';
  end if;

  if p_item_id is null or btrim(p_item_id) = '' then
    raise exception 'p_item_id is required' using errcode = '22023';
  end if;

  -- only real columns, only those the caller actually sent (a JSON null means
  -- "clear this field", which is why nothing is coalesced against the old value)
  select string_agg(format('%I = r.%I', k, k), ', ')
    into cols
    from jsonb_object_keys(coalesce(p_row, '{}'::jsonb)) as k
   where k in ('title','asset_tag','asset_type','model','serial','employee',
               'status','location','deleted_at','graph_item_id');

  if cols is not null then
    execute format(
      'update public.assets a
          set %s
        from jsonb_populate_record(null::public.assets, $1) r
       where a.item_id = $2', cols)
      using coalesce(p_row, '{}'::jsonb), p_item_id;
    get diagnostics n = row_count;
  else
    select count(*)::int into n from public.assets a where a.item_id = p_item_id;
  end if;

  if p_extra is not null and p_extra <> '{}'::jsonb then
    update public.assets
       set extra = coalesce(extra, '{}'::jsonb) || p_extra
     where item_id = p_item_id;
    get diagnostics n = row_count;
  end if;

  return jsonb_build_object('updated', coalesce(n, 0));
end;
$_$;


ALTER FUNCTION "public"."update_asset"("p_item_id" "text", "p_row" "jsonb", "p_extra" "jsonb") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."admin_audit" (
    "id" bigint NOT NULL,
    "actor_id" "uuid",
    "actor_email" "text",
    "action" "text" NOT NULL,
    "target" "text",
    "detail" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."admin_audit" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."admin_audit_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."admin_audit_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."admin_audit_id_seq" OWNED BY "public"."admin_audit"."id";



CREATE TABLE IF NOT EXISTS "public"."allowed_scanners" (
    "email" "text" NOT NULL,
    "added_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."allowed_scanners" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_choices" (
    "category" "text" NOT NULL,
    "value" "text" NOT NULL,
    "sort_order" integer DEFAULT 0 NOT NULL,
    "useful_life" integer,
    CONSTRAINT "app_choices_category_check" CHECK (("category" = ANY (ARRAY['asset_type'::"text", 'status'::"text", 'location'::"text", 'region'::"text", 'department'::"text"]))),
    CONSTRAINT "app_choices_useful_life_asset_type_only" CHECK ((("useful_life" IS NULL) OR ("category" = 'asset_type'::"text"))),
    CONSTRAINT "app_choices_useful_life_sane" CHECK ((("useful_life" IS NULL) OR (("useful_life" > 0) AND ("useful_life" <= 50))))
);


ALTER TABLE "public"."app_choices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_config" (
    "key" "text" NOT NULL,
    "value" "text" NOT NULL
);


ALTER TABLE "public"."app_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."asset_events" (
    "id" bigint NOT NULL,
    "item_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_date" timestamp with time zone DEFAULT "now"() NOT NULL,
    "description" "text" NOT NULL,
    "cost" numeric(12,2),
    "resolved" boolean DEFAULT false NOT NULL,
    "created_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "asset_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['issue'::"text", 'repair'::"text", 'maintenance'::"text", 'transfer'::"text", 'note'::"text"])))
);


ALTER TABLE "public"."asset_events" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."asset_events_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."asset_events_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."asset_events_id_seq" OWNED BY "public"."asset_events"."id";



CREATE TABLE IF NOT EXISTS "public"."asset_history" (
    "id" bigint NOT NULL,
    "item_id" "text" NOT NULL,
    "op" "text" NOT NULL,
    "changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "changed_by" "text",
    "fields" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "old_row" "jsonb",
    "new_row" "jsonb",
    CONSTRAINT "asset_history_op_check" CHECK (("op" = ANY (ARRAY['insert'::"text", 'update'::"text", 'delete'::"text"])))
);


ALTER TABLE "public"."asset_history" OWNER TO "postgres";


CREATE SEQUENCE IF NOT EXISTS "public"."asset_history_id_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE "public"."asset_history_id_seq" OWNER TO "postgres";


ALTER SEQUENCE "public"."asset_history_id_seq" OWNED BY "public"."asset_history"."id";



CREATE TABLE IF NOT EXISTS "public"."asset_id_high_water" (
    "only_row" boolean DEFAULT true NOT NULL,
    "next_id" bigint NOT NULL,
    CONSTRAINT "asset_id_high_water_only_row_check" CHECK ("only_row")
);


ALTER TABLE "public"."asset_id_high_water" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."assets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "item_id" "text" NOT NULL,
    "title" "text",
    "asset_tag" "text",
    "asset_type" "text",
    "model" "text",
    "serial" "text",
    "employee" "text",
    "status" "text" DEFAULT 'Available'::"text",
    "location" "text",
    "extra" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "graph_item_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "assets_price_or_estimate" CHECK (((COALESCE(NULLIF("btrim"(("extra" ->> 'purchase_price'::"text")), ''::"text"), ''::"text") <> ''::"text") OR ("lower"(COALESCE(("extra" ->> 'estimate_pending'::"text"), ''::"text")) = ANY (ARRAY['true'::"text", '1'::"text", 'yes'::"text"])))),
    CONSTRAINT "assets_tag_required" CHECK ((COALESCE(NULLIF("asset_tag", ''::"text"), NULLIF("title", ''::"text")) IS NOT NULL))
);


ALTER TABLE "public"."assets" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."choice_usage" WITH ("security_invoker"='true') AS
 SELECT 'asset_type'::"text" AS "category",
    "assets"."asset_type" AS "value",
    ("count"(*))::integer AS "n"
   FROM "public"."assets"
  WHERE (("assets"."deleted_at" IS NULL) AND (COALESCE("assets"."asset_type", ''::"text") <> ''::"text"))
  GROUP BY "assets"."asset_type"
UNION ALL
 SELECT 'status'::"text" AS "category",
    "assets"."status" AS "value",
    ("count"(*))::integer AS "n"
   FROM "public"."assets"
  WHERE (("assets"."deleted_at" IS NULL) AND (COALESCE("assets"."status", ''::"text") <> ''::"text"))
  GROUP BY "assets"."status"
UNION ALL
 SELECT 'location'::"text" AS "category",
    "assets"."location" AS "value",
    ("count"(*))::integer AS "n"
   FROM "public"."assets"
  WHERE (("assets"."deleted_at" IS NULL) AND (COALESCE("assets"."location", ''::"text") <> ''::"text"))
  GROUP BY "assets"."location"
UNION ALL
 SELECT 'department'::"text" AS "category",
    ("assets"."extra" ->> 'department'::"text") AS "value",
    ("count"(*))::integer AS "n"
   FROM "public"."assets"
  WHERE (("assets"."deleted_at" IS NULL) AND (COALESCE(("assets"."extra" ->> 'department'::"text"), ''::"text") <> ''::"text"))
  GROUP BY ("assets"."extra" ->> 'department'::"text")
UNION ALL
 SELECT 'region'::"text" AS "category",
    ("assets"."extra" ->> 'region'::"text") AS "value",
    ("count"(*))::integer AS "n"
   FROM "public"."assets"
  WHERE (("assets"."deleted_at" IS NULL) AND (COALESCE(("assets"."extra" ->> 'region'::"text"), ''::"text") <> ''::"text"))
  GROUP BY ("assets"."extra" ->> 'region'::"text");


ALTER VIEW "public"."choice_usage" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "active" boolean DEFAULT true NOT NULL,
    "invited_by" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "must_change_password" boolean DEFAULT false NOT NULL,
    "last_seen" timestamp with time zone
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."schema_migrations" (
    "version" "text" NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."schema_migrations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sharepoint_sync" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "asset_id" "uuid",
    "op" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "graph_item_id" "text",
    "payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "processed_at" timestamp with time zone,
    "attempted_at" timestamp with time zone,
    CONSTRAINT "sharepoint_sync_op_check" CHECK (("op" = ANY (ARRAY['insert'::"text", 'update'::"text", 'delete'::"text"]))),
    CONSTRAINT "sharepoint_sync_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'done'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."sharepoint_sync" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    CONSTRAINT "user_roles_role_check" CHECK (("role" = ANY (ARRAY['super_admin'::"text", 'admin'::"text", 'scanner'::"text", 'asset_viewer'::"text", 'dashboard_viewer'::"text"])))
);


ALTER TABLE "public"."user_roles" OWNER TO "postgres";


ALTER TABLE ONLY "public"."admin_audit" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."admin_audit_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."asset_events" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."asset_events_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."asset_history" ALTER COLUMN "id" SET DEFAULT "nextval"('"public"."asset_history_id_seq"'::"regclass");



ALTER TABLE ONLY "public"."admin_audit"
    ADD CONSTRAINT "admin_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."allowed_scanners"
    ADD CONSTRAINT "allowed_scanners_pkey" PRIMARY KEY ("email");



ALTER TABLE ONLY "public"."app_choices"
    ADD CONSTRAINT "app_choices_pkey" PRIMARY KEY ("category", "value");



ALTER TABLE ONLY "public"."app_config"
    ADD CONSTRAINT "app_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."asset_events"
    ADD CONSTRAINT "asset_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asset_history"
    ADD CONSTRAINT "asset_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."asset_id_high_water"
    ADD CONSTRAINT "asset_id_high_water_pkey" PRIMARY KEY ("only_row");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_graph_item_id_key" UNIQUE ("graph_item_id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_item_id_key" UNIQUE ("item_id");



ALTER TABLE ONLY "public"."assets"
    ADD CONSTRAINT "assets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."schema_migrations"
    ADD CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version");



ALTER TABLE ONLY "public"."sharepoint_sync"
    ADD CONSTRAINT "sharepoint_sync_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id", "role");



CREATE UNIQUE INDEX "assets_live_tag_unique_idx" ON "public"."assets" USING "btree" ("lower"("asset_tag")) WHERE (("deleted_at" IS NULL) AND ("asset_tag" IS NOT NULL) AND ("asset_tag" <> ''::"text"));



CREATE INDEX "idx_admin_audit_created" ON "public"."admin_audit" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_asset_events_item" ON "public"."asset_events" USING "btree" ("item_id", "event_date" DESC);



CREATE INDEX "idx_asset_events_open" ON "public"."asset_events" USING "btree" ("item_id") WHERE (("resolved" = false) AND ("event_type" = 'issue'::"text"));



CREATE INDEX "idx_asset_events_type_resolved" ON "public"."asset_events" USING "btree" ("event_type", "resolved", "event_date" DESC);



CREATE INDEX "idx_asset_history_by" ON "public"."asset_history" USING "btree" ("changed_by");



CREATE INDEX "idx_asset_history_item" ON "public"."asset_history" USING "btree" ("item_id", "changed_at" DESC);



CREATE INDEX "idx_assets_deleted" ON "public"."assets" USING "btree" ("deleted_at") WHERE ("deleted_at" IS NOT NULL);



CREATE INDEX "idx_assets_employee" ON "public"."assets" USING "btree" ("employee");



CREATE INDEX "idx_assets_live_item" ON "public"."assets" USING "btree" ("item_id") WHERE ("deleted_at" IS NULL);



CREATE INDEX "idx_assets_serial" ON "public"."assets" USING "btree" ("serial");



CREATE INDEX "idx_assets_status" ON "public"."assets" USING "btree" ("status");



CREATE INDEX "idx_outbox_undrained" ON "public"."sharepoint_sync" USING "btree" ("created_at") WHERE ("status" <> 'done'::"text");



CREATE INDEX "idx_user_roles_user" ON "public"."user_roles" USING "btree" ("user_id");



CREATE OR REPLACE TRIGGER "asset_events_guard_trigger" BEFORE INSERT OR UPDATE ON "public"."asset_events" FOR EACH ROW EXECUTE FUNCTION "public"."asset_events_guard"();



CREATE OR REPLACE TRIGGER "assets_audit_trigger" AFTER INSERT OR DELETE OR UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."assets_audit_trigger"();



CREATE OR REPLACE TRIGGER "assets_guard_choices_trigger" BEFORE INSERT OR UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."assets_guard_choices"();



CREATE OR REPLACE TRIGGER "assets_guard_lifecycle_trigger" BEFORE UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."assets_guard_lifecycle"();



CREATE OR REPLACE TRIGGER "assets_to_outbox_after_iu" AFTER INSERT OR UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."assets_to_outbox"();



CREATE OR REPLACE TRIGGER "assets_to_outbox_before_d" BEFORE DELETE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."assets_to_outbox"();



CREATE OR REPLACE TRIGGER "assets_touch_updated_at" BEFORE UPDATE ON "public"."assets" FOR EACH ROW EXECUTE FUNCTION "public"."touch_updated_at"();



CREATE OR REPLACE TRIGGER "profiles_guard_self_trigger" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."profiles_guard_self"();



CREATE OR REPLACE TRIGGER "sharepoint_sync_dispatch" AFTER INSERT ON "public"."sharepoint_sync" FOR EACH ROW EXECUTE FUNCTION "public"."dispatch_sync_row"();



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sharepoint_sync"
    ADD CONSTRAINT "sharepoint_sync_asset_id_fkey" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."user_roles"
    ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



CREATE POLICY "admin delete assets" ON "public"."assets" FOR DELETE TO "authenticated" USING (("public"."is_super_admin"() OR "public"."has_role"('admin'::"text")));



CREATE POLICY "admin delete events" ON "public"."asset_events" FOR DELETE TO "authenticated" USING (("public"."is_super_admin"() OR "public"."is_admin"()));



CREATE POLICY "admin manage allowlist" ON "public"."allowed_scanners" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin manage choices" ON "public"."app_choices" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "admin read admin audit" ON "public"."admin_audit" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "admin read migrations" ON "public"."schema_migrations" FOR SELECT TO "authenticated" USING ("public"."is_admin"());



ALTER TABLE "public"."admin_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."allowed_scanners" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "allowlisted insert assets" ON "public"."assets" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_allowed_scanner"());



CREATE POLICY "allowlisted update assets" ON "public"."assets" FOR UPDATE TO "authenticated" USING (("public"."is_super_admin"() OR "public"."is_allowed_scanner"())) WITH CHECK (("public"."is_super_admin"() OR "public"."is_allowed_scanner"()));



ALTER TABLE "public"."app_choices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."app_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."asset_id_high_water" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."assets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "authenticated read choices" ON "public"."app_choices" FOR SELECT TO "authenticated" USING (true);



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles delete admin" ON "public"."profiles" FOR DELETE TO "authenticated" USING ("public"."is_admin"());



CREATE POLICY "profiles insert admin" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ("public"."is_admin"());



CREATE POLICY "profiles read own or admin" ON "public"."profiles" FOR SELECT TO "authenticated" USING ((("id" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "profiles self select" ON "public"."profiles" FOR SELECT USING ((("id" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "profiles self update password flag" ON "public"."profiles" FOR UPDATE USING (("id" = "auth"."uid"())) WITH CHECK (("id" = "auth"."uid"()));



CREATE POLICY "profiles update admin" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());



CREATE POLICY "role holders read assets" ON "public"."assets" FOR SELECT TO "authenticated" USING ("public"."has_app_role"());



CREATE POLICY "role holders read events" ON "public"."asset_events" FOR SELECT TO "authenticated" USING ("public"."has_app_role"());



CREATE POLICY "role holders read history" ON "public"."asset_history" FOR SELECT TO "authenticated" USING ("public"."has_app_role"());



CREATE POLICY "scanner insert events" ON "public"."asset_events" FOR INSERT TO "authenticated" WITH CHECK (("public"."is_super_admin"() OR "public"."is_allowed_scanner"()));



CREATE POLICY "scanner update events" ON "public"."asset_events" FOR UPDATE TO "authenticated" USING (("public"."is_super_admin"() OR "public"."is_allowed_scanner"())) WITH CHECK (("public"."is_super_admin"() OR "public"."is_allowed_scanner"()));



ALTER TABLE "public"."schema_migrations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sharepoint_sync" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_roles read own or admin" ON "public"."user_roles" FOR SELECT TO "authenticated" USING ((("user_id" = "auth"."uid"()) OR "public"."is_admin"()));



CREATE POLICY "user_roles write admin" ON "public"."user_roles" TO "authenticated" USING ("public"."is_admin"()) WITH CHECK ("public"."is_admin"());





ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";








GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";











































































































































































GRANT ALL ON FUNCTION "public"."asset_events_guard"() TO "anon";
GRANT ALL ON FUNCTION "public"."asset_events_guard"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."asset_events_guard"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."asset_extra_merge"("p_item_id" "text", "p_patch" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."asset_extra_merge"("p_item_id" "text", "p_patch" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."asset_extra_merge"("p_item_id" "text", "p_patch" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."assets_audit_trigger"() TO "anon";
GRANT ALL ON FUNCTION "public"."assets_audit_trigger"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assets_audit_trigger"() TO "service_role";



GRANT ALL ON FUNCTION "public"."assets_guard_choices"() TO "anon";
GRANT ALL ON FUNCTION "public"."assets_guard_choices"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assets_guard_choices"() TO "service_role";



GRANT ALL ON FUNCTION "public"."assets_guard_lifecycle"() TO "anon";
GRANT ALL ON FUNCTION "public"."assets_guard_lifecycle"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assets_guard_lifecycle"() TO "service_role";



GRANT ALL ON FUNCTION "public"."assets_to_outbox"() TO "anon";
GRANT ALL ON FUNCTION "public"."assets_to_outbox"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assets_to_outbox"() TO "service_role";



GRANT ALL ON FUNCTION "public"."dispatch_sync_row"() TO "anon";
GRANT ALL ON FUNCTION "public"."dispatch_sync_row"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."dispatch_sync_row"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_app_role"() TO "anon";
GRANT ALL ON FUNCTION "public"."has_app_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_app_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_role"("want" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_role"("want" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_role"("want" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_allowed_scanner"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_allowed_scanner"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_allowed_scanner"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_super_admin"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_super_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_super_admin"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."next_asset_item_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."next_asset_item_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."next_asset_item_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."profiles_guard_self"() TO "anon";
GRANT ALL ON FUNCTION "public"."profiles_guard_self"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."profiles_guard_self"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_operational_history"("p_outbox_days" integer, "p_audit_days" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_operational_history"("p_outbox_days" integer, "p_audit_days" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_operational_history"("p_outbox_days" integer, "p_audit_days" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."requeue_failed_sync_rows"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."requeue_failed_sync_rows"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."set_user_roles"("p_user_id" "uuid", "p_roles" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."touch_last_seen"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."touch_last_seen"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_last_seen"() TO "service_role";



GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."touch_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."update_asset"("p_item_id" "text", "p_row" "jsonb", "p_extra" "jsonb") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."update_asset"("p_item_id" "text", "p_row" "jsonb", "p_extra" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_asset"("p_item_id" "text", "p_row" "jsonb", "p_extra" "jsonb") TO "service_role";
























GRANT ALL ON TABLE "public"."admin_audit" TO "anon";
GRANT ALL ON TABLE "public"."admin_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."admin_audit" TO "service_role";



GRANT ALL ON SEQUENCE "public"."admin_audit_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."admin_audit_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."admin_audit_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."allowed_scanners" TO "anon";
GRANT ALL ON TABLE "public"."allowed_scanners" TO "authenticated";
GRANT ALL ON TABLE "public"."allowed_scanners" TO "service_role";



GRANT ALL ON TABLE "public"."app_choices" TO "anon";
GRANT ALL ON TABLE "public"."app_choices" TO "authenticated";
GRANT ALL ON TABLE "public"."app_choices" TO "service_role";



GRANT ALL ON TABLE "public"."app_config" TO "anon";
GRANT ALL ON TABLE "public"."app_config" TO "authenticated";
GRANT ALL ON TABLE "public"."app_config" TO "service_role";



GRANT ALL ON TABLE "public"."asset_events" TO "anon";
GRANT ALL ON TABLE "public"."asset_events" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_events" TO "service_role";



GRANT ALL ON SEQUENCE "public"."asset_events_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."asset_events_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."asset_events_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."asset_history" TO "anon";
GRANT ALL ON TABLE "public"."asset_history" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_history" TO "service_role";



GRANT ALL ON SEQUENCE "public"."asset_history_id_seq" TO "anon";
GRANT ALL ON SEQUENCE "public"."asset_history_id_seq" TO "authenticated";
GRANT ALL ON SEQUENCE "public"."asset_history_id_seq" TO "service_role";



GRANT ALL ON TABLE "public"."asset_id_high_water" TO "anon";
GRANT ALL ON TABLE "public"."asset_id_high_water" TO "authenticated";
GRANT ALL ON TABLE "public"."asset_id_high_water" TO "service_role";



GRANT ALL ON TABLE "public"."assets" TO "anon";
GRANT ALL ON TABLE "public"."assets" TO "authenticated";
GRANT ALL ON TABLE "public"."assets" TO "service_role";



GRANT ALL ON TABLE "public"."choice_usage" TO "anon";
GRANT ALL ON TABLE "public"."choice_usage" TO "authenticated";
GRANT ALL ON TABLE "public"."choice_usage" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."schema_migrations" TO "anon";
GRANT ALL ON TABLE "public"."schema_migrations" TO "authenticated";
GRANT ALL ON TABLE "public"."schema_migrations" TO "service_role";



GRANT ALL ON TABLE "public"."sharepoint_sync" TO "anon";
GRANT ALL ON TABLE "public"."sharepoint_sync" TO "authenticated";
GRANT ALL ON TABLE "public"."sharepoint_sync" TO "service_role";



GRANT ALL ON TABLE "public"."user_roles" TO "anon";
GRANT ALL ON TABLE "public"."user_roles" TO "authenticated";
GRANT ALL ON TABLE "public"."user_roles" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































