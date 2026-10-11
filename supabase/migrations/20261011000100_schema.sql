-- KSR Self Drive Cars: core schema (PRD Section 8).
-- All tables have id (UUID), created_at and updated_at. Times are stored in UTC and
-- shown in IST. Money is stored as whole paise (integer).

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ------------------------------------------------------------------ enums
create type public.app_role as enum ('owner', 'manager', 'staff');
create type public.car_status as enum ('active', 'inactive');
create type public.body_type as enum ('hatchback', 'compact_suv', 'crossover', 'suv', 'micro_suv', 'mpv', 'premium_mpv');
create type public.car_category as enum ('hatch', 'suv', 'mpv');
create type public.fuel_type as enum ('petrol', 'diesel', 'cng', 'electric');
create type public.transmission_type as enum ('manual', 'automatic');
create type public.booking_package as enum ('12h', '24h', 'custom');
create type public.booking_status as enum ('requested', 'confirmed', 'rejected', 'cancelled', 'no_show', 'active', 'returned', 'closed');
create type public.booking_source as enum ('website', 'phone', 'walk_in', 'whatsapp');
create type public.payment_status as enum ('unpaid', 'part_paid', 'paid', 'refunded');
create type public.payment_type as enum ('rent', 'deposit', 'extra', 'refund', 'deposit_refund');
create type public.payment_method as enum ('cash', 'upi', 'card', 'bank');
create type public.charge_kind as enum ('late', 'fuel', 'damage', 'cleaning', 'challan', 'extension', 'other');
create type public.fuel_level as enum ('empty', 'quarter', 'half', 'three_quarter', 'full');
create type public.handover_kind as enum ('pickup', 'return');
create type public.maintenance_reason as enum ('service', 'repair', 'accident', 'other');
create type public.identity_method as enum ('aadhaar_qr', 'aadhaar_original_seen', 'passport', 'voter_id', 'other', 'digilocker');
create type public.doc_owner_type as enum ('customer', 'booking', 'car', 'business');
create type public.doc_status as enum ('pending', 'verified', 'rejected', 'expired', 'superseded');
create type public.verification_method as enum ('original_seen', 'qr_scan', 'online_portal');
create type public.upload_channel as enum ('admin', 'customer_link');
create type public.policy_kind as enum ('privacy', 'terms', 'cancellation');
create type public.data_request_kind as enum ('access', 'correction', 'erasure', 'grievance', 'consent_withdrawal');
create type public.data_request_status as enum ('open', 'in_progress', 'done', 'refused');
create type public.outbox_status as enum ('pending', 'sent', 'failed', 'skipped');

-- ------------------------------------------------------------------ helpers
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ------------------------------------------------------------------ staff
create table public.staff_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 80),
  email text not null,
  phone text,
  active boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  role public.app_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ settings & policies
create table public.settings (
  key text primary key check (key in ('business', 'booking_rules', 'notifications', 'templates', 'retention', 'security')),
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users (id) on delete set null,
  id uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.policy_versions (
  id uuid primary key default gen_random_uuid(),
  kind public.policy_kind not null,
  locale text not null default 'en' check (locale in ('en', 'te', 'hi')),
  version integer not null check (version > 0),
  title text not null,
  body_md text not null,
  published_at timestamptz not null default now(),
  published_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kind, locale, version)
);

-- ------------------------------------------------------------------ fleet
create table public.cars (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  display_name text not null check (char_length(display_name) between 2 and 80),
  brand text not null default '',
  model text not null default '',
  variant text not null default '',
  body_type public.body_type not null,
  category public.car_category not null,
  seats smallint not null check (seats between 2 and 12),
  fuel public.fuel_type not null,
  transmission public.transmission_type not null default 'manual',
  colour text not null default '',
  year smallint check (year between 1990 and 2100),
  -- Admin only, never public. Stored upper-case without spaces, e.g. TS09EA1234.
  registration_number text unique check (registration_number ~ '^[A-Z0-9]{6,12}$'),
  badge text check (badge is null or char_length(badge) between 1 and 24),
  description text not null default '' check (char_length(description) <= 500),
  price_12h_paise integer not null check (price_12h_paise > 0),
  price_24h_paise integer not null check (price_24h_paise > 0),
  status public.car_status not null default 'active',
  sort_order integer not null default 0,
  cover_photo_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index cars_status_sort_idx on public.cars (status, sort_order);

create table public.car_photos (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars (id) on delete cascade,
  -- Path of the full-size WebP in the car-photos bucket; smaller variants sit beside it
  -- as {id}-800.webp and {id}-400.webp.
  storage_path text not null unique,
  alt_text text not null check (char_length(alt_text) between 3 and 200),
  sort_order integer not null default 0,
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index car_photos_car_idx on public.car_photos (car_id, sort_order);

alter table public.cars
  add constraint cars_cover_photo_fk foreign key (cover_photo_id) references public.car_photos (id) on delete set null;

create table public.car_price_history (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars (id) on delete cascade,
  price_12h_paise integer not null,
  price_24h_paise integer not null,
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index car_price_history_car_idx on public.car_price_history (car_id, changed_at desc);

create table public.maintenance_windows (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason public.maintenance_reason not null,
  notes text not null default '',
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index maintenance_windows_car_idx on public.maintenance_windows using gist (car_id, tstzrange(starts_at, ends_at, '[)'));

-- ------------------------------------------------------------------ customers
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (char_length(full_name) between 2 and 80),
  -- One customer per mobile number (CUS-01). Null only after erasure (DP-05).
  phone text unique check (phone ~ '^\+91[6-9][0-9]{9}$'),
  email text check (email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$'),
  dl_number text check (dl_number is null or dl_number ~ '^[A-Z0-9]{6,20}$'),
  dl_expiry date,
  -- Only the last 4 digits; the full Aadhaar number is never stored (AAD-03, AC-03).
  aadhaar_last4 char(4) check (aadhaar_last4 is null or aadhaar_last4 ~ '^[0-9]{4}$'),
  identity_verified boolean not null default false,
  identity_method public.identity_method,
  identity_verified_by uuid references auth.users (id) on delete set null,
  identity_verified_at timestamptz,
  blocked boolean not null default false,
  block_reason text,
  notes text not null default '',
  erased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (not blocked or coalesce(block_reason, '') <> ''),
  check (phone is not null or erased_at is not null)
);
create index customers_name_idx on public.customers (lower(full_name));
create index customers_dl_idx on public.customers (dl_number);

-- ------------------------------------------------------------------ bookings
create table public.booking_code_counters (
  day date primary key,
  last integer not null
);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  booking_id uuid,
  purpose text not null check (purpose in ('booking', 'aadhaar_verification', 'document_upload')),
  notice_version text not null,
  channel text not null default 'website' check (channel in ('website', 'admin', 'customer_link')),
  granted_at timestamptz not null default now(),
  ip text,
  user_agent text,
  recorded_by uuid references auth.users (id) on delete set null,
  withdrawn_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index consents_customer_idx on public.consents (customer_id);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  booking_code text not null unique check (booking_code ~ '^KSR-[0-9]{6}-[0-9]{3,}$'),
  customer_id uuid not null references public.customers (id) on delete restrict,
  car_id uuid not null references public.cars (id) on delete restrict,
  package public.booking_package not null,
  custom_hours smallint check (custom_hours is null or custom_hours between 1 and 720),
  pickup_at timestamptz not null,
  return_due_at timestamptz not null,
  -- return_due_at + turnaround buffer; maintained by trigger. The car is held over
  -- [pickup_at, hold_until) while the booking is Confirmed or Active.
  hold_until timestamptz not null,
  buffer_minutes integer not null default 0 check (buffer_minutes >= 0),
  actual_pickup_at timestamptz,
  actual_return_at timestamptz,
  status public.booking_status not null default 'requested',
  source public.booking_source not null default 'website',
  -- Price shown to the customer; never changes when car prices change (8.3).
  price_quoted_paise integer not null check (price_quoted_paise >= 0),
  extra_charges_paise integer not null default 0,
  discount_paise integer not null default 0 check (discount_paise >= 0),
  deposit_paise integer not null default 0 check (deposit_paise >= 0),
  deposit_received_paise integer not null default 0,
  deposit_refunded_paise integer not null default 0,
  total_paise integer not null default 0,
  paid_paise integer not null default 0,
  refunded_paise integer not null default 0,
  payment_status public.payment_status not null default 'unpaid',
  flags text[] not null default '{}'
    check (flags <@ array['clash', 'blocked_customer', 'dl_expiry', 'dl_format']::text[]),
  cancel_reason text,
  admin_notes text not null default '',
  -- Open fine, claim or dispute: documents are skipped by the retention purge (10.4).
  on_hold boolean not null default false,
  hold_reason text,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  consent_id uuid references public.consents (id) on delete set null,
  ended_at timestamptz,
  overdue_notified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (return_due_at > pickup_at),
  check (hold_until >= return_due_at),
  check (package <> 'custom' or custom_hours is not null),
  -- No overlapping Confirmed/Active bookings on one car (8.3).
  constraint bookings_no_overlap exclude using gist (
    car_id with =,
    tstzrange(pickup_at, hold_until, '[)') with &&
  ) where (status in ('confirmed', 'active'))
);
create index bookings_status_pickup_idx on public.bookings (status, pickup_at);
create index bookings_pickup_idx on public.bookings (pickup_at);
create index bookings_return_idx on public.bookings (return_due_at);
create index bookings_customer_idx on public.bookings (customer_id);
create index bookings_car_idx on public.bookings (car_id, pickup_at);

alter table public.consents
  add constraint consents_booking_fk foreign key (booking_id) references public.bookings (id) on delete cascade;

create table public.booking_events (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  kind text not null default 'status' check (kind in ('status', 'edit', 'handover', 'payment', 'charge', 'note', 'override')),
  from_status public.booking_status,
  to_status public.booking_status,
  actor_id uuid references auth.users (id) on delete set null,
  note text,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index booking_events_booking_idx on public.booking_events (booking_id, at);

-- ------------------------------------------------------------------ documents
create table public.document_types (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  label text not null,
  owner_type public.doc_owner_type not null,
  is_kyc boolean not null default false,
  tracks_expiry boolean not null default false,
  expiry_required boolean not null default false,
  blocks_booking_when_expired boolean not null default false,
  required_for_pickup boolean not null default false,
  view_roles public.app_role[] not null default array['owner', 'manager']::public.app_role[],
  download_roles public.app_role[] not null default array['owner', 'manager']::public.app_role[],
  -- Days to keep after the retention basis event; null = no automatic erasure.
  retention_days integer check (retention_days is null or retention_days >= 0),
  retention_basis text not null default 'none'
    check (retention_basis in ('none', 'booking_end', 'customer_last_booking_end')),
  sort_order integer not null default 0,
  active boolean not null default true,
  id uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.upload_links (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  booking_id uuid references public.bookings (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  owner_type public.doc_owner_type not null,
  customer_id uuid references public.customers (id) on delete cascade,
  booking_id uuid references public.bookings (id) on delete cascade,
  -- restrict: deleting a car must not silently drop document rows whose files stay in storage.
  car_id uuid references public.cars (id) on delete restrict,
  owner_id uuid generated always as (
    case owner_type
      when 'customer' then customer_id
      when 'booking' then booking_id
      when 'car' then car_id
    end
  ) stored,
  doc_type text not null references public.document_types (key),
  storage_path text not null unique,
  original_filename text not null check (char_length(original_filename) between 1 and 255),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  doc_number_masked text check (doc_number_masked is null or char_length(doc_number_masked) <= 40),
  issue_date date,
  expiry_date date,
  notes text not null default '',
  status public.doc_status not null default 'pending',
  verification_method public.verification_method,
  verified_by uuid references auth.users (id) on delete set null,
  verified_at timestamptz,
  reject_reason text,
  version integer not null default 1 check (version > 0),
  replaces_id uuid references public.documents (id) on delete set null,
  -- DOC-10: the uploader confirmed only the last 4 Aadhaar digits are visible.
  aadhaar_masked_confirmed boolean not null default false,
  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_via public.upload_channel not null default 'admin',
  upload_link_id uuid references public.upload_links (id) on delete set null,
  legal_hold boolean not null default false,
  hold_reason text,
  deleted_at timestamptz,
  deleted_by uuid references auth.users (id) on delete set null,
  delete_reason text,
  retain_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (owner_type = 'customer' and customer_id is not null and car_id is null)
    or (owner_type = 'booking' and booking_id is not null and car_id is null)
    or (owner_type = 'car' and car_id is not null and customer_id is null and booking_id is null)
    or (owner_type = 'business' and car_id is null and customer_id is null and booking_id is null)
  ),
  check (status <> 'rejected' or coalesce(reject_reason, '') <> ''),
  check (deleted_at is null or coalesce(delete_reason, '') <> '')
);
create index documents_customer_idx on public.documents (customer_id) where customer_id is not null;
create index documents_booking_idx on public.documents (booking_id) where booking_id is not null;
create index documents_car_idx on public.documents (car_id) where car_id is not null;
create index documents_type_idx on public.documents (doc_type, status);
create index documents_expiry_idx on public.documents (expiry_date) where deleted_at is null and expiry_date is not null;
create index documents_sha_idx on public.documents (sha256);
create index documents_retain_idx on public.documents (retain_until) where retain_until is not null;

-- ------------------------------------------------------------------ handover, charges, payments
create table public.handover_records (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  kind public.handover_kind not null,
  odometer_km integer not null check (odometer_km >= 0),
  fuel_level public.fuel_level not null,
  checklist jsonb not null default '{}'::jsonb,
  damage_notes text not null default '',
  signature_document_id uuid references public.documents (id) on delete set null,
  recorded_by uuid references auth.users (id) on delete set null,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, kind)
);

create table public.booking_charges (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  kind public.charge_kind not null,
  amount_paise integer not null check (amount_paise > 0),
  note text not null default '',
  document_id uuid references public.documents (id) on delete set null,
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index booking_charges_booking_idx on public.booking_charges (booking_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete restrict,
  amount_paise integer not null check (amount_paise > 0),
  type public.payment_type not null,
  method public.payment_method not null,
  reference text,
  note text not null default '',
  receipt_document_id uuid references public.documents (id) on delete set null,
  received_by uuid references auth.users (id) on delete set null,
  received_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (type not in ('refund', 'deposit_refund') or coalesce(note, '') <> '')
);
create index payments_booking_idx on public.payments (booking_id);
create index payments_received_idx on public.payments (received_at);

create table public.service_logs (
  id uuid primary key default gen_random_uuid(),
  car_id uuid not null references public.cars (id) on delete cascade,
  service_date date not null,
  odometer_km integer check (odometer_km is null or odometer_km >= 0),
  work_done text not null,
  cost_paise integer not null default 0 check (cost_paise >= 0),
  garage text not null default '',
  invoice_document_id uuid references public.documents (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index service_logs_car_idx on public.service_logs (car_id, service_date desc);

-- ------------------------------------------------------------------ privacy requests
create table public.data_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers (id) on delete set null,
  requester_name text not null,
  requester_contact text not null,
  kind public.data_request_kind not null,
  details text not null default '',
  status public.data_request_status not null default 'open',
  received_at timestamptz not null default now(),
  due_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  handled_by uuid references auth.users (id) on delete set null,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ audit & system
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_role text,
  action text not null,
  entity_type text not null,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  user_agent text,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index audit_logs_at_idx on public.audit_logs (at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on public.audit_logs (actor_id, at desc);
create index audit_logs_action_idx on public.audit_logs (action, at desc);

create table public.submission_attempts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('booking', 'lookup', 'upload')),
  phone text,
  ip_hash text,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index submission_attempts_idx on public.submission_attempts (kind, at);

create table public.login_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  succeeded boolean not null,
  at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index login_attempts_user_idx on public.login_attempts (user_id, at desc);

create table public.account_locks (
  user_id uuid primary key,
  locked_until timestamptz not null,
  id uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.outbox (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  channel text not null default 'email' check (channel in ('email', 'whatsapp', 'sms')),
  recipients text[] not null default '{}',
  subject text not null default '',
  body text not null default '',
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text unique,
  status public.outbox_status not null default 'pending',
  attempts integer not null default 0,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbox_pending_idx on public.outbox (created_at) where status = 'pending';

create table public.document_reminders (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  days_before integer not null,
  sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (document_id, days_before)
);

-- ------------------------------------------------------------------ updated_at triggers
do $$
declare
  t text;
begin
  foreach t in array array[
    'staff_profiles', 'user_roles', 'settings', 'policy_versions', 'cars', 'car_photos', 'car_price_history',
    'maintenance_windows', 'customers', 'consents', 'bookings', 'booking_events', 'document_types',
    'upload_links', 'documents', 'handover_records', 'booking_charges', 'payments', 'service_logs',
    'data_requests', 'audit_logs', 'submission_attempts', 'login_attempts', 'account_locks', 'outbox',
    'document_reminders'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_updated_at', t
    );
  end loop;
end;
$$;
