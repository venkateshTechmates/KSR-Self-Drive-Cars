# Deploying KSR Self Drive Cars

The whole product is **one Docker image running one Node process**: it serves the website,
the admin, the API and the files, and runs the scheduled jobs (emails, document-expiry
reminders, retention purge, backups). All data lives in one folder, `/data`, which must be
a **persistent volume (disk)**:

| Path in `/data` | What it is |
|---|---|
| `ksr.db` (+ `ksr.db-wal`, `ksr.db-shm`) | The SQLite database |
| `files/documents/…` | Private documents (KYC, vehicle papers, receipts). Only reachable through 5-minute signed links |
| `files/car-photos/…` | Public fleet photos (served at `/media/car-photos/…`) |
| `backups/ksr-YYYY-MM-DD.db` | Daily database copies (02:00 IST, newest 14 kept) |
| `.app-secret` | Only if `APP_SECRET` is not set. Set `APP_SECRET` in production instead |

> **Run exactly one instance.** SQLite is a single file with one writer. Never scale to two
> machines/instances/replicas, and never run the app without the volume: anything written
> outside `/data`, or to a non-persistent disk, is lost on the next deploy.

The guides below cover **Fly.io** (Mumbai, closest to customers in India), **Render**
(Singapore; Render has no India region) and **Railway**. Pick one.

---

## 1. Settings you will need

| Variable | Needed | What it is |
|---|---|---|
| `APP_SECRET` | Yes | Long random secret. Signs document links and encrypts two-step (authenticator) secrets. **Keep it stable**: if it changes, saved two-step setups can't be read any more (everyone sets up their authenticator app again) and open document links stop working. |
| `RATE_LIMIT_SALT` | Yes | Long random secret used to hash IP addresses for rate limits. |
| `SITE_URL` | Yes | The public address, no trailing slash, e.g. `https://www.ksrselfdrive.in`. Used in emails, staff invite links and customer upload links. |
| `VITE_SITE_URL` | Yes (build) | The same address, baked into the website at **build** time (canonical links, sitemap). |
| `VITE_PLAUSIBLE_DOMAIN` | No (build) | Plausible analytics domain. Leave empty to disable. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | Recommended | Email for booking alerts, staff invites, password resets and reminders. Any SMTP provider works (Gmail/Google Workspace with an app password, Zoho Mail `smtp.zoho.in`, Outlook `smtp.office365.com`, Brevo, Mailgun, Amazon SES). Port 587 → `SMTP_SECURE=false`; port 465 → `SMTP_SECURE=true`. Without `SMTP_HOST`, emails are written to the server log instead, queued alerts are marked "skipped", and invite links are handed to the Owner to pass on. |
| `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME` | First start | Creates the Owner account on the first start (only if no Owner exists). Remove `OWNER_PASSWORD` after you have signed in. |
| `CLOUDINARY_URL` | Recommended | `cloudinary://<api key>:<api secret>@<cloud name>` (Cloudinary dashboard → API Keys). Uploaded files go to Cloudinary instead of the disk: customer documents as private (authenticated) files that only the server can fetch, still shown to staff through 5-minute signed links with every view logged; car photos on Cloudinary's CDN. Files already on the disk keep working; `npm run files-to-cloudinary` moves them. The SQLite database and its backups stay on the disk. |
| `CLOUDINARY_FOLDER` | No | Folder in Cloudinary (default `ksr`). Use another one, e.g. `ksr-dev`, for local development. |
| `TWO_STEP` | No | `off` switches two-step verification off for everyone (for a trial period). Remove it to switch back on; **Admin › Settings › Security** then decides which roles need it. Authenticator setups are kept. |

Set by the Docker image (normally leave alone): `NODE_ENV=production`, `DATA_DIR=/data`,
`PORT=8080`. `TRUST_PROXY=true` (the default) is right on all three platforms.

Make a secret (run twice, one for each):

```bash
openssl rand -hex 32
# or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 2. Fly.io (region: Mumbai, `bom`)

Uses [`fly.toml`](../fly.toml): one always-on machine in Mumbai, a volume `ksr_data` mounted
at `/data`, HTTPS forced, health check on `/api/health`.

1. Install `flyctl` and sign in: `fly auth login`.
2. In `fly.toml`, set `app` to your app name and replace `ksr-self-drive-cars.fly.dev` in
   `SITE_URL` and `[build.args] VITE_SITE_URL` with `<your-app>.fly.dev` (or your domain).
3. Create the app and **one** volume in Mumbai:

   ```bash
   fly apps create <your-app>
   fly volumes create ksr_data --app <your-app> --region bom --size 3
   ```

   Fly warns that a single volume has no redundancy; that is expected for SQLite (the daily
   volume snapshots and the in-app backups cover it). Answer yes.
4. Set the secrets:

   ```bash
   fly secrets set --app <your-app> \
     APP_SECRET=$(openssl rand -hex 32) \
     RATE_LIMIT_SALT=$(openssl rand -hex 32) \
     SMTP_HOST=smtp.zoho.in SMTP_PORT=587 SMTP_SECURE=false \
     SMTP_USER=alerts@yourdomain.in SMTP_PASS='…' \
     SMTP_FROM='KSR Self Drive Cars <alerts@yourdomain.in>' \
     OWNER_EMAIL=owner@yourdomain.in OWNER_PASSWORD='a long password' OWNER_NAME='Owner name'
   ```

5. Deploy with a single machine:

   ```bash
   fly deploy --ha=false
   fly status            # exactly one machine, attached to ksr_data
   ```

   If `fly status` ever shows two machines, run `fly scale count 1`.
6. Open `https://<your-app>.fly.dev/admin`, sign in as the Owner, set up two-step
   verification, then remove the password from the secrets: `fly secrets unset OWNER_PASSWORD`.
7. **Custom domain**: `fly certs add www.yourdomain.in` and create the DNS records it prints
   (CNAME for `www`; A/AAAA for the apex). Then change `SITE_URL` and `VITE_SITE_URL` in
   `fly.toml` to `https://www.yourdomain.in` and `fly deploy` again.

Useful: `fly logs` (server log), `fly ssh console` (a shell; `cd /app` first, then e.g.
`npm run create-owner -- --email … --name "…"` or `npm run backup`),
`fly ssh sftp get /data/backups/ksr-2026-10-11.db` (download a backup).

---

## 3. Render (region: Singapore)

Uses [`render.yaml`](../render.yaml): a Docker web service in Singapore with a 5 GB disk at
`/data`, health check on `/api/health`, and generated `APP_SECRET` / `RATE_LIMIT_SALT`.
Disks need a paid instance type (Starter or above); the free type would lose all data on
every deploy.

1. Push this repository to GitHub or GitLab.
2. Render Dashboard → **New → Blueprint** → choose the repository. Render reads `render.yaml`.
3. Fill in the values it asks for:
   - `SITE_URL` and `VITE_SITE_URL`: `https://<service-name>.onrender.com` for now.
   - `SMTP_*`: your email provider (or leave `SMTP_HOST` empty for now).
   - `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME`.
4. **Apply**. The first build takes a few minutes. Render keeps one instance (a service with a
   disk can't run more), and each deploy has a short pause while the old instance stops
   before the new one starts: that's expected.
5. Open `https://<service-name>.onrender.com/admin`, sign in, set up two-step verification,
   then delete `OWNER_PASSWORD` under **Environment**.
6. **Custom domain**: service → **Settings → Custom Domains** → add `www.yourdomain.in` and
   create the CNAME it shows. Then set `SITE_URL` and `VITE_SITE_URL` to the new address and
   run **Manual Deploy → Clear build cache & deploy** (the `VITE_` values are baked in at build).

Useful: **Logs** tab; **Shell** tab (`cd /app`, then `npm run create-owner -- …` or `npm run backup`);
**Disks** tab (daily disk snapshots, restore).

---

## 4. Railway

Uses [`railway.json`](../railway.json): Dockerfile build, one replica, health check on
`/api/health`, restart on failure. The volume is added in the dashboard:

1. **New Project → Deploy from GitHub repo** → choose the repository. Railway builds the
   `Dockerfile`.
2. **Add the volume**: open the service → **Settings → Volumes** (or right-click the service
   → **Attach volume**) → mount path **`/data`**. Without it, all data is lost on every
   deploy. The image runs as root, so the volume is writable as is.
3. **Variables** (service → Variables):
   - `APP_SECRET`, `RATE_LIMIT_SALT`: paste values from `openssl rand -hex 32`.
   - `SITE_URL` and `VITE_SITE_URL`: your Railway domain or custom domain (see step 4).
   - `PORT=8080`.
   - `SMTP_*`, `OWNER_EMAIL`, `OWNER_PASSWORD`, `OWNER_NAME`.

   Railway passes service variables to the Docker build, so `VITE_SITE_URL` reaches the build.
4. **Networking**: **Generate Domain** (`<name>.up.railway.app`, target port 8080), or
   **Custom Domain** → add `www.yourdomain.in` and create the CNAME it shows. Keep
   `SITE_URL` / `VITE_SITE_URL` in step with the domain and redeploy after changing them.
5. Keep **Replicas at 1** (`railway.json` sets `numReplicas: 1`; a service with a volume
   can't run more anyway).
6. Open `/admin`, sign in, set up two-step verification, then delete `OWNER_PASSWORD`.

Useful: **Deploy Logs**; `railway ssh` (a shell; `cd /app`, then e.g. `npm run backup`); the volume's
**Backups** tab where your plan includes volume backups.

---

## 5. After the first deploy

1. Sign in at `/admin` as the Owner and set up two-step verification (required for Owner and
   Manager). Remove `OWNER_PASSWORD` from the platform settings.
2. **Settings**: business name, phone, WhatsApp, address, opening hours, notification emails.
3. **Staff**: invite Managers and Staff. With email configured they get an invite email;
   without it, the Owner sees a one-time link to send them (valid 7 days).
4. Make a test booking from the website and check that the new-request email arrives.

`/api/health` answers `{ "ok": true }` when the server is up.

---

## 6. Backups and restore

- **Automatic database backups**: every day at 02:00 IST the server writes
  `/data/backups/ksr-YYYY-MM-DD.db` (a consistent copy made with `VACUUM INTO`) and keeps the
  newest 14. `npm run backup` makes an extra copy now (`ksr-manual-…db`, never deleted
  automatically).
- **Uploaded files are not inside the database copies**: they are in `/data/files`. The
  platform's volume/disk snapshots cover the database, the files and the backups together:
  - Fly.io: daily volume snapshots (`fly volumes snapshots list <volume-id>`).
  - Render: daily disk snapshots (Disks tab).
  - Railway: volume backups (where your plan includes them).
- The backups sit on the same volume as the live data, so **copy one off the platform
  regularly** (e.g. weekly), for example `fly ssh sftp get /data/backups/ksr-YYYY-MM-DD.db`.
- **Restore** (practise it every quarter, PRD 10.5): the simplest full restore is the
  platform's snapshot restore (a new volume/disk from a snapshot, attached to the single
  instance). To roll back only the database from `/data/backups`, the app must be stopped
  while `ksr.db` is replaced with the backup file and `ksr.db-wal` / `ksr.db-shm` are
  deleted; ask a developer to do this.

---

## 7. Updating

Deploy the new version the usual way (`fly deploy`, a push for Render/Railway). Database
changes are applied automatically when the server starts. Expect a few seconds of downtime
per deploy: with one instance, the old one stops before the new one starts.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Health check fails / app restarts | The log. Usually `/data` is not mounted or not writable, or a setting is malformed. |
| Data disappeared after a deploy | The volume/disk is not mounted at `/data` (or the Render instance type has no disk). |
| "database is locked", odd duplicates | More than one instance is running. Scale to exactly one. |
| No emails | `SMTP_HOST` / credentials; the log shows SMTP errors. Messages queued while SMTP was not configured are marked "skipped" and are not sent later. |
| Two-step codes stopped working for everyone | `APP_SECRET` changed. Restore the old value. |
| Links in emails point to the wrong address | `SITE_URL` (and rebuild with the matching `VITE_SITE_URL`). |
