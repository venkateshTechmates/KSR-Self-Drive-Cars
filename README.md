# KSR Self Drive Cars

Customer website, booking flow and admin module for KSR Self Drive Cars, built from
[`Docs/KSR_Self_Drive_Cars_PRD.md`](Docs/KSR_Self_Drive_Cars_PRD.md) and the design canvas
[`Docs/KSR Self Drive Cars.html`](Docs/KSR%20Self%20Drive%20Cars.html).

**One service, one database file.** A single Node process serves the website, the admin, the
API and uploaded files, and runs the scheduled jobs. All data lives in SQLite plus a files
folder under `DATA_DIR`. Deploy it as one Docker container with a persistent disk; see
[`Docs/DEPLOY.md`](Docs/DEPLOY.md) for Fly.io (Mumbai), Render and Railway.

| Part | What it is |
|---|---|
| Public site (`/`) | Hero, fleet with 12 hr / 24 hr prices and filters, how it works, booking modal (desktop) / full-screen sheet (mobile), car pages, policies, booking lookup, customer document upload link |
| Admin (`/admin`) | Dashboard, bookings, handover and return, calendar, fleet, customers, document centre, payments, reports, privacy requests, settings, staff, audit log |
| Server (`server/`) | Hono on Node 24 with the built-in `node:sqlite`; sign-in with two-step verification; business rules; private file storage; email; scheduled jobs and daily backups |
| Android app (`android/`) | One app for customers and staff: the website in a native shell with camera, share sheet, back button and offline page ([`Docs/ANDROID.md`](Docs/ANDROID.md)) |
| React Native app (`mobile/`) | Native screens (Expo) for booking, booking status and the staff dashboard, bookings and payments, plus the full web admin inside ([`mobile/README.md`](mobile/README.md)) |

> The previous Supabase version is kept on the git branch `supabase-backend`.

## Stack

React 19 + TypeScript + Vite + Tailwind CSS 4, TanStack Query and React Router 7 in the browser;
Node 24 (runs the TypeScript server directly), [Hono](https://hono.dev), `node:sqlite`,
Nodemailer (any SMTP provider) and `qrcode` on the server. No native modules, so it builds the
same on Windows, macOS and Linux.

## Project layout

```
src/                      the web app (public site + admin, admin is a separate bundle)
  integrations/api/       browser client for the server: api.from(...).select()..., api.rpc(), auth
server/
  index.ts                start: open/migrate the database, first Owner, scheduler, HTTP server
  app.ts                  routes, security headers, static web app, sitemap/robots
  db/                     schema.sql, seed.sql, migrations, typed read/write helpers
  auth/                   passwords (scrypt), sessions, TOTP two-step, lockout, invite/reset links
  access/                 who can see what (the permission matrix, PRD 2.2)
  query/                  the data API behind api.from(...): parser, policies, engine
  rpc/                    business functions (booking, documents, customers, account)
  routes/                 /api/fn/* (booking requests, uploads, staff…), files, data API
  jobs/                   scheduled jobs: emails, expiry reminders, overdue alerts, retention, backups
  demo.ts                 demo data (npm run seed-demo, and the end-to-end tests)
shared/                   validation, time (IST), money and booking rules used by browser and server
tests/server/             server tests on a fresh in-memory database (acceptance criteria AC-01…AC-13)
tests/unit/               shared domain rules
e2e/                      Playwright end-to-end tests against the built app with demo data
android/                  the Android app (Capacitor): native project, icons, MainActivity
app-shell/                the offline page bundled inside the Android app
mobile/                   the React Native app (Expo): src/app screens, src/lib API client, reuses shared/
```

## Run locally

```bash
npm install
npm run dev
```

This starts the server on :3000 and the website on http://localhost:8080 (Vite proxies `/api`
and `/media` to the server). Data goes to `./data` (git-ignored).

Create the first Owner (there is no public sign-up, ADM-02):

```bash
npm run create-owner -- --email you@example.com --name "Your name"
```

It prints a one-time link to choose a password. Sign in at http://localhost:8080/admin. Owner
and Manager accounts set up two-step verification with an authenticator app on first sign-in.
Without SMTP settings, emails (booking alerts, invites, resets) are written to the server log.

Production mode on your machine: `npm run build` then `npm start` (serves everything on :3000).

To try the admin with data (local databases only), add a demo Manager, a Staff member,
customers and bookings in every state:

```bash
npm run seed-demo -- --password "choose-a-password"
```

It prints the booking codes and the two sign-in emails (`manager@ksr.test`, `staff@ksr.test`).

### Android app

```bash
npm run android:apk -- --url http://<this computer's IPv4>:3000   # test APK for a phone on the same Wi-Fi
npm run android:usb                                               # or install over USB
```

The APK lands in `release/`. Publishing on Google Play (signed `.aab` with the live address) is
in [`Docs/ANDROID.md`](Docs/ANDROID.md).

### Checks

```bash
npm run typecheck       # web app, server, unit and end-to-end tests
npm run lint
npm test                # 161 tests: domain rules, booking logic, documents, routes, data API, sign-in, demo data, Android app helpers
npm run check:queries   # every table/column the web app queries exists in the schema
npm run test:e2e        # builds, then 49 Playwright tests in Chrome (desktop and phone)
```

The end-to-end tests (`e2e/`) start the built app in production mode on port 8091 with a
fresh database in `node_modules/.tmp/e2e-data`, seeded with the demo data plus an Owner,
then sign in as each role (the Owner sets up two-step verification in the test). They cover
the public site, a customer booking that reaches the admin, clashes and alternatives,
confirm/reject, expired papers and the Owner's override, the pickup gate and handover with
a signature, payments and closing, prices that reach the website, signed document links,
Staff's limited view, inviting staff, settings and the audit log. They use the installed
Google Chrome; elsewhere run `npx playwright install chromium` and set `PW_CHANNEL=chromium`.
Report: `npx playwright show-report node_modules/.tmp/e2e-report`.

## Configuration

Copy `.env.example` to `.env` for local overrides. In production set at least `APP_SECRET`,
`RATE_LIMIT_SALT`, `SITE_URL` and the `SMTP_*` settings; `OWNER_EMAIL`/`OWNER_PASSWORD` create
the first Owner on the first start. Business details, opening hours, booking rules, policies,
message templates, notification lists, document types and retention periods are edited in
**Admin › Settings** (they are data, not configuration).

## How the important rules are enforced

| Rule | Where |
|---|---|
| Roles (Owner / Manager / Staff), enforced on the server | `server/access/` + per-table policies in `server/query/policies.ts`; every business function checks the caller |
| Two-step for Owner and Manager | until the session is verified (aal2), their role has no data access at all |
| Staff see today ± 1 day; customers and KYC only for today | `server/access/scope.ts`, applied to every query, including embedded joins |
| No double bookings | checked in `booking_transition` with a message naming the clash, plus a database trigger as the last line of defence |
| Expired insurance / PUC / permit blocks confirmation | `booking_transition`; Owner override with a reason, audited |
| Pickup gate (verified licence valid past return, identity verified) | `record_handover` / `pickup_gate_problems` |
| Price snapshot | `bookings.price_quoted_paise`; car price history on every change |
| Private documents, 5-minute signed links, every view logged | files outside the web root; `/api/fn/document-view-url` + `/api/files/<signed token>` |
| No full Aadhaar anywhere | no column can hold it; uploads need a "masked" confirmation; in-browser redaction tool |
| Audit log read-only | database triggers refuse updates and deletes; Owner-only reading |
| Login lockout (5 tries / 15 min), session limit 12 h | `server/auth/` |
| Retention and holds | daily job: retention dates, file erasure, stale-record purge |
| Backups | daily `VACUUM INTO DATA_DIR/backups` (newest 14), plus `npm run backup` |

## Decisions and deviations from the PRD

- **SQLite instead of Supabase/Postgres** (owner's choice): one deployable service. Run exactly
  one instance. Row-level security is enforced by the server's policies instead of Postgres.
- **Walk-in bookings** created by staff skip the minimum-notice and 30-minute-step rules but
  keep opening hours and the booking window.
- **Using the deposit for an unpaid balance** is recorded as two ledger entries (a deposit
  refund marked "Kept for the unpaid balance" and a matching rent/extra payment).
- **Calendar drag-to-reschedule (CAL-03)** works with a mouse or pen; on touch screens, change
  the time from the booking page.
- **Exports:** the bookings CSV includes customer mobile numbers for the Owner only; no export
  includes document numbers or KYC files (RPT-06).
- **"Victoris CNG"** is seeded with Maruti's spelling (gap G8, open question Q14).
- **Telugu and Hindi notices (DP-07):** the policy editor and public pages support `te` and `hi`
  versions; the translations must be written and reviewed by people.

## Not built (needs a provider account or an owner decision)

Online advance payment (PAY-04), GST invoices (PAY-05, Q11), DigiLocker (AAD-05), OTP on the
booking form (BK-15), automated WhatsApp/SMS (the email sender has a per-channel extension
point), offline handover queue (HND-05), coupons, multi-day pricing (Q8) and multiple pickup
locations.

The draft policies, [`Docs/Breach_Response_Plan.md`](Docs/Breach_Response_Plan.md) and every
retention period are starting points for the Owner and a legal/CA adviser to confirm before
launch (Section 10).
