-- KSR Self Drive Cars: SQLite schema (PRD Section 8), version 1.
-- Ported from the Supabase/Postgres design (branch supabase-backend).
--
-- Conventions
--   ids        TEXT UUIDs ({{UUID}} default)
--   times      "TIMESTAMP TEXT": UTC ISO-8601 with milliseconds, e.g. 2026-10-12T04:30:00.000Z.
--              Always written by the app via Date#toISOString(), so they compare correctly as text.
--   dates      "DATE TEXT": YYYY-MM-DD (IST calendar dates)
--   booleans   BOOLEAN: 0/1
--   JSON       "JSON TEXT"
--   money      INTEGER paise
-- The declared types drive encoding/decoding in server/db/registry.ts.

PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------------ accounts (replaces Supabase Auth)
CREATE TABLE users (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,                        -- null until an invite is accepted
  totp_secret TEXT,                          -- encrypted with the app secret
  totp_pending_secret TEXT,                  -- during enrolment, encrypted
  totp_enabled BOOLEAN NOT NULL DEFAULT 0,
  banned BOOLEAN NOT NULL DEFAULT 0,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,                       -- SHA-256 of the cookie token
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  aal TEXT NOT NULL DEFAULT 'aal1' CHECK (aal IN ('aal1', 'aal2')),
  mfa_failures INTEGER NOT NULL DEFAULT 0,
  ip TEXT,
  user_agent TEXT,
  expires_at TIMESTAMP TEXT NOT NULL,
  last_seen_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP TEXT NOT NULL,
  used_at TIMESTAMP TEXT,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

-- ------------------------------------------------------------------ staff
CREATE TABLE staff_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 1 AND 80),
  email TEXT NOT NULL,
  phone TEXT,
  active BOOLEAN NOT NULL DEFAULT 1,
  last_seen_at TIMESTAMP TEXT,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE user_roles (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  user_id TEXT NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'staff')),
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

-- ------------------------------------------------------------------ settings & policies
CREATE TABLE settings (
  key TEXT PRIMARY KEY CHECK (key IN ('business', 'booking_rules', 'notifications', 'templates', 'retention', 'security')),
  value JSON TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(value)),
  updated_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  id TEXT NOT NULL UNIQUE DEFAULT {{UUID}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE policy_versions (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  kind TEXT NOT NULL CHECK (kind IN ('privacy', 'terms', 'cancellation')),
  locale TEXT NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'te', 'hi')),
  version INTEGER NOT NULL CHECK (version > 0),
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  published_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  published_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  UNIQUE (kind, locale, version)
);

-- ------------------------------------------------------------------ fleet
CREATE TABLE cars (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 80 AND slug NOT GLOB '*[^a-z0-9-]*' AND slug NOT GLOB '-*' AND slug NOT GLOB '*-' AND slug NOT GLOB '*--*'),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 2 AND 80),
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  variant TEXT NOT NULL DEFAULT '',
  body_type TEXT NOT NULL CHECK (body_type IN ('hatchback', 'compact_suv', 'crossover', 'suv', 'micro_suv', 'mpv', 'premium_mpv')),
  category TEXT NOT NULL CHECK (category IN ('hatch', 'suv', 'mpv')),
  seats INTEGER NOT NULL CHECK (seats BETWEEN 2 AND 12),
  fuel TEXT NOT NULL CHECK (fuel IN ('petrol', 'diesel', 'cng', 'electric')),
  transmission TEXT NOT NULL DEFAULT 'manual' CHECK (transmission IN ('manual', 'automatic')),
  colour TEXT NOT NULL DEFAULT '',
  year INTEGER CHECK (year IS NULL OR year BETWEEN 1990 AND 2100),
  -- Admin only, never public. Upper-case, no spaces, e.g. TS09EA1234.
  registration_number TEXT UNIQUE CHECK (registration_number IS NULL OR (length(registration_number) BETWEEN 6 AND 12 AND registration_number NOT GLOB '*[^A-Z0-9]*')),
  badge TEXT CHECK (badge IS NULL OR length(badge) BETWEEN 1 AND 24),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 500),
  price_12h_paise INTEGER NOT NULL CHECK (price_12h_paise > 0),
  price_24h_paise INTEGER NOT NULL CHECK (price_24h_paise > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  cover_photo_id TEXT REFERENCES car_photos (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX cars_status_sort_idx ON cars (status, sort_order);

CREATE TABLE car_photos (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  car_id TEXT NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  -- Path of the full-size WebP in the car-photos store; -800/-400 variants sit beside it.
  storage_path TEXT NOT NULL UNIQUE,
  alt_text TEXT NOT NULL CHECK (length(alt_text) BETWEEN 3 AND 200),
  sort_order INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX car_photos_car_idx ON car_photos (car_id, sort_order);

CREATE TABLE car_price_history (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  car_id TEXT NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  price_12h_paise INTEGER NOT NULL,
  price_24h_paise INTEGER NOT NULL,
  changed_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  changed_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX car_price_history_car_idx ON car_price_history (car_id, changed_at);

CREATE TABLE maintenance_windows (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  car_id TEXT NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  starts_at TIMESTAMP TEXT NOT NULL,
  ends_at TIMESTAMP TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('service', 'repair', 'accident', 'other')),
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  CHECK (ends_at > starts_at)
);
CREATE INDEX maintenance_windows_car_idx ON maintenance_windows (car_id, starts_at, ends_at);

-- ------------------------------------------------------------------ customers
CREATE TABLE customers (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 2 AND 80),
  -- One customer per mobile number (CUS-01). Null only after erasure (DP-05).
  phone TEXT UNIQUE CHECK (phone IS NULL OR phone GLOB '+91[6-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'),
  email TEXT CHECK (email IS NULL OR email LIKE '%_@_%._%'),
  dl_number TEXT CHECK (dl_number IS NULL OR (length(dl_number) BETWEEN 6 AND 20 AND dl_number NOT GLOB '*[^A-Z0-9]*')),
  dl_expiry DATE TEXT,
  -- Only the last 4 digits; the full Aadhaar number is never stored (AAD-03, AC-03).
  aadhaar_last4 TEXT CHECK (aadhaar_last4 IS NULL OR aadhaar_last4 GLOB '[0-9][0-9][0-9][0-9]'),
  identity_verified BOOLEAN NOT NULL DEFAULT 0,
  identity_method TEXT CHECK (identity_method IS NULL OR identity_method IN ('aadhaar_qr', 'aadhaar_original_seen', 'passport', 'voter_id', 'other', 'digilocker')),
  identity_verified_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  identity_verified_at TIMESTAMP TEXT,
  blocked BOOLEAN NOT NULL DEFAULT 0,
  block_reason TEXT,
  notes TEXT NOT NULL DEFAULT '',
  erased_at TIMESTAMP TEXT,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  CHECK (NOT blocked OR coalesce(block_reason, '') <> ''),
  CHECK (phone IS NOT NULL OR erased_at IS NOT NULL)
);
CREATE INDEX customers_name_idx ON customers (full_name COLLATE NOCASE);
CREATE INDEX customers_dl_idx ON customers (dl_number);

-- ------------------------------------------------------------------ bookings
CREATE TABLE booking_code_counters (
  day DATE TEXT PRIMARY KEY,
  last INTEGER NOT NULL
);

CREATE TABLE consents (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  customer_id TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings (id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('booking', 'aadhaar_verification', 'document_upload')),
  notice_version TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'website' CHECK (channel IN ('website', 'admin', 'customer_link')),
  granted_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  ip TEXT,
  user_agent TEXT,
  recorded_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  withdrawn_at TIMESTAMP TEXT,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX consents_customer_idx ON consents (customer_id);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  booking_code TEXT NOT NULL UNIQUE CHECK (booking_code GLOB 'KSR-[0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9]*'),
  customer_id TEXT NOT NULL REFERENCES customers (id) ON DELETE RESTRICT,
  car_id TEXT NOT NULL REFERENCES cars (id) ON DELETE RESTRICT,
  package TEXT NOT NULL CHECK (package IN ('12h', '24h', 'custom')),
  custom_hours INTEGER CHECK (custom_hours IS NULL OR custom_hours BETWEEN 1 AND 720),
  pickup_at TIMESTAMP TEXT NOT NULL,
  return_due_at TIMESTAMP TEXT NOT NULL,
  -- return_due_at + turnaround buffer. The car is held over [pickup_at, hold_until)
  -- while the booking is Confirmed or Active.
  hold_until TIMESTAMP TEXT NOT NULL,
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  actual_pickup_at TIMESTAMP TEXT,
  actual_return_at TIMESTAMP TEXT,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'rejected', 'cancelled', 'no_show', 'active', 'returned', 'closed')),
  source TEXT NOT NULL DEFAULT 'website' CHECK (source IN ('website', 'phone', 'walk_in', 'whatsapp')),
  -- Price shown to the customer; never changes when car prices change (8.3).
  price_quoted_paise INTEGER NOT NULL CHECK (price_quoted_paise >= 0),
  extra_charges_paise INTEGER NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0 CHECK (discount_paise >= 0),
  deposit_paise INTEGER NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  deposit_received_paise INTEGER NOT NULL DEFAULT 0,
  deposit_refunded_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL DEFAULT 0,
  paid_paise INTEGER NOT NULL DEFAULT 0,
  refunded_paise INTEGER NOT NULL DEFAULT 0,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'part_paid', 'paid', 'refunded')),
  flags JSON TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(flags)),
  cancel_reason TEXT,
  admin_notes TEXT NOT NULL DEFAULT '',
  -- Open fine, claim or dispute: documents are skipped by the retention purge (10.4).
  on_hold BOOLEAN NOT NULL DEFAULT 0,
  hold_reason TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  consent_id TEXT REFERENCES consents (id) ON DELETE SET NULL,
  ended_at TIMESTAMP TEXT,
  overdue_notified_at TIMESTAMP TEXT,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  CHECK (return_due_at > pickup_at),
  CHECK (hold_until >= return_due_at),
  CHECK (package <> 'custom' OR custom_hours IS NOT NULL)
);
CREATE INDEX bookings_status_pickup_idx ON bookings (status, pickup_at);
CREATE INDEX bookings_pickup_idx ON bookings (pickup_at);
CREATE INDEX bookings_return_idx ON bookings (return_due_at);
CREATE INDEX bookings_customer_idx ON bookings (customer_id);
CREATE INDEX bookings_car_idx ON bookings (car_id, pickup_at);

-- No overlapping Confirmed/Active bookings on one car (8.3). Last line of defence; the
-- booking functions check first and give a friendly message naming the clash.
CREATE TRIGGER bookings_no_overlap_insert BEFORE INSERT ON bookings
WHEN NEW.status IN ('confirmed', 'active') AND EXISTS (
  SELECT 1 FROM bookings o
   WHERE o.car_id = NEW.car_id AND o.id <> NEW.id AND o.status IN ('confirmed', 'active')
     AND o.pickup_at < NEW.hold_until AND NEW.pickup_at < o.hold_until)
BEGIN
  SELECT RAISE(ABORT, 'bookings_no_overlap: This car is already booked at that time.');
END;

CREATE TRIGGER bookings_no_overlap_update BEFORE UPDATE OF status, car_id, pickup_at, hold_until ON bookings
WHEN NEW.status IN ('confirmed', 'active') AND EXISTS (
  SELECT 1 FROM bookings o
   WHERE o.car_id = NEW.car_id AND o.id <> NEW.id AND o.status IN ('confirmed', 'active')
     AND o.pickup_at < NEW.hold_until AND NEW.pickup_at < o.hold_until)
BEGIN
  SELECT RAISE(ABORT, 'bookings_no_overlap: This car is already booked at that time.');
END;

CREATE TABLE booking_events (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'status' CHECK (kind IN ('status', 'edit', 'handover', 'payment', 'charge', 'note', 'override')),
  from_status TEXT,
  to_status TEXT,
  actor_id TEXT REFERENCES users (id) ON DELETE SET NULL,
  note TEXT,
  at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX booking_events_booking_idx ON booking_events (booking_id, at);

-- ------------------------------------------------------------------ documents
CREATE TABLE document_types (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 2 AND 41 AND key NOT GLOB '*[^a-z0-9_]*' AND key GLOB '[a-z]*'),
  label TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('customer', 'booking', 'car', 'business')),
  is_kyc BOOLEAN NOT NULL DEFAULT 0,
  tracks_expiry BOOLEAN NOT NULL DEFAULT 0,
  expiry_required BOOLEAN NOT NULL DEFAULT 0,
  blocks_booking_when_expired BOOLEAN NOT NULL DEFAULT 0,
  required_for_pickup BOOLEAN NOT NULL DEFAULT 0,
  view_roles JSON TEXT NOT NULL DEFAULT '["owner","manager"]' CHECK (json_valid(view_roles)),
  download_roles JSON TEXT NOT NULL DEFAULT '["owner","manager"]' CHECK (json_valid(download_roles)),
  -- Days to keep after the retention basis event; null = no automatic erasure.
  retention_days INTEGER CHECK (retention_days IS NULL OR retention_days >= 0),
  retention_basis TEXT NOT NULL DEFAULT 'none' CHECK (retention_basis IN ('none', 'booking_end', 'customer_last_booking_end')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT 1,
  id TEXT NOT NULL UNIQUE DEFAULT {{UUID}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE upload_links (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  customer_id TEXT NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMP TEXT NOT NULL,
  used_at TIMESTAMP TEXT,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  owner_type TEXT NOT NULL CHECK (owner_type IN ('customer', 'booking', 'car', 'business')),
  customer_id TEXT REFERENCES customers (id) ON DELETE CASCADE,
  booking_id TEXT REFERENCES bookings (id) ON DELETE CASCADE,
  -- restrict: deleting a car must not silently drop document rows whose files stay on disk.
  car_id TEXT REFERENCES cars (id) ON DELETE RESTRICT,
  owner_id TEXT GENERATED ALWAYS AS (
    CASE owner_type WHEN 'customer' THEN customer_id WHEN 'booking' THEN booking_id WHEN 'car' THEN car_id END
  ) STORED,
  doc_type TEXT NOT NULL REFERENCES document_types (key),
  storage_path TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 10485760),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  doc_number_masked TEXT CHECK (doc_number_masked IS NULL OR length(doc_number_masked) <= 40),
  issue_date DATE TEXT,
  expiry_date DATE TEXT,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired', 'superseded')),
  verification_method TEXT CHECK (verification_method IS NULL OR verification_method IN ('original_seen', 'qr_scan', 'online_portal')),
  verified_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  verified_at TIMESTAMP TEXT,
  reject_reason TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  replaces_id TEXT REFERENCES documents (id) ON DELETE SET NULL,
  -- DOC-10: the uploader confirmed only the last 4 Aadhaar digits are visible.
  aadhaar_masked_confirmed BOOLEAN NOT NULL DEFAULT 0,
  uploaded_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  uploaded_via TEXT NOT NULL DEFAULT 'admin' CHECK (uploaded_via IN ('admin', 'customer_link')),
  upload_link_id TEXT REFERENCES upload_links (id) ON DELETE SET NULL,
  legal_hold BOOLEAN NOT NULL DEFAULT 0,
  hold_reason TEXT,
  deleted_at TIMESTAMP TEXT,
  deleted_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  delete_reason TEXT,
  retain_until TIMESTAMP TEXT,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  CHECK (
    (owner_type = 'customer' AND customer_id IS NOT NULL AND car_id IS NULL)
    OR (owner_type = 'booking' AND booking_id IS NOT NULL AND car_id IS NULL)
    OR (owner_type = 'car' AND car_id IS NOT NULL AND customer_id IS NULL AND booking_id IS NULL)
    OR (owner_type = 'business' AND car_id IS NULL AND customer_id IS NULL AND booking_id IS NULL)
  ),
  CHECK (status <> 'rejected' OR coalesce(reject_reason, '') <> ''),
  CHECK (deleted_at IS NULL OR coalesce(delete_reason, '') <> '')
);
CREATE INDEX documents_customer_idx ON documents (customer_id) WHERE customer_id IS NOT NULL;
CREATE INDEX documents_booking_idx ON documents (booking_id) WHERE booking_id IS NOT NULL;
CREATE INDEX documents_car_idx ON documents (car_id) WHERE car_id IS NOT NULL;
CREATE INDEX documents_owner_idx ON documents (owner_type, owner_id);
CREATE INDEX documents_type_idx ON documents (doc_type, status);
CREATE INDEX documents_expiry_idx ON documents (expiry_date) WHERE deleted_at IS NULL AND expiry_date IS NOT NULL;
CREATE INDEX documents_sha_idx ON documents (sha256);
CREATE INDEX documents_retain_idx ON documents (retain_until) WHERE retain_until IS NOT NULL;

-- ------------------------------------------------------------------ handover, charges, payments
CREATE TABLE handover_records (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pickup', 'return')),
  odometer_km INTEGER NOT NULL CHECK (odometer_km >= 0),
  fuel_level TEXT NOT NULL CHECK (fuel_level IN ('empty', 'quarter', 'half', 'three_quarter', 'full')),
  checklist JSON TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(checklist)),
  damage_notes TEXT NOT NULL DEFAULT '',
  signature_document_id TEXT REFERENCES documents (id) ON DELETE SET NULL,
  recorded_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  recorded_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  UNIQUE (booking_id, kind)
);

CREATE TABLE booking_charges (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('late', 'fuel', 'damage', 'cleaning', 'challan', 'extension', 'other')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  note TEXT NOT NULL DEFAULT '',
  document_id TEXT REFERENCES documents (id) ON DELETE SET NULL,
  added_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX booking_charges_booking_idx ON booking_charges (booking_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  booking_id TEXT NOT NULL REFERENCES bookings (id) ON DELETE RESTRICT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  type TEXT NOT NULL CHECK (type IN ('rent', 'deposit', 'extra', 'refund', 'deposit_refund')),
  method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'card', 'bank')),
  reference TEXT,
  note TEXT NOT NULL DEFAULT '',
  receipt_document_id TEXT REFERENCES documents (id) ON DELETE SET NULL,
  received_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  received_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  CHECK (type NOT IN ('refund', 'deposit_refund') OR coalesce(note, '') <> '')
);
CREATE INDEX payments_booking_idx ON payments (booking_id);
CREATE INDEX payments_received_idx ON payments (received_at);

CREATE TABLE service_logs (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  car_id TEXT NOT NULL REFERENCES cars (id) ON DELETE CASCADE,
  service_date DATE TEXT NOT NULL,
  odometer_km INTEGER CHECK (odometer_km IS NULL OR odometer_km >= 0),
  work_done TEXT NOT NULL,
  cost_paise INTEGER NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  garage TEXT NOT NULL DEFAULT '',
  invoice_document_id TEXT REFERENCES documents (id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX service_logs_car_idx ON service_logs (car_id, service_date);

-- ------------------------------------------------------------------ privacy requests
CREATE TABLE data_requests (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  customer_id TEXT REFERENCES customers (id) ON DELETE SET NULL,
  requester_name TEXT NOT NULL,
  requester_contact TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'correction', 'erasure', 'grievance', 'consent_withdrawal')),
  details TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'done', 'refused')),
  received_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  due_at TIMESTAMP TEXT,
  resolved_at TIMESTAMP TEXT,
  resolution TEXT,
  handled_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

-- ------------------------------------------------------------------ audit & system
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before JSON TEXT,
  after JSON TEXT,
  ip TEXT,
  user_agent TEXT,
  at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX audit_logs_at_idx ON audit_logs (at);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, at);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, at);

-- Flags set inside a transaction by trusted jobs (e.g. the retention purge of old audit entries).
CREATE TABLE _flags (key TEXT PRIMARY KEY);

-- Audit entries are read-only (AUD-03). Only the retention purge may delete old entries.
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_immutable: Audit log entries cannot be changed or deleted.');
END;
CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs
WHEN NOT EXISTS (SELECT 1 FROM _flags WHERE key = 'audit_purge')
BEGIN
  SELECT RAISE(ABORT, 'audit_immutable: Audit log entries cannot be changed or deleted.');
END;

CREATE TABLE submission_attempts (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'lookup', 'upload', 'mfa', 'reset')),
  phone TEXT,
  ip_hash TEXT,
  at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX submission_attempts_idx ON submission_attempts (kind, at);

CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  user_id TEXT NOT NULL,
  succeeded BOOLEAN NOT NULL,
  at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX login_attempts_user_idx ON login_attempts (user_id, at);

CREATE TABLE account_locks (
  user_id TEXT PRIMARY KEY,
  locked_until TIMESTAMP TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE DEFAULT {{UUID}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  kind TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'whatsapp', 'sms')),
  recipients JSON TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recipients)),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  payload JSON TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMP TEXT,
  sent_at TIMESTAMP TEXT,
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}}
);
CREATE INDEX outbox_pending_idx ON outbox (status, created_at);

CREATE TABLE document_reminders (
  id TEXT PRIMARY KEY DEFAULT {{UUID}},
  document_id TEXT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  days_before INTEGER NOT NULL,
  sent_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  created_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  updated_at TIMESTAMP TEXT NOT NULL DEFAULT {{NOW}},
  UNIQUE (document_id, days_before)
);

CREATE TABLE job_runs (
  name TEXT PRIMARY KEY,
  last_run_at TIMESTAMP TEXT NOT NULL,
  last_result JSON TEXT
);

-- ------------------------------------------------------------------ fleet triggers
-- Up to 8 photos per car (FLT-05).
CREATE TRIGGER car_photos_limit BEFORE INSERT ON car_photos
WHEN (SELECT count(*) FROM car_photos WHERE car_id = NEW.car_id) >= 8
BEGIN
  SELECT RAISE(ABORT, 'photo_limit: A car can have up to 8 photos. Remove one first.');
END;

-- The cover photo must be one of the car's photos.
CREATE TRIGGER cars_cover_photo_check BEFORE UPDATE OF cover_photo_id ON cars
WHEN NEW.cover_photo_id IS NOT NULL
 AND NOT EXISTS (SELECT 1 FROM car_photos WHERE id = NEW.cover_photo_id AND car_id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'invalid: The cover photo must be one of this car''s photos.');
END;

-- ------------------------------------------------------------------ public views (9.2)
-- Visitors read only these: no registration numbers, internal notes or personal data.
CREATE VIEW public_cars AS
SELECT
  c.id, c.slug, c.display_name, c.brand, c.model, c.body_type, c.category, c.seats, c.fuel, c.transmission,
  c.badge, c.description, c.price_12h_paise, c.price_24h_paise, c.sort_order,
  coalesce((
    SELECT json_group_array(json_object('id', p.id, 'path', p.storage_path, 'alt', p.alt_text, 'width', p.width, 'height', p.height)
             ORDER BY (p.id = c.cover_photo_id) DESC, p.sort_order, p.created_at)
      FROM car_photos p WHERE p.car_id = c.id
  ), '[]') AS photos
FROM cars c
WHERE c.status = 'active';

CREATE VIEW public_settings AS
SELECT s.key, s.value FROM settings s WHERE s.key IN ('business', 'booking_rules');

CREATE VIEW public_policies AS
SELECT p.kind, p.locale, p.version, p.title, p.body_md, p.published_at,
       p.kind || '-' || p.locale || '-v' || p.version AS label
FROM policy_versions p
WHERE p.version = (SELECT max(q.version) FROM policy_versions q WHERE q.kind = p.kind AND q.locale = p.locale);
