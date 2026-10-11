-- Booking logic (Sections 5.4, 6.4, 6.9, 6.10, 7, 8.3).
-- Errors use: message = text for people, detail = machine code, hint = optional JSON payload.

-- ------------------------------------------------------------------ booking code KSR-YYMMDD-NNN
create or replace function public.next_booking_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_day date := public.ist_today();
  v_n integer;
begin
  insert into public.booking_code_counters (day, last)
  values (v_day, 1)
  on conflict (day) do update set last = public.booking_code_counters.last + 1
  returning last into v_n;
  return 'KSR-' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 3, '0');
end;
$$;

-- ------------------------------------------------------------------ derived booking fields
create or replace function public.bookings_derive()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- The turnaround buffer is captured when the booking starts holding the car.
  if tg_op = 'INSERT'
     or (new.status in ('confirmed', 'active') and old.status not in ('confirmed', 'active'))
     or new.return_due_at is distinct from old.return_due_at then
    new.buffer_minutes := greatest(0, public.booking_rule('turnaround_buffer_minutes', 60)::integer);
  end if;
  new.hold_until := new.return_due_at + make_interval(mins => new.buffer_minutes);
  new.total_paise := new.price_quoted_paise + new.extra_charges_paise - new.discount_paise;
  new.payment_status := case
    when new.refunded_paise > 0 and new.paid_paise <= 0 then 'refunded'
    when new.paid_paise <= 0 then 'unpaid'
    when new.paid_paise >= new.total_paise then 'paid'
    else 'part_paid'
  end::public.payment_status;
  if new.status in ('rejected', 'cancelled', 'no_show', 'closed')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    new.ended_at := now();
  end if;
  return new;
end;
$$;

create trigger bookings_derive
  before insert or update on public.bookings
  for each row execute function public.bookings_derive();

-- ------------------------------------------------------------------ availability
-- Bookings (Confirmed/Active, incl. buffer) and maintenance windows that overlap a proposed
-- rental [p_start, p_end + buffer). An overdue Active booking holds the car until it returns.
create or replace function public._car_clashes(p_car uuid, p_start timestamptz, p_end timestamptz, p_exclude uuid default null)
returns table (
  kind text,
  ref_id uuid,
  booking_code text,
  status public.booking_status,
  starts_at timestamptz,
  ends_at timestamptz,
  note text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with buf as (
    select make_interval(mins => greatest(0, public.booking_rule('turnaround_buffer_minutes', 60)::integer)) as b
  ),
  want as (
    select tstzrange(p_start, p_end + (select b from buf), '[)') as r
  )
  select 'booking', bk.id, bk.booking_code, bk.status, bk.pickup_at,
         case when bk.status = 'active' then greatest(bk.hold_until, now() + (select b from buf)) else bk.hold_until end,
         null::text
    from public.bookings bk
   where bk.car_id = p_car
     and bk.status in ('confirmed', 'active')
     and bk.id is distinct from p_exclude
     and tstzrange(
           bk.pickup_at,
           case when bk.status = 'active' then greatest(bk.hold_until, now() + (select b from buf)) else bk.hold_until end,
           '[)'
         ) && (select r from want)
  union all
  select 'maintenance', m.id, null, null, m.starts_at, m.ends_at,
         m.reason::text || coalesce(': ' || nullif(m.notes, ''), '')
    from public.maintenance_windows m
   where m.car_id = p_car
     and tstzrange(m.starts_at, m.ends_at, '[)') && (select r from want)
  order by 5
$$;

-- Admin-facing wrapper (signed-in staff only).
create or replace function public.car_clashes(p_car uuid, p_start timestamptz, p_end timestamptz, p_exclude uuid default null)
returns table (
  kind text,
  ref_id uuid,
  booking_code text,
  status public.booking_status,
  starts_at timestamptz,
  ends_at timestamptz,
  note text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if public.my_role() is null then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  return query select * from public._car_clashes(p_car, p_start, p_end, p_exclude);
end;
$$;

-- Up to N active cars of the same category that are free for the period (BK-10).
create or replace function public._suggest_cars(p_car uuid, p_start timestamptz, p_end timestamptz, p_limit integer default 3)
returns table (id uuid, slug text, display_name text, price_12h_paise integer, price_24h_paise integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.slug, c.display_name, c.price_12h_paise, c.price_24h_paise
    from public.cars c
    join public.cars orig on orig.id = p_car
   where c.status = 'active'
     and c.id <> p_car
     and c.category = orig.category
     and not exists (select 1 from public._car_clashes(c.id, p_start, p_end, null))
   order by abs(c.price_12h_paise - orig.price_12h_paise), c.sort_order
   limit p_limit
$$;

-- Busy windows per car for a period, without any personal data (FLE-05, availability).
create or replace function public.public_busy_windows(p_from timestamptz, p_to timestamptz)
returns table (car_id uuid, starts_at timestamptz, ends_at timestamptz, kind text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with win as (
    select tstzrange(p_from, least(p_to, p_from + interval '4 days'), '[)') as r
  )
  select b.car_id, b.pickup_at,
         case when b.status = 'active' then greatest(b.hold_until, now()) else b.hold_until end,
         'booking'
    from public.bookings b
    join public.cars c on c.id = b.car_id and c.status = 'active'
   where b.status in ('confirmed', 'active')
     and tstzrange(b.pickup_at, case when b.status = 'active' then greatest(b.hold_until, now()) else b.hold_until end, '[)')
         && (select r from win)
  union all
  select m.car_id, m.starts_at, m.ends_at, 'maintenance'
    from public.maintenance_windows m
    join public.cars c on c.id = m.car_id and c.status = 'active'
   where tstzrange(m.starts_at, m.ends_at, '[)') && (select r from win)
$$;

-- ------------------------------------------------------------------ vehicle papers (FLT-08)
-- Blocking paper types (insurance, PUC, permit) that are missing, or expire before p_until.
create or replace function public._car_paper_problems(p_car uuid, p_until timestamptz)
returns table (doc_type text, label text, expiry_date date, problem text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select dt.key, dt.label, cur.expiry_date,
         case when cur.id is null then 'missing' else 'expired' end
    from public.document_types dt
    left join lateral (
      select d.id, d.expiry_date
        from public.documents d
       where d.car_id = p_car
         and d.doc_type = dt.key
         and d.deleted_at is null
         and d.status not in ('superseded', 'rejected')
       order by d.version desc, d.created_at desc
       limit 1
    ) cur on true
   where dt.owner_type = 'car'
     and dt.blocks_booking_when_expired
     and dt.active
     and (cur.id is null or (cur.expiry_date is not null and cur.expiry_date < public.ist_date(p_until)))
   order by dt.sort_order
$$;

create or replace function public.car_paper_problems(p_car uuid, p_until timestamptz default now())
returns table (doc_type text, label text, expiry_date date, problem text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  return query select * from public._car_paper_problems(p_car, p_until);
end;
$$;

-- ------------------------------------------------------------------ pickup rules (Appendix A)
create or replace function public._validate_pickup(p_pickup timestamptz, p_staff boolean)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date := public.ist_date(p_pickup);
  v_day text := (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[extract(dow from public.ist_date(p_pickup))::integer + 1];
  v_hours jsonb := public.setting('business') -> 'hours' -> (array['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])[extract(dow from public.ist_date(p_pickup))::integer + 1];
  v_min integer := public.ist_minutes(p_pickup);
  v_step integer := greatest(5, public.booking_rule('time_step_minutes', 30)::integer);
  v_lead numeric := public.booking_rule('min_lead_hours', 2);
  v_window integer := public.booking_rule('window_days', 60)::integer;
  v_open integer;
  v_close integer;
begin
  if p_pickup is null then
    raise exception using message = 'Choose a pickup date and time.', detail = 'pickup';
  end if;
  if v_date < public.ist_today() then
    raise exception using message = 'Choose today or a later date.', detail = 'pickup';
  end if;
  if v_date > public.ist_today() + v_window then
    raise exception using message = format('You can book up to %s days ahead. Choose an earlier date.', v_window), detail = 'pickup';
  end if;
  if v_hours is not null then
    if coalesce((v_hours ->> 'closed')::boolean, false) then
      raise exception using message = format('We''re closed on %ss. Choose another day.', initcap(to_char(v_date, 'FMDay'))), detail = 'pickup';
    end if;
    v_open := split_part(v_hours ->> 'open', ':', 1)::integer * 60 + split_part(v_hours ->> 'open', ':', 2)::integer;
    v_close := split_part(v_hours ->> 'close', ':', 1)::integer * 60 + split_part(v_hours ->> 'close', ':', 2)::integer;
    if v_min < v_open or v_min > v_close then
      raise exception using
        message = format('We hand over cars between %s and %s. Choose a time in that window.', public.fmt_clock(v_open), public.fmt_clock(v_close)),
        detail = 'pickup';
    end if;
  end if;
  -- Staff-created bookings (walk-ins) skip the notice period and time step.
  if not p_staff then
    if v_min % v_step <> 0 then
      raise exception using message = format('Choose a time on a %s-minute step, for example 9:00 or 9:30.', v_step), detail = 'pickup';
    end if;
    if p_pickup < now() + make_interval(secs => (v_lead * 3600)::double precision) then
      raise exception using
        message = format('Bookings need at least %s hours'' notice. For an earlier pickup, call us.', rtrim(to_char(v_lead, 'FM999990.##'), '.')),
        detail = 'pickup';
    end if;
  end if;
end;
$$;

-- ------------------------------------------------------------------ outbox helpers (Section 11)
-- Recipients for a notification setting; falls back to active Owners and Managers.
create or replace function public._recipients(p_setting text)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    nullif(array(select jsonb_array_elements_text(public.setting('notifications') -> p_setting)), '{}'::text[]),
    array(
      select sp.email
        from public.staff_profiles sp
        join public.user_roles ur on ur.user_id = sp.user_id
       where sp.active and ur.role in ('owner', 'manager')
       order by ur.role, sp.email
    )
  )
$$;

create or replace function public._enqueue_email(p_kind text, p_recipients text[], p_subject text, p_body text, p_payload jsonb default '{}'::jsonb, p_dedupe text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.outbox (kind, channel, recipients, subject, body, payload, dedupe_key, status)
  values (
    p_kind, 'email', coalesce(p_recipients, '{}'), p_subject, p_body, coalesce(p_payload, '{}'::jsonb), p_dedupe,
    case when coalesce(array_length(p_recipients, 1), 0) = 0 then 'skipped' else 'pending' end::public.outbox_status
  )
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;

-- ------------------------------------------------------------------ create a booking (BK-09, BKA-06)
create or replace function public._create_booking(
  p_car_id uuid,
  p_package public.booking_package,
  p_pickup_at timestamptz,
  p_custom_hours integer,
  p_full_name text,
  p_phone text,
  p_dl_number text,
  p_email text,
  p_source public.booking_source,
  p_created_by uuid,
  p_notice_version text,
  p_consent_channel text,
  p_ip text,
  p_user_agent text,
  p_reject_on_clash boolean,
  p_staff boolean,
  p_price_override_paise integer default null,
  p_override_reason text default null,
  p_admin_notes text default '',
  p_deposit_paise integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_car public.cars;
  v_customer public.customers;
  v_booking public.bookings;
  v_phone text := public.normalize_phone(p_phone);
  v_dl text := public.normalize_dl(p_dl_number);
  v_name text := regexp_replace(trim(coalesce(p_full_name, '')), '[[:space:]]+', ' ', 'g');
  v_email text := lower(nullif(trim(coalesce(p_email, '')), ''));
  v_hours integer;
  v_return timestamptz;
  v_price integer;
  v_flags text[] := '{}';
  v_clashes jsonb;
  v_notes text := coalesce(p_admin_notes, '');
  v_consent_id uuid;
begin
  select * into v_car from public.cars where id = p_car_id;
  if not found or v_car.status <> 'active' then
    raise exception using message = 'Choose a car.', detail = 'car_id';
  end if;
  if v_phone is null then
    raise exception using message = 'Enter a 10-digit mobile number starting with 6, 7, 8 or 9.', detail = 'phone';
  end if;
  if char_length(v_name) not between 2 and 80 or v_name ~ '[0-9<>@#$%^&*()_+=\[\]{}|\\/:;",?!~`]' then
    raise exception using message = 'Use 2–80 letters. Spaces, full stops, apostrophes and hyphens are fine.', detail = 'full_name';
  end if;
  if v_dl is null or v_dl !~ '^[A-Z0-9]{6,20}$' then
    raise exception using message = 'Enter your driving licence number as printed, for example TS0920110012345.', detail = 'dl_number';
  end if;
  if v_email is not null and v_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$' then
    raise exception using message = 'Enter a valid email address, or leave it blank.', detail = 'email';
  end if;

  perform public._validate_pickup(p_pickup_at, p_staff);

  v_hours := case p_package when '12h' then 12 when '24h' then 24 else p_custom_hours end;
  if v_hours is null or v_hours < 1 then
    raise exception using message = 'Choose a 12 hr or 24 hr package.', detail = 'package';
  end if;
  v_return := p_pickup_at + make_interval(hours => v_hours);

  -- Price snapshot (8.3): the price shown now is stored and never changes with car prices.
  v_price := case p_package when '12h' then v_car.price_12h_paise when '24h' then v_car.price_24h_paise end;
  if p_price_override_paise is not null and p_price_override_paise is distinct from v_price then
    if not p_staff then
      raise exception using message = 'Not allowed.', detail = 'forbidden';
    end if;
    if coalesce(trim(p_override_reason), '') = '' and v_price is not null then
      raise exception using message = 'A price override needs a reason.', detail = 'price_reason';
    end if;
    v_price := p_price_override_paise;
  end if;
  if v_price is null or v_price < 0 then
    raise exception using message = 'Enter a price for a custom package.', detail = 'price';
  end if;

  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_clashes
    from public._car_clashes(p_car_id, p_pickup_at, v_return, null) c;
  if jsonb_array_length(v_clashes) > 0 then
    if p_reject_on_clash then
      -- Public response: no booking codes or times, just alternatives.
      return jsonb_build_object(
        'ok', false,
        'error', 'clash',
        'message', 'This car is booked at that time. Try another time or another car.',
        'suggestions', (select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb) from public._suggest_cars(p_car_id, p_pickup_at, v_return, 3) s)
      );
    end if;
    v_flags := array_append(v_flags, 'clash');
  end if;

  -- One customer per mobile number (CUS-01).
  insert into public.customers (full_name, phone, email, dl_number)
  values (v_name, v_phone, v_email, v_dl)
  on conflict (phone) do nothing
  returning * into v_customer;

  if v_customer.id is null then
    select * into v_customer from public.customers where phone = v_phone for update;
    update public.customers
       set full_name = case when identity_verified then full_name else v_name end,
           email = coalesce(v_email, email),
           dl_number = coalesce(dl_number, v_dl)
     where id = v_customer.id
     returning * into v_customer;
    if v_customer.dl_number is distinct from v_dl then
      v_notes := concat_ws(E'\n', nullif(v_notes, ''), 'Licence number given for this booking: ' || v_dl || ' (differs from the one on file).');
    end if;
  end if;

  if v_customer.blocked then
    v_flags := array_append(v_flags, 'blocked_customer');
  end if;
  if v_customer.dl_expiry is not null and v_customer.dl_expiry < public.ist_date(v_return) then
    v_flags := array_append(v_flags, 'dl_expiry');
  end if;
  if not public.is_modern_dl(v_dl) then
    v_flags := array_append(v_flags, 'dl_format');
  end if;

  insert into public.bookings (
    booking_code, customer_id, car_id, package, custom_hours, pickup_at, return_due_at, hold_until,
    status, source, price_quoted_paise, flags, admin_notes, created_by, deposit_paise
  )
  values (
    public.next_booking_code(), v_customer.id, p_car_id, p_package,
    case when p_package = 'custom' then v_hours end,
    p_pickup_at, v_return, v_return, 'requested', p_source, v_price, v_flags, v_notes, p_created_by,
    coalesce(p_deposit_paise, public.booking_rule('default_deposit_paise', 0)::integer)
  )
  returning * into v_booking;

  insert into public.consents (customer_id, booking_id, purpose, notice_version, channel, ip, user_agent, recorded_by)
  values (v_customer.id, v_booking.id, 'booking', p_notice_version, p_consent_channel, p_ip, left(p_user_agent, 400), p_created_by)
  returning id into v_consent_id;

  update public.bookings set consent_id = v_consent_id where id = v_booking.id;

  insert into public.booking_events (booking_id, kind, from_status, to_status, actor_id, note)
  values (
    v_booking.id, 'status', null, 'requested', p_created_by,
    case when p_source = 'website' then 'Request sent from the website' else 'Created by staff (' || replace(p_source::text, '_', '-') || ')' end
      || case when p_price_override_paise is not null and coalesce(trim(p_override_reason), '') <> ''
              then '. Price set to ' || public.fmt_rupees(v_price) || ': ' || p_override_reason else '' end
  );

  -- New request alert (Section 11). Flagged requests also go to the flagged list.
  perform public._enqueue_email(
    'new_request',
    array(select distinct unnest(public._recipients('new_request_emails')
      || case when cardinality(v_flags) > 0 then public._recipients('flagged_emails') else '{}'::text[] end)),
    'New booking request ' || v_booking.booking_code || ' – ' || v_car.display_name,
    concat_ws(E'\n',
      'New booking request ' || v_booking.booking_code,
      '',
      'Car: ' || v_car.display_name,
      'Package: ' || case p_package when '12h' then '12 hrs' when '24h' then '24 hrs' else v_hours || ' hrs' end,
      'Pickup: ' || public.fmt_when(v_booking.pickup_at),
      'Return by: ' || public.fmt_when(v_booking.return_due_at),
      'Price: ' || public.fmt_rupees(v_price),
      'Customer: ' || v_customer.full_name || ', ' || v_customer.phone,
      'Source: ' || p_source::text,
      case when cardinality(v_flags) > 0 then 'Flags: ' || array_to_string(v_flags, ', ') end
    ),
    jsonb_build_object('booking_code', v_booking.booking_code, 'path', '/admin/bookings/' || v_booking.booking_code)
  );

  return jsonb_build_object(
    'ok', true,
    'booking_id', v_booking.id,
    'booking_code', v_booking.booking_code,
    'customer_id', v_customer.id,
    'price_paise', v_price,
    'pickup_at', v_booking.pickup_at,
    'return_due_at', v_booking.return_due_at,
    'flags', to_jsonb(v_flags),
    'clashes', v_clashes
  );
end;
$$;

-- Website requests go through the submit-booking edge function, which rate-limits.
create or replace function public._register_submission(p_kind text, p_phone text, p_ip_hash text, p_max_phone integer, p_max_ip integer)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_phone is not null and (
    select count(*) from public.submission_attempts
     where kind = p_kind and phone = p_phone and at > now() - interval '1 hour'
  ) >= p_max_phone then
    return false;
  end if;
  if p_ip_hash is not null and (
    select count(*) from public.submission_attempts
     where kind = p_kind and ip_hash = p_ip_hash and at > now() - interval '1 hour'
  ) >= p_max_ip then
    return false;
  end if;
  insert into public.submission_attempts (kind, phone, ip_hash) values (p_kind, p_phone, p_ip_hash);
  return true;
end;
$$;

-- Phone, walk-in and WhatsApp bookings created by Owner/Manager (BKA-06).
create or replace function public.admin_create_booking(
  p_car_id uuid,
  p_package public.booking_package,
  p_pickup_at timestamptz,
  p_full_name text,
  p_phone text,
  p_dl_number text,
  p_source public.booking_source,
  p_consent_confirmed boolean,
  p_email text default null,
  p_custom_hours integer default null,
  p_price_override_paise integer default null,
  p_override_reason text default null,
  p_admin_notes text default '',
  p_deposit_paise integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  if p_source = 'website' then
    raise exception using message = 'Choose phone, walk-in or WhatsApp as the source.', detail = 'source';
  end if;
  if not coalesce(p_consent_confirmed, false) then
    raise exception using message = 'Confirm the customer agreed to how we use their details.', detail = 'consent';
  end if;
  if p_package = 'custom' and p_price_override_paise is null then
    raise exception using message = 'Enter a price for a custom package.', detail = 'price';
  end if;
  return public._create_booking(
    p_car_id, p_package, p_pickup_at, p_custom_hours, p_full_name, p_phone, p_dl_number, p_email,
    p_source, auth.uid(), public.current_notice_version(), 'admin', public.request_ip(),
    public.request_header('user-agent'), false, true, p_price_override_paise, p_override_reason,
    p_admin_notes, p_deposit_paise
  );
end;
$$;

-- ------------------------------------------------------------------ status transitions (Section 7)
create or replace function public.booking_transition(
  p_booking uuid,
  p_to public.booking_status,
  p_note text default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  b public.bookings;
  v_clash record;
  v_problem record;
  v_note text := nullif(trim(coalesce(p_note, '')), '');
  v_reason text := nullif(trim(coalesce(p_override_reason, '')), '');
  v_overrides text[] := '{}';
  v_balance integer;
  v_deposit integer;
begin
  if v_role is null then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  select * into b from public.bookings where id = p_booking for update;
  if not found or (v_role = 'staff' and not public.staff_can_see_booking(b.pickup_at, b.return_due_at, b.status)) then
    raise exception using message = 'Booking not found.', detail = 'not_found';
  end if;

  if p_to in ('active', 'returned') then
    raise exception using message = 'Use the handover checklist to record pickup and return.', detail = 'use_handover';
  end if;

  if not (
    (b.status = 'requested' and p_to in ('confirmed', 'rejected', 'cancelled') and v_role in ('owner', 'manager'))
    or (b.status = 'confirmed' and p_to = 'cancelled' and v_role in ('owner', 'manager'))
    or (b.status = 'confirmed' and p_to = 'no_show')
    or (b.status = 'returned' and p_to = 'closed' and v_role in ('owner', 'manager'))
  ) then
    raise exception using message = format('This booking can''t move from %s to %s.', b.status, p_to), detail = 'state';
  end if;

  if p_to in ('rejected', 'cancelled') and v_note is null then
    raise exception using message = 'Give a reason.', detail = 'reason';
  end if;

  if p_to = 'confirmed' then
    if (select status from public.cars where id = b.car_id) <> 'active' then
      raise exception using message = 'This car is inactive. Make it active or move the booking to another car.', detail = 'car_inactive';
    end if;
    -- BKA-07: refuse clashes and show the clashing booking.
    select * into v_clash from public._car_clashes(b.car_id, b.pickup_at, b.return_due_at, b.id) limit 1;
    if found then
      raise exception using
        message = case v_clash.kind
          when 'booking' then format('This car is already booked: %s (%s – %s).', v_clash.booking_code, public.fmt_when(v_clash.starts_at), public.fmt_when(v_clash.ends_at))
          else format('This car is in maintenance from %s to %s.', public.fmt_when(v_clash.starts_at), public.fmt_when(v_clash.ends_at))
        end,
        detail = 'clash',
        hint = jsonb_build_object('kind', v_clash.kind, 'id', v_clash.ref_id, 'code', v_clash.booking_code,
                                  'starts_at', v_clash.starts_at, 'ends_at', v_clash.ends_at)::text;
    end if;
    -- FLT-08: expired insurance / PUC / permit blocks confirmation unless the Owner overrides.
    for v_problem in select * from public._car_paper_problems(b.car_id, b.return_due_at) where problem = 'expired' loop
      if v_role = 'owner' and v_reason is not null then
        v_overrides := array_append(v_overrides, v_problem.label || ' expired ' || to_char(v_problem.expiry_date, 'DD Mon YYYY'));
      else
        raise exception using
          message = format('%s for this car expires on %s, before the return time. The Owner can override with a reason.',
                           v_problem.label, to_char(v_problem.expiry_date, 'FMDD Mon YYYY')),
          detail = 'papers_expired',
          hint = jsonb_build_object('doc_type', v_problem.doc_type, 'expiry_date', v_problem.expiry_date)::text;
      end if;
    end loop;
  end if;

  if p_to = 'no_show' and now() < b.pickup_at then
    raise exception using message = 'You can mark a no-show only after the pickup time.', detail = 'state';
  end if;

  if p_to = 'closed' then
    v_balance := b.total_paise - b.paid_paise;
    v_deposit := b.deposit_received_paise - b.deposit_refunded_paise;
    if v_balance <> 0 or v_deposit <> 0 then
      if v_reason is null then
        raise exception using
          message = format('Settle the booking first: balance %s, deposit held %s. To close anyway, give a reason.',
                           public.fmt_rupees(v_balance), public.fmt_rupees(v_deposit)),
          detail = 'unsettled';
      end if;
      v_overrides := array_append(v_overrides, 'Closed with balance ' || public.fmt_rupees(v_balance) || ' and deposit held ' || public.fmt_rupees(v_deposit));
    end if;
  end if;

  update public.bookings
     set status = p_to,
         cancel_reason = case when p_to in ('rejected', 'cancelled') then v_note else cancel_reason end
   where id = b.id;

  insert into public.booking_events (booking_id, kind, from_status, to_status, actor_id, note)
  values (b.id, 'status', b.status, p_to, auth.uid(), v_note);

  if cardinality(v_overrides) > 0 then
    insert into public.booking_events (booking_id, kind, actor_id, note)
    values (b.id, 'override', auth.uid(), array_to_string(v_overrides, '; ') || '. Reason: ' || v_reason);
    perform public.write_audit('booking.override', 'bookings', b.id::text, null,
      jsonb_build_object('to', p_to, 'overrides', to_jsonb(v_overrides), 'reason', v_reason));
  end if;

  return jsonb_build_object('ok', true, 'status', p_to);
exception
  when exclusion_violation then
    raise exception using message = 'This car is already booked at that time.', detail = 'clash';
end;
$$;

-- ------------------------------------------------------------------ pickup gate (DOC-09, AC-09)
-- The booking page picks a fix button from these messages ("identity" → verify identity,
-- "expires on" → renew licence, otherwise verify/upload licence). Keep those words if you
-- reword them (src/admin/pages/bookings/detail/helpers.ts).
create or replace function public.pickup_gate_problems(p_booking uuid)
returns text[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  b public.bookings;
  c public.customers;
  v_expiry date;
  v_problems text[] := '{}';
begin
  if not public.can_see_booking(p_booking) then
    raise exception using message = 'Booking not found.', detail = 'not_found';
  end if;
  select * into b from public.bookings where id = p_booking;
  select * into c from public.customers where id = b.customer_id;
  if not exists (
    select 1 from public.documents d
     where d.customer_id = c.id and d.doc_type = 'dl_front' and d.status = 'verified' and d.deleted_at is null
  ) then
    v_problems := array_append(v_problems, 'Verify the driving licence (front photo) first.');
  end if;
  select max(d.expiry_date) into v_expiry
    from public.documents d
   where d.customer_id = c.id and d.doc_type = 'dl_front' and d.status = 'verified' and d.deleted_at is null;
  v_expiry := coalesce(v_expiry, c.dl_expiry);
  if v_expiry is null then
    v_problems := array_append(v_problems, 'Record the licence expiry date when verifying the licence.');
  elsif v_expiry < public.ist_date(b.return_due_at) then
    v_problems := array_append(v_problems, 'The driving licence expires on ' || to_char(v_expiry, 'FMDD Mon YYYY') || ', before the return time.');
  end if;
  if not c.identity_verified then
    v_problems := array_append(v_problems, 'Verify the customer''s identity (Aadhaar QR, passport or voter ID).');
  end if;
  return v_problems;
end;
$$;

-- ------------------------------------------------------------------ handover and return (HND-01..04)
create or replace function public.record_handover(
  p_booking uuid,
  p_kind public.handover_kind,
  p_odometer_km integer,
  p_fuel_level public.fuel_level,
  p_checklist jsonb default '{}'::jsonb,
  p_damage_notes text default '',
  p_signature_document_id uuid default null,
  p_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  b public.bookings;
  v_problems text[];
  v_reason text := nullif(trim(coalesce(p_override_reason, '')), '');
  v_pickup public.handover_records;
  v_now timestamptz := now();
  v_grace integer := public.booking_rule('late_grace_minutes', 30)::integer;
  v_late_hours integer := 0;
  v_km integer;
  v_limit integer;
  v_extra_km integer := 0;
  v_fuel_order text[] := array['empty', 'quarter', 'half', 'three_quarter', 'full'];
  v_fuel_diff integer;
begin
  if v_role is null then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  select * into b from public.bookings where id = p_booking for update;
  if not found or (v_role = 'staff' and not public.staff_can_see_booking(b.pickup_at, b.return_due_at, b.status)) then
    raise exception using message = 'Booking not found.', detail = 'not_found';
  end if;
  if p_odometer_km is null or p_odometer_km < 0 then
    raise exception using message = 'Enter the odometer reading in km.', detail = 'odometer_km';
  end if;
  if p_signature_document_id is not null and not exists (
    select 1 from public.documents where id = p_signature_document_id and booking_id = b.id
  ) then
    raise exception using message = 'The signature must be saved to this booking.', detail = 'invalid';
  end if;

  if p_kind = 'pickup' then
    if b.status <> 'confirmed' then
      raise exception using message = 'Only a Confirmed booking can be handed over.', detail = 'state';
    end if;
    v_problems := public.pickup_gate_problems(b.id);
    if cardinality(v_problems) > 0 then
      if v_role = 'owner' and v_reason is not null then
        insert into public.booking_events (booking_id, kind, actor_id, note)
        values (b.id, 'override', auth.uid(), 'Pickup checks overridden (' || array_to_string(v_problems, ' ') || '). Reason: ' || v_reason);
        perform public.write_audit('booking.override', 'bookings', b.id::text, null,
          jsonb_build_object('to', 'active', 'problems', to_jsonb(v_problems), 'reason', v_reason));
      else
        raise exception using message = array_to_string(v_problems, ' '), detail = 'pickup_gate', hint = to_jsonb(v_problems)::text;
      end if;
    end if;

    insert into public.handover_records (booking_id, kind, odometer_km, fuel_level, checklist, damage_notes, signature_document_id, recorded_by, recorded_at)
    values (b.id, 'pickup', p_odometer_km, p_fuel_level, coalesce(p_checklist, '{}'::jsonb), coalesce(p_damage_notes, ''), p_signature_document_id, auth.uid(), v_now);

    update public.bookings set status = 'active', actual_pickup_at = v_now where id = b.id;
    insert into public.booking_events (booking_id, kind, from_status, to_status, actor_id, note)
    values (b.id, 'status', 'confirmed', 'active', auth.uid(),
            'Picked up. Odometer ' || p_odometer_km || ' km, fuel ' || replace(p_fuel_level::text, '_', ' ') || '.');
    return jsonb_build_object('ok', true, 'status', 'active');
  end if;

  -- Return
  if b.status <> 'active' then
    raise exception using message = 'Only an Active booking can be returned.', detail = 'state';
  end if;
  select * into v_pickup from public.handover_records where booking_id = b.id and kind = 'pickup';
  if found and p_odometer_km < v_pickup.odometer_km then
    raise exception using message = format('The odometer reading is lower than at pickup (%s km).', v_pickup.odometer_km), detail = 'odometer_km';
  end if;

  insert into public.handover_records (booking_id, kind, odometer_km, fuel_level, checklist, damage_notes, signature_document_id, recorded_by, recorded_at)
  values (b.id, 'return', p_odometer_km, p_fuel_level, coalesce(p_checklist, '{}'::jsonb), coalesce(p_damage_notes, ''), p_signature_document_id, auth.uid(), v_now);

  update public.bookings set status = 'returned', actual_return_at = v_now where id = b.id;

  if v_now > b.return_due_at + make_interval(mins => v_grace) then
    v_late_hours := ceil(extract(epoch from (v_now - b.return_due_at - make_interval(mins => v_grace))) / 3600.0)::integer;
  end if;
  if v_pickup.id is not null then
    v_km := p_odometer_km - v_pickup.odometer_km;
    v_fuel_diff := array_position(v_fuel_order, p_fuel_level::text) - array_position(v_fuel_order, v_pickup.fuel_level::text);
    v_limit := nullif(public.setting('booking_rules') ->> case b.package when '12h' then 'km_limit_12h' when '24h' then 'km_limit_24h' end, '')::integer;
    if v_limit is not null and v_km > v_limit then
      v_extra_km := v_km - v_limit;
    end if;
  end if;

  insert into public.booking_events (booking_id, kind, from_status, to_status, actor_id, note)
  values (b.id, 'status', 'active', 'returned', auth.uid(),
          'Returned. Odometer ' || p_odometer_km || ' km'
          || coalesce(' (' || v_km || ' km driven)', '')
          || ', fuel ' || replace(p_fuel_level::text, '_', ' ')
          || case when v_late_hours > 0 then ', ' || v_late_hours || ' h late' else '' end || '.');

  return jsonb_build_object(
    'ok', true,
    'status', 'returned',
    'km_driven', v_km,
    'fuel_diff_quarters', v_fuel_diff,
    'late_hours', v_late_hours,
    'suggested_late_fee_paise', v_late_hours * public.booking_rule('late_fee_per_hour_paise', 0)::integer,
    'extra_km', v_extra_km,
    'suggested_km_charge_paise', v_extra_km * coalesce(public.booking_rule('extra_km_rate_paise', 0)::integer, 0),
    'deposit_held_paise', b.deposit_received_paise - b.deposit_refunded_paise
  );
end;
$$;

-- ------------------------------------------------------------------ edits (BKA-05)
create or replace function public.update_booking(
  p_booking uuid,
  p_car_id uuid default null,
  p_package public.booking_package default null,
  p_custom_hours integer default null,
  p_pickup_at timestamptz default null,
  p_price_paise integer default null,
  p_reason text default null,
  p_discount_paise integer default null,
  p_deposit_paise integer default null,
  p_admin_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.bookings;
  v_car public.cars;
  v_car_id uuid;
  v_pkg public.booking_package;
  v_hours integer;
  v_pickup timestamptz;
  v_return timestamptz;
  v_std integer;
  v_price integer;
  v_changes text[] := '{}';
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
  v_core_change boolean;
  v_clash record;
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  select * into b from public.bookings where id = p_booking for update;
  if not found then
    raise exception using message = 'Booking not found.', detail = 'not_found';
  end if;

  v_car_id := coalesce(p_car_id, b.car_id);
  v_pkg := coalesce(p_package, b.package);
  v_hours := case v_pkg when '12h' then 12 when '24h' then 24 else coalesce(p_custom_hours, b.custom_hours) end;
  v_pickup := coalesce(p_pickup_at, b.pickup_at);
  v_return := v_pickup + make_interval(hours => v_hours);
  select * into v_car from public.cars where id = v_car_id;
  if not found then
    raise exception using message = 'Choose a car.', detail = 'car_id';
  end if;
  v_std := case v_pkg when '12h' then v_car.price_12h_paise when '24h' then v_car.price_24h_paise end;

  v_core_change := v_car_id <> b.car_id or v_pkg <> b.package or v_pickup <> b.pickup_at
                   or v_return <> b.return_due_at or (p_price_paise is not null and p_price_paise <> b.price_quoted_paise);

  if v_core_change then
    if b.status not in ('requested', 'confirmed') then
      raise exception using message = 'You can change the car, package, time or price only before pickup.', detail = 'state';
    end if;
    if p_price_paise is not null then
      v_price := p_price_paise;
      if v_price is distinct from v_std and v_reason is null then
        raise exception using message = 'A price override needs a reason.', detail = 'price_reason';
      end if;
    elsif v_car_id <> b.car_id or v_pkg <> b.package then
      v_price := coalesce(v_std, b.price_quoted_paise);
    else
      v_price := b.price_quoted_paise;
    end if;
    if b.status = 'confirmed' and (v_car_id <> b.car_id or v_pickup <> b.pickup_at or v_return <> b.return_due_at) then
      select * into v_clash from public._car_clashes(v_car_id, v_pickup, v_return, b.id) limit 1;
      if found then
        raise exception using
          message = case v_clash.kind
            when 'booking' then format('This car is already booked: %s (%s – %s).', v_clash.booking_code, public.fmt_when(v_clash.starts_at), public.fmt_when(v_clash.ends_at))
            else format('This car is in maintenance from %s to %s.', public.fmt_when(v_clash.starts_at), public.fmt_when(v_clash.ends_at))
          end,
          detail = 'clash';
      end if;
      if v_car.status <> 'active' then
        raise exception using message = 'This car is inactive.', detail = 'car_inactive';
      end if;
      if exists (select 1 from public._car_paper_problems(v_car_id, v_return) where problem = 'expired') then
        raise exception using message = 'This car''s insurance, PUC or permit expires before the return time.', detail = 'papers_expired';
      end if;
    end if;
    if v_car_id <> b.car_id then v_changes := array_append(v_changes, 'car → ' || v_car.display_name); end if;
    if v_pkg <> b.package then v_changes := array_append(v_changes, 'package → ' || v_pkg::text); end if;
    if v_pickup <> b.pickup_at then v_changes := array_append(v_changes, 'pickup → ' || public.fmt_when(v_pickup)); end if;
    if v_price <> b.price_quoted_paise then v_changes := array_append(v_changes, 'price → ' || public.fmt_rupees(v_price)); end if;
  else
    v_price := b.price_quoted_paise;
  end if;

  if p_discount_paise is not null and p_discount_paise <> b.discount_paise then
    if v_reason is null then
      raise exception using message = 'A discount needs a reason.', detail = 'price_reason';
    end if;
    v_changes := array_append(v_changes, 'discount → ' || public.fmt_rupees(p_discount_paise));
  end if;
  if p_deposit_paise is not null and p_deposit_paise <> b.deposit_paise then
    v_changes := array_append(v_changes, 'deposit → ' || public.fmt_rupees(p_deposit_paise));
  end if;
  if p_admin_notes is not null and p_admin_notes <> b.admin_notes then
    v_changes := array_append(v_changes, 'notes updated');
  end if;

  if cardinality(v_changes) = 0 then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  update public.bookings
     set car_id = v_car_id,
         package = v_pkg,
         custom_hours = case when v_pkg = 'custom' then v_hours end,
         pickup_at = v_pickup,
         return_due_at = v_return,
         price_quoted_paise = v_price,
         discount_paise = coalesce(p_discount_paise, discount_paise),
         deposit_paise = coalesce(p_deposit_paise, deposit_paise),
         admin_notes = coalesce(p_admin_notes, admin_notes)
   where id = b.id;

  insert into public.booking_events (booking_id, kind, actor_id, note)
  values (b.id, 'edit', auth.uid(), 'Changed: ' || array_to_string(v_changes, ', ') || coalesce('. Reason: ' || v_reason, ''));

  return jsonb_build_object('ok', true, 'changed', true);
exception
  when exclusion_violation then
    raise exception using message = 'This car is already booked at that time.', detail = 'clash';
end;
$$;

-- ------------------------------------------------------------------ extension (BKA-09)
create or replace function public.extend_booking(
  p_booking uuid,
  p_kind text,
  p_hours integer default null,
  p_amount_paise integer default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.bookings;
  v_car public.cars;
  v_add integer;
  v_new_return timestamptz;
  v_price integer;
  v_rate integer;
  v_clash record;
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  select * into b from public.bookings where id = p_booking for update;
  if not found then
    raise exception using message = 'Booking not found.', detail = 'not_found';
  end if;
  if b.status <> 'active' then
    raise exception using message = 'Only an Active booking can be extended.', detail = 'state';
  end if;
  select * into v_car from public.cars where id = b.car_id;
  v_add := case p_kind when '12h' then 12 when '24h' then 24 when 'hours' then p_hours end;
  if v_add is null or v_add < 1 or v_add > 240 then
    raise exception using message = 'Choose how long to extend by.', detail = 'hours';
  end if;
  v_new_return := b.return_due_at + make_interval(hours => v_add);

  select * into v_clash from public._car_clashes(b.car_id, b.return_due_at, v_new_return, b.id) limit 1;
  if found then
    raise exception using
      message = case v_clash.kind
        when 'booking' then format('The car is booked next from %s (%s). Extend for less time, or move that booking.', public.fmt_when(v_clash.starts_at), v_clash.booking_code)
        else format('The car has maintenance from %s.', public.fmt_when(v_clash.starts_at))
      end,
      detail = 'clash';
  end if;

  v_rate := case
    when public.booking_rule('extra_hour_rate_paise', 0)::integer > 0 then public.booking_rule('extra_hour_rate_paise', 0)::integer
    else (ceil(v_car.price_24h_paise / 24.0 / 100.0) * 100)::integer
  end;
  v_price := case p_kind when '12h' then v_car.price_12h_paise when '24h' then v_car.price_24h_paise else v_add * v_rate end;
  if p_amount_paise is not null and p_amount_paise <> v_price then
    if coalesce(trim(p_reason), '') = '' then
      raise exception using message = 'A price override needs a reason.', detail = 'price_reason';
    end if;
    v_price := p_amount_paise;
  end if;

  update public.bookings set return_due_at = v_new_return, overdue_notified_at = null where id = b.id;
  if v_price > 0 then
    insert into public.booking_charges (booking_id, kind, amount_paise, note, added_by)
    values (b.id, 'extension', v_price, 'Extended by ' || v_add || ' hrs; return by ' || public.fmt_when(v_new_return)
            || coalesce('. ' || nullif(trim(p_reason), ''), ''), auth.uid());
  end if;
  insert into public.booking_events (booking_id, kind, actor_id, note)
  values (b.id, 'edit', auth.uid(), 'Extended by ' || v_add || ' hrs for ' || public.fmt_rupees(v_price) || '. New return by ' || public.fmt_when(v_new_return) || '.');

  return jsonb_build_object('ok', true, 'return_due_at', v_new_return, 'price_paise', v_price);
exception
  when exclusion_violation then
    raise exception using message = 'This car is already booked at that time.', detail = 'clash';
end;
$$;

-- ------------------------------------------------------------------ ledger (PAY-01..03, HND-04)
create or replace function public._recompute_ledger(p_booking uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.bookings b
     set extra_charges_paise = coalesce((select sum(amount_paise) from public.booking_charges where booking_id = b.id), 0),
         paid_paise = coalesce((
           select sum(case when type in ('rent', 'extra') then amount_paise when type = 'refund' then -amount_paise else 0 end)
             from public.payments where booking_id = b.id), 0),
         refunded_paise = coalesce((select sum(amount_paise) from public.payments where booking_id = b.id and type = 'refund'), 0),
         deposit_received_paise = coalesce((select sum(amount_paise) from public.payments where booking_id = b.id and type = 'deposit'), 0),
         deposit_refunded_paise = coalesce((select sum(amount_paise) from public.payments where booking_id = b.id and type = 'deposit_refund'), 0)
   where b.id = p_booking
$$;

create or replace function public.ledger_changed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public._recompute_ledger(coalesce(new.booking_id, old.booking_id));
  return coalesce(new, old);
end;
$$;

create trigger payments_ledger after insert or update or delete on public.payments
  for each row execute function public.ledger_changed();
create trigger booking_charges_ledger after insert or update or delete on public.booking_charges
  for each row execute function public.ledger_changed();

create or replace function public.add_booking_charge(
  p_booking uuid,
  p_kind public.charge_kind,
  p_amount_paise integer,
  p_note text default '',
  p_document_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  b public.bookings;
  v_id uuid;
begin
  if v_role is null then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  select * into b from public.bookings where id = p_booking for update;
  if not found or (v_role = 'staff' and not public.staff_can_see_booking(b.pickup_at, b.return_due_at, b.status)) then
    raise exception using message = 'Booking not found.', detail = 'not_found';
  end if;
  if b.status in ('requested', 'rejected', 'cancelled') then
    raise exception using message = 'Add charges once the booking is confirmed.', detail = 'state';
  end if;
  if b.status = 'closed' and v_role = 'staff' then
    raise exception using message = 'Only the Owner or a Manager can add charges to a closed booking.', detail = 'forbidden';
  end if;
  if coalesce(p_amount_paise, 0) <= 0 then
    raise exception using message = 'Enter an amount above zero.', detail = 'amount';
  end if;
  if p_kind in ('damage', 'other', 'challan') and coalesce(trim(p_note), '') = '' then
    raise exception using message = 'Add a note describing the charge.', detail = 'note';
  end if;
  insert into public.booking_charges (booking_id, kind, amount_paise, note, document_id, added_by)
  values (b.id, p_kind, p_amount_paise, coalesce(trim(p_note), ''), p_document_id, auth.uid())
  returning id into v_id;
  insert into public.booking_events (booking_id, kind, actor_id, note)
  values (b.id, 'charge', auth.uid(), 'Charge added: ' || replace(p_kind::text, '_', ' ') || ' ' || public.fmt_rupees(p_amount_paise)
          || coalesce(' (' || nullif(trim(p_note), '') || ')', ''));
  return v_id;
end;
$$;

create or replace function public.remove_booking_charge(p_charge uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.booking_charges;
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception using message = 'Give a reason.', detail = 'reason';
  end if;
  delete from public.booking_charges where id = p_charge returning * into c;
  if c.id is null then
    raise exception using message = 'Charge not found.', detail = 'not_found';
  end if;
  insert into public.booking_events (booking_id, kind, actor_id, note)
  values (c.booking_id, 'charge', auth.uid(), 'Charge removed: ' || replace(c.kind::text, '_', ' ') || ' ' || public.fmt_rupees(c.amount_paise) || '. Reason: ' || p_reason);
end;
$$;

create or replace function public.record_payment(
  p_booking uuid,
  p_amount_paise integer,
  p_type public.payment_type,
  p_method public.payment_method,
  p_reference text default null,
  p_note text default '',
  p_receipt_document_id uuid default null,
  p_received_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role public.app_role := public.my_role();
  b public.bookings;
  v_id uuid;
begin
  if v_role is null then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  select * into b from public.bookings where id = p_booking for update;
  if not found or (v_role = 'staff' and not public.staff_can_see_booking(b.pickup_at, b.return_due_at, b.status)) then
    raise exception using message = 'Booking not found.', detail = 'not_found';
  end if;
  if coalesce(p_amount_paise, 0) <= 0 then
    raise exception using message = 'Enter an amount above zero.', detail = 'amount';
  end if;
  -- PAY-03: refunds need a reason and only Owner/Manager can record them.
  if p_type in ('refund', 'deposit_refund') then
    if v_role = 'staff' then
      raise exception using message = 'Only the Owner or a Manager can record refunds.', detail = 'forbidden';
    end if;
    if coalesce(trim(p_note), '') = '' then
      raise exception using message = 'Give a reason for the refund.', detail = 'note';
    end if;
    if p_type = 'deposit_refund' and p_amount_paise > b.deposit_received_paise - b.deposit_refunded_paise then
      raise exception using message = 'The refund is more than the deposit held.', detail = 'amount';
    end if;
  end if;
  insert into public.payments (booking_id, amount_paise, type, method, reference, note, receipt_document_id, received_by, received_at)
  values (b.id, p_amount_paise, p_type, p_method, nullif(trim(coalesce(p_reference, '')), ''), coalesce(trim(p_note), ''),
          p_receipt_document_id, auth.uid(), coalesce(p_received_at, now()))
  returning id into v_id;
  insert into public.booking_events (booking_id, kind, actor_id, note)
  values (b.id, 'payment', auth.uid(), replace(initcap(replace(p_type::text, '_', ' ')), 'Deposit Refund', 'Deposit refund')
          || ' ' || public.fmt_rupees(p_amount_paise) || ' by ' || upper(p_method::text)
          || coalesce(' (ref ' || nullif(trim(coalesce(p_reference, '')), '') || ')', ''));
  return v_id;
end;
$$;

-- Open fine, claim or dispute: hold the booking's documents (10.4).
create or replace function public.set_booking_hold(p_booking uuid, p_on_hold boolean, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  if p_on_hold and coalesce(trim(p_reason), '') = '' then
    raise exception using message = 'Give a reason for the hold.', detail = 'reason';
  end if;
  update public.bookings set on_hold = p_on_hold, hold_reason = case when p_on_hold then p_reason end where id = p_booking;
  insert into public.booking_events (booking_id, kind, actor_id, note)
  values (p_booking, 'note', auth.uid(), case when p_on_hold then 'Put on hold: ' || p_reason else 'Hold removed' end);
end;
$$;

-- ------------------------------------------------------------------ public booking lookup (5.5)
create or replace function public.lookup_booking(p_code text, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := encode(sha256(convert_to('lookup:' || coalesce(public.request_ip(), 'unknown'), 'UTF8')), 'hex');
  v_phone text := public.normalize_phone(p_phone);
  r record;
begin
  if not public._register_submission('lookup', null, v_key, 0, 10) then
    raise exception using message = 'Too many requests. Please call us.', detail = 'rate_limited';
  end if;
  if v_phone is null then
    return jsonb_build_object('found', false);
  end if;
  select b.booking_code, b.status, b.package, b.custom_hours, b.pickup_at, b.return_due_at, c.display_name
    into r
    from public.bookings b
    join public.customers cu on cu.id = b.customer_id
    join public.cars c on c.id = b.car_id
   where b.booking_code = upper(trim(p_code)) and cu.phone = v_phone;
  if not found then
    return jsonb_build_object('found', false);
  end if;
  return jsonb_build_object(
    'found', true,
    'code', r.booking_code,
    'status', case
      when r.status = 'requested' then 'Requested'
      when r.status = 'confirmed' then 'Confirmed'
      when r.status in ('cancelled', 'rejected', 'no_show') then 'Cancelled'
      when r.status = 'active' then 'On trip'
      else 'Completed'
    end,
    'car', r.display_name,
    'package', case r.package when '12h' then '12 hrs' when '24h' then '24 hrs' else r.custom_hours || ' hrs' end,
    'pickup_at', r.pickup_at,
    'return_due_at', r.return_due_at
  );
end;
$$;

-- ------------------------------------------------------------------ reports (RPT-02, DSH-06)
create or replace function public.report_utilisation(p_from timestamptz, p_to timestamptz)
returns table (car_id uuid, display_name text, hours_available numeric, hours_rented numeric, utilisation numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner_or_manager() then
    raise exception using message = 'Not allowed.', detail = 'forbidden';
  end if;
  return query
  with cars_in as (
    select c.id, c.display_name, c.sort_order from public.cars c where c.status = 'active' or exists (
      select 1 from public.bookings b where b.car_id = c.id and b.pickup_at < p_to and coalesce(b.actual_return_at, b.return_due_at) > p_from
    )
  ),
  maint as (
    select m.car_id,
           sum(extract(epoch from (least(m.ends_at, p_to) - greatest(m.starts_at, p_from))) / 3600.0) as h
      from public.maintenance_windows m
     where m.starts_at < p_to and m.ends_at > p_from
     group by m.car_id
  ),
  rented as (
    select b.car_id,
           sum(greatest(0, extract(epoch from (
             least(coalesce(b.actual_return_at, case when b.status = 'active' then least(now(), p_to) else b.return_due_at end), p_to)
             - greatest(coalesce(b.actual_pickup_at, b.pickup_at), p_from)
           )) / 3600.0)) as h
      from public.bookings b
     where b.status in ('active', 'returned', 'closed')
       and coalesce(b.actual_pickup_at, b.pickup_at) < p_to
       and coalesce(b.actual_return_at, b.return_due_at, now()) > p_from
     group by b.car_id
  )
  select ci.id, ci.display_name,
         round(greatest(0, extract(epoch from (p_to - p_from)) / 3600.0 - coalesce(mt.h, 0)), 1),
         round(coalesce(rt.h, 0), 1),
         case when extract(epoch from (p_to - p_from)) / 3600.0 - coalesce(mt.h, 0) > 0
              then round(coalesce(rt.h, 0) / (extract(epoch from (p_to - p_from)) / 3600.0 - coalesce(mt.h, 0)), 4)
              else 0 end
    from cars_in ci
    left join maint mt on mt.car_id = ci.id
    left join rented rt on rt.car_id = ci.id
   order by ci.sort_order, ci.display_name;
end;
$$;
