-- Helpers: IST time, settings, roles (ADM-04), staff scope, request metadata, audit log (6.13).
-- Internal functions start with "_" and are executable only by service_role (see the grants
-- at the end of the RLS migration).

-- ------------------------------------------------------------------ time (IST = UTC+05:30)
create or replace function public.ist_date(p_ts timestamptz)
returns date
language sql
stable
as $$
  select ((p_ts at time zone 'UTC') + interval '330 minutes')::date
$$;

create or replace function public.ist_today()
returns date
language sql
stable
as $$
  select public.ist_date(now())
$$;

create or replace function public.ist_day_start(p_day date)
returns timestamptz
language sql
stable
as $$
  select (p_day::timestamp - interval '330 minutes') at time zone 'UTC'
$$;

-- Minutes since IST midnight.
create or replace function public.ist_minutes(p_ts timestamptz)
returns integer
language sql
stable
as $$
  select (extract(hour from (p_ts at time zone 'UTC') + interval '330 minutes') * 60
        + extract(minute from (p_ts at time zone 'UTC') + interval '330 minutes'))::integer
$$;

create or replace function public.fmt_clock(p_minutes integer)
returns text
language sql
immutable
as $$
  select ((((p_minutes / 60) % 24 + 11) % 12) + 1)::text || ':' || lpad((p_minutes % 60)::text, 2, '0')
         || case when (p_minutes / 60) % 24 >= 12 then ' pm' else ' am' end
$$;

-- "Sat, 12 Oct, 9:00 am" in IST, matching the web app.
create or replace function public.fmt_when(p_ts timestamptz)
returns text
language sql
stable
as $$
  select to_char((p_ts at time zone 'UTC') + interval '330 minutes', 'Dy, FMDD Mon, ')
         || public.fmt_clock(public.ist_minutes(p_ts))
$$;

-- "₹1,800", "₹1,00,000" (Indian digit grouping).
create or replace function public.fmt_rupees(p_paise bigint)
returns text
language plpgsql
immutable
as $$
declare
  v_rupees text := (abs(p_paise) / 100)::text;
  v_head text;
  v_out text;
begin
  if length(v_rupees) > 3 then
    v_head := left(v_rupees, length(v_rupees) - 3);
    v_head := regexp_replace(v_head, '(\d)(?=(\d\d)+$)', '\1,', 'g');
    v_rupees := v_head || ',' || right(v_rupees, 3);
  end if;
  v_out := '₹' || v_rupees;
  if abs(p_paise) % 100 <> 0 then
    v_out := v_out || '.' || lpad((abs(p_paise) % 100)::text, 2, '0');
  end if;
  return case when p_paise < 0 then '−' || v_out else v_out end;
end;
$$;

-- ------------------------------------------------------------------ normalisation
create or replace function public.normalize_phone(p_input text)
returns text
language plpgsql
immutable
as $$
declare
  d text := regexp_replace(coalesce(p_input, ''), '[[:space:]().-]', '', 'g');
begin
  if d like '+91%' then d := substr(d, 4);
  elsif d like '0091%' then d := substr(d, 5);
  elsif length(d) = 12 and d like '91%' then d := substr(d, 3);
  elsif length(d) = 11 and d like '0%' then d := substr(d, 2);
  end if;
  if d ~ '^[6-9][0-9]{9}$' then
    return '+91' || d;
  end if;
  return null;
end;
$$;

create or replace function public.normalize_dl(p_input text)
returns text
language sql
immutable
as $$
  select nullif(upper(regexp_replace(coalesce(p_input, ''), '[[:space:]/-]', '', 'g')), '')
$$;

create or replace function public.is_modern_dl(p_dl text)
returns boolean
language sql
immutable
as $$
  select coalesce(p_dl ~ '^[A-Z]{2}[0-9]{2}(19|20)[0-9]{2}[0-9]{7}$', false)
$$;

create or replace function public.mask_number(p_value text)
returns text
language sql
immutable
as $$
  select case
    when coalesce(p_value, '') = '' then null
    when length(regexp_replace(p_value, '[[:space:]]', '', 'g')) <= 4 then regexp_replace(p_value, '[[:space:]]', '', 'g')
    else repeat('X', length(regexp_replace(p_value, '[[:space:]]', '', 'g')) - 4)
         || right(regexp_replace(p_value, '[[:space:]]', '', 'g'), 4)
  end
$$;

-- ------------------------------------------------------------------ settings
create or replace function public.setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select value from public.settings where key = p_key), '{}'::jsonb)
$$;

create or replace function public.booking_rule(p_name text, p_default numeric)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(public.setting('booking_rules') ->> p_name, '')::numeric, p_default)
$$;

create or replace function public.retention_setting(p_name text, p_default integer)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(nullif(public.setting('retention') ->> p_name, '')::integer, p_default)
$$;

-- Label of the privacy notice version a customer agrees to, e.g. "privacy-en-v1" (SET-03).
create or replace function public.current_notice_version(p_locale text default 'en')
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select 'privacy-' || locale || '-v' || version
       from public.policy_versions
      where kind = 'privacy' and locale = coalesce(p_locale, 'en')
      order by version desc
      limit 1),
    'privacy-en-v0'
  )
$$;

-- ------------------------------------------------------------------ roles (ADM-04)
-- Raw role check, as named in the PRD.
create or replace function public.has_role(p_user uuid, p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.user_roles ur
      join public.staff_profiles sp on sp.user_id = ur.user_id
     where ur.user_id = p_user and ur.role = p_role and sp.active
  )
$$;

-- Role of the signed-in user if their account is active, ignoring two-step status.
create or replace function public.my_role_unchecked()
returns public.app_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select ur.role
    from public.user_roles ur
    join public.staff_profiles sp on sp.user_id = ur.user_id
   where ur.user_id = auth.uid() and sp.active
$$;

create or replace function public.mfa_required(p_role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select p_role::text in (select jsonb_array_elements_text(value -> 'mfa_required_roles'))
       from public.settings where key = 'security'),
    p_role in ('owner', 'manager')
  )
$$;

-- Role used for data access. Owner and Manager get no access until they have completed
-- two-step verification in this session (ADM-03): their JWT must carry aal2.
create or replace function public.my_role()
returns public.app_role
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role_unchecked();
begin
  if v_role is null then
    return null;
  end if;
  if public.mfa_required(v_role) and coalesce(auth.jwt() ->> 'aal', 'aal1') <> 'aal2' then
    return null;
  end if;
  return v_role;
end;
$$;

create or replace function public.is_owner()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.my_role() = 'owner', false)
$$;

create or replace function public.is_owner_or_manager()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.my_role() in ('owner', 'manager'), false)
$$;

create or replace function public.is_admin_user()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.my_role() is not null
$$;

-- What the admin UI needs to route the user: role, whether two-step is required, current level.
create or replace function public.my_access()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'user_id', auth.uid(),
    'role', public.my_role_unchecked(),
    'effective_role', public.my_role(),
    'mfa_required', coalesce(public.mfa_required(public.my_role_unchecked()), false),
    'aal', coalesce(auth.jwt() ->> 'aal', 'aal1'),
    'full_name', (select full_name from public.staff_profiles where user_id = auth.uid()),
    'active', coalesce((select active from public.staff_profiles where user_id = auth.uid()), false),
    'security', public.setting('security')
  )
$$;

-- ------------------------------------------------------------------ staff scope
-- Staff see bookings from yesterday to tomorrow (IST), plus any car currently out.
create or replace function public.in_staff_window(p_ts timestamptz)
returns boolean
language sql
stable
as $$
  select p_ts >= public.ist_day_start(public.ist_today() - 1)
     and p_ts < public.ist_day_start(public.ist_today() + 2)
$$;

create or replace function public.staff_can_see_booking(p_pickup timestamptz, p_return timestamptz, p_status public.booking_status)
returns boolean
language sql
stable
as $$
  select p_status = 'active' or public.in_staff_window(p_pickup) or public.in_staff_window(p_return)
$$;

-- Staff see a customer, and their KYC documents, only on the day of their booking.
create or replace function public.customer_has_booking_today(p_customer uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.bookings b
     where b.customer_id = p_customer
       and b.status not in ('rejected', 'cancelled')
       and (
         b.status = 'active'
         or public.ist_date(b.pickup_at) = public.ist_today()
         or public.ist_date(b.return_due_at) = public.ist_today()
       )
  )
$$;

-- Can the signed-in user see this booking at all?
create or replace function public.can_see_booking(p_booking uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case public.my_role()
    when 'owner' then exists (select 1 from public.bookings where id = p_booking)
    when 'manager' then exists (select 1 from public.bookings where id = p_booking)
    when 'staff' then exists (
      select 1 from public.bookings b
       where b.id = p_booking and public.staff_can_see_booking(b.pickup_at, b.return_due_at, b.status)
    )
    else false
  end
$$;

-- ------------------------------------------------------------------ request metadata
create or replace function public.request_header(p_name text)
returns text
language sql
stable
as $$
  select nullif(current_setting('request.headers', true), '')::json ->> p_name
$$;

create or replace function public.request_ip()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(trim(split_part(public.request_header('x-forwarded-for'), ',', 1)), ''),
    public.request_header('cf-connecting-ip'),
    public.request_header('x-real-ip')
  )
$$;

-- ------------------------------------------------------------------ audit log (6.13)
create or replace function public.write_audit(
  p_action text,
  p_entity_type text,
  p_entity_id text,
  p_before jsonb default null,
  p_after jsonb default null,
  p_actor uuid default null,
  p_ip text default null,
  p_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := coalesce(p_actor, auth.uid());
  v_id uuid;
begin
  insert into public.audit_logs (actor_id, actor_role, action, entity_type, entity_id, before, after, ip, user_agent)
  values (
    v_actor,
    (select role::text from public.user_roles where user_id = v_actor),
    p_action,
    p_entity_type,
    p_entity_id,
    p_before,
    p_after,
    coalesce(p_ip, public.request_ip()),
    left(coalesce(p_user_agent, public.request_header('user-agent')), 400)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Events the browser may log itself (exports, sign-out, bulk downloads).
create or replace function public.log_client_event(
  p_action text,
  p_entity_type text default 'app',
  p_entity_id text default null,
  p_meta jsonb default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if public.my_role_unchecked() is null then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  if p_action not in (
    'auth.logout', 'auth.mfa_verified', 'auth.mfa_enrolled', 'auth.session_timeout',
    'report.export', 'bookings.export', 'payments.export', 'documents.bulk_download', 'booking.print'
  ) then
    raise exception using message = 'Unknown audit action.', detail = 'invalid';
  end if;
  perform public.write_audit(p_action, p_entity_type, p_entity_id, null, p_meta);
end;
$$;

-- Generic row-change trigger: logs who changed what, with before/after of changed fields.
-- Retention jobs set ksr.skip_row_audit so erasing personal data does not copy it into the log.
create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_before jsonb;
  v_after jsonb;
begin
  if coalesce(current_setting('ksr.skip_row_audit', true), '') = 'on' then
    return coalesce(new, old);
  end if;

  if tg_op = 'UPDATE' then
    select jsonb_object_agg(o.key, o.value) into v_before
      from jsonb_each(v_old) o
     where o.key not in ('updated_at', 'created_at') and o.value is distinct from (v_new -> o.key);
    select jsonb_object_agg(n.key, n.value) into v_after
      from jsonb_each(v_new) n
     where n.key not in ('updated_at', 'created_at') and n.value is distinct from (v_old -> n.key);
    if v_after is null then
      return new;
    end if;
  else
    v_before := v_old;
    v_after := v_new;
  end if;

  perform public.write_audit(
    tg_table_name || '.' || lower(tg_op),
    tg_table_name,
    coalesce(v_row ->> 'id', v_row ->> 'user_id', v_row ->> 'key'),
    v_before,
    v_after
  );
  return coalesce(new, old);
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'cars', 'car_photos', 'maintenance_windows', 'customers', 'bookings', 'booking_charges', 'payments',
    'handover_records', 'settings', 'policy_versions', 'user_roles', 'staff_profiles', 'document_types',
    'data_requests', 'service_logs'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.audit_row_change()',
      t || '_audit', t
    );
  end loop;
end;
$$;

-- Audit entries are read-only (AUD-03). Only the retention purge may delete old entries.
create or replace function public.audit_logs_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('ksr.audit_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception using message = 'Audit log entries cannot be changed or deleted.', errcode = '42501';
end;
$$;

drop trigger if exists audit_logs_updated_at on public.audit_logs;
create trigger audit_logs_immutable
  before update or delete on public.audit_logs
  for each row execute function public.audit_logs_immutable();

-- ------------------------------------------------------------------ fleet triggers
-- Price history (FLT-03).
create or replace function public.track_car_price()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT'
     or new.price_12h_paise is distinct from old.price_12h_paise
     or new.price_24h_paise is distinct from old.price_24h_paise then
    insert into public.car_price_history (car_id, price_12h_paise, price_24h_paise, changed_by)
    values (new.id, new.price_12h_paise, new.price_24h_paise, auth.uid());
  end if;
  return new;
end;
$$;

create trigger cars_price_history
  after insert or update of price_12h_paise, price_24h_paise on public.cars
  for each row execute function public.track_car_price();

-- Up to 8 photos per car (FLT-05).
create or replace function public.limit_car_photos()
returns trigger
language plpgsql
as $$
begin
  if (select count(*) from public.car_photos where car_id = new.car_id) >= 8 then
    raise exception using message = 'A car can have up to 8 photos. Remove one first.', detail = 'photo_limit';
  end if;
  return new;
end;
$$;

create trigger car_photos_limit
  before insert on public.car_photos
  for each row execute function public.limit_car_photos();

-- Cover photo must belong to the car.
create or replace function public.check_cover_photo()
returns trigger
language plpgsql
as $$
begin
  if new.cover_photo_id is not null
     and not exists (select 1 from public.car_photos where id = new.cover_photo_id and car_id = new.id) then
    raise exception using message = 'The cover photo must be one of this car''s photos.', detail = 'invalid';
  end if;
  return new;
end;
$$;

create trigger cars_cover_photo_check
  before insert or update of cover_photo_id on public.cars
  for each row execute function public.check_cover_photo();
