# KSR Self Drive Cars

Customer website, booking flow and admin module for KSR Self Drive Cars, built from
[`Docs/KSR_Self_Drive_Cars_PRD.md`](Docs/KSR_Self_Drive_Cars_PRD.md) and the design canvas
[`Docs/KSR Self Drive Cars.html`](Docs/KSR%20Self%20Drive%20Cars.html).

| Part | What it is |
|---|---|
| Public site (`/`) | Hero, fleet with 12 hr / 24 hr prices and filters, how it works, booking modal (desktop) / full-screen sheet (mobile), car pages, policies, booking lookup, customer document upload link |
| Admin (`/admin`) | Dashboard, bookings, handover and return, calendar, fleet, customers, document centre, payments, reports, privacy requests, settings, staff, audit log |
| Backend (`supabase/`) | Postgres schema with row-level security, booking rules in SQL, storage buckets, edge functions, scheduled jobs |

## Stack

React 19 + TypeScript + Vite + Tailwind CSS 4 (the Lovable stack), TanStack Query, React Router 7,
and Supabase (Postgres, Auth, Storage, Edge Functions, pg_cron). Email alerts use Resend.

## Project layout

```
src/
  site/                 public website (pages, booking form, fleet)
  admin/                admin module, loaded as a separate bundle
    auth/               sign-in, two-step verification, role guards, session limits
    components/documents/  shared document list, upload, viewer, verification, redaction
    pages/<area>/       one folder per admin screen
  components/ui         UI kit (buttons, fields, dialogs, tables, status pills)
  components/brand      KSR plate logo, price plates, car silhouettes
  lib/                  Supabase helpers, errors, images (resize/HEIC/EXIF strip), analytics, CSV
  types/db.ts           row types for the database tables and views
supabase/
  migrations/           schema, RLS, business rules, storage, reference data, scheduled jobs
  functions/            edge functions + _shared helpers
  functions/_shared/domain/  validation and booking rules shared by the browser and edge functions
tests/
  db/                   acceptance tests against the real migrations (PGlite)
  unit/                 shared domain rules
```

## Run locally

```bash
npm install
cp .env.example .env.local   # fill in your Supabase URL and publishable key
npm run dev                  # http://localhost:8080
```

Without Supabase settings the public site still runs, showing the 11 cars bundled in
`src/site/demoData.ts`, and booking requests are not sent. The admin needs a Supabase project.

### Checks

```bash
npm run typecheck   # tsc -b
npm run lint        # eslint
npm test            # unit tests + database acceptance tests (PGlite, no Docker needed)
npm run build       # writes sitemap.xml/robots.txt, type-checks and builds
npm run check:queries   # every column the app queries exists in the migrated schema
npx --yes deno@2 check supabase/functions/*/index.ts   # edge functions
```

`tests/db` runs every migration in PGlite (Postgres compiled to WebAssembly) with small
stand-ins for Supabase's `auth`, `storage` and roles, then checks the acceptance criteria from
PRD Section 14: clash blocking (AC-04), expired papers (AC-05), pickup gate (AC-09), staff scope
(AC-10), price snapshot (AC-11), retention purge (AC-12), no full-Aadhaar column (AC-03), plus
two-step enforcement, the immutable audit log, login lockout and rate limits.

## Set up a Supabase project

Use the Mumbai region (`ap-south-1`) for data residency (Section 12).

1. **Database.** Link the project and push the migrations:
   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npx supabase db push
   ```
   This creates the schema, row-level security, storage buckets, settings, document types,
   draft policies and the current fleet of 11 cars.

2. **Edge functions and secrets.**
   ```bash
   cp supabase/functions/.env.example supabase/functions/.env   # fill in the values
   npx supabase secrets set --env-file supabase/functions/.env
   npx supabase functions deploy --no-verify-jwt
   ```

3. **Auth** (Dashboard › Authentication):
   - Turn off public sign-ups (ADM-02).
   - Enable TOTP multi-factor authentication (ADM-03).
   - Sessions: time-box to 12 hours where your plan allows (ADM-05). The app also signs people
     out after 12 hours, and after 30 minutes of inactivity on screens that show documents.
   - Hooks › *Password verification attempt*: Postgres function
     `public.hook_password_verification_attempt` (5 failed logins lock an account for 15 minutes
     and email the Owner, ADM-06; logins are audited).
   - URL configuration: Site URL = your site; add `<site>/admin/reset-password` to redirect URLs.
   - SMTP: set a custom SMTP sender so invite and reset emails come from your domain.

4. **Scheduled jobs.** The last migration schedules jobs with `pg_cron` when it is available.
   They call edge functions through `pg_net` using two Vault secrets. Run once in the SQL editor:
   ```sql
   select vault.create_secret('https://<project-ref>.supabase.co', 'ksr_project_url');
   select vault.create_secret('<same value as CRON_SECRET>', 'ksr_cron_secret');
   ```
   | Job | When (IST) | Does |
   |---|---|---|
   | `ksr-notify` | every minute | sends queued emails (new requests, expiry, overdue, lockout, uploads) |
   | `ksr-document-expiry` | 08:00 daily | marks expired documents, queues 30/15/7/1/0-day reminders |
   | `ksr-overdue` | every 15 min | queues overdue-return alerts |
   | `ksr-retention` | 03:00 daily | sets retention dates, then erases due files and stale records |

5. **First Owner.** Create the user (Authentication › Users › Add user), then in the SQL editor:
   ```sql
   select public.bootstrap_owner('owner@example.com', 'Owner name');
   ```
   Sign in at `/admin/login`, set up two-step verification, then invite staff from `/admin/staff`.

6. **Business details.** In `/admin/settings` set the phone number, WhatsApp, pickup address,
   opening hours and grievance contact. "Call to book" stays hidden until a phone number is set.

7. **Front end env.** Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SITE_URL`
   and optionally `VITE_PLAUSIBLE_DOMAIN` where you host the site.

## How the important rules are enforced

| Rule | Where |
|---|---|
| Roles (Owner / Manager / Staff) | `user_roles` + `my_role()`; RLS on every table (`20261011000500_rls_and_grants.sql`) |
| Two-step for Owner and Manager | `my_role()` returns no role unless the JWT is `aal2`, so the database returns no data |
| Staff see today ± 1 day; customers and KYC only for today | `staff_can_see_booking`, `customer_has_booking_today` in RLS |
| No double bookings | exclusion constraint `bookings_no_overlap` + `_car_clashes()` (includes turnaround buffer and maintenance) |
| Expired insurance / PUC / permit blocks confirmation | `booking_transition()`; Owner override with reason, audited |
| Pickup gate (verified licence valid past return, identity verified) | `pickup_gate_problems()` / `record_handover()` |
| Price snapshot | `bookings.price_quoted_paise`, price history trigger on `cars` |
| Private documents, 5-minute signed links, every view logged | private `documents` bucket with no policies; `document-view-url` |
| No full Aadhaar anywhere | no column; uploads require "masked" confirmation; in-browser redaction tool |
| Audit log read-only | `audit_logs_immutable` trigger; Owner-only select |
| Retention and holds | `compute_document_retention()`, `_retention_due()`, `retention-purge` |

## Decisions and deviations from the PRD

- **Document uploads go through `document-upload`** (one request) rather than a signed upload
  URL: the function checks the role, sniffs the real file type, verifies the SHA-256 and only then
  stores the file, so nothing unchecked ever lands in the bucket.
- **Expiry marking, reminders and overdue alerts are SQL jobs** that queue emails in an `outbox`
  table; the `notify` function sends them. `expiry-reminders` from 9.3 is therefore SQL, not an
  edge function.
- **Availability and booking lookup are SQL functions** (`public_busy_windows`, `lookup_booking`)
  rather than edge functions; both return no personal data and lookup is rate-limited.
- **Walk-in bookings** created by staff skip the minimum-notice and 30-minute-step rules but keep
  opening hours and the booking window.
- **"Victoris CNG"** is seeded with Maruti's spelling (gap G8, open question Q14); the Owner can
  rename it.
- **Using the deposit for an unpaid balance** is recorded as two ledger entries: a deposit
  refund marked "Kept for the unpaid balance" and a matching rent/extra payment, because the
  payment types have no "apply deposit" entry.
- **Calendar drag-to-reschedule (CAL-03)** works with a mouse or pen; on touch screens the grid
  scrolls and the time is changed from the booking page. Moving a booking to another car resets
  its price to that car's current package price (the confirm dialog says so).
- **Exports:** the bookings CSV includes customer mobile numbers for the Owner only; no export
  ever includes document numbers or KYC files (RPT-06).
- **Telugu and Hindi notices (DP-07):** the policy editor and public pages support `te` and `hi`
  versions; the translated text itself must be written and reviewed by people.

## Not built (needs a provider account or an owner decision)

These are P2 items that depend on third-party contracts, plus open questions from Section 15:
online advance payment through a payment gateway (PAY-04), GST invoices (PAY-05, Q11),
DigiLocker verification (AAD-05), OTP on the booking form (BK-15), automated WhatsApp/SMS
(Section 11; the `notify` function has an extension point per channel), offline handover queue
(HND-05), coupons, multi-day pricing (Q8) and multiple pickup locations.

Legal text in the draft policies, the breach plan in
[`Docs/Breach_Response_Plan.md`](Docs/Breach_Response_Plan.md), and every retention period are
starting points for the Owner and a legal/CA adviser to confirm before launch (Section 10).
