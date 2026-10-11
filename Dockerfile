# KSR Self Drive Cars: one Node process (Hono + node:sqlite) serving the website, the API
# and files. All data (SQLite database, uploaded files, backups) lives in /data, which must
# be a persistent volume/disk. Run exactly ONE instance: SQLite is a single-writer file.
#
#   docker build -t ksr --build-arg VITE_SITE_URL=https://www.example.com .
#   docker run -p 8080:8080 -v ksr-data:/data -e APP_SECRET=… -e SITE_URL=… ksr

# ------------------------------------------------------------------ 1. build the web app
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Baked into the static site at build time (canonical URLs, sitemap, analytics).
ARG VITE_SITE_URL=""
ARG VITE_PLAUSIBLE_DOMAIN=""
ENV VITE_SITE_URL=${VITE_SITE_URL} VITE_PLAUSIBLE_DOMAIN=${VITE_PLAUSIBLE_DOMAIN}
RUN npm run build

# ------------------------------------------------------------------ 2. production dependencies only
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ------------------------------------------------------------------ 3. runtime
FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080
WORKDIR /app
# Node runs the TypeScript server directly (type stripping), so the sources are the app.
# The server only imports *types* from src/types (erased at run time); it is copied anyway
# so a type-only import written as `import { type X }` can never break start-up.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY server ./server
COPY shared ./shared
COPY src/types ./src/types
# Runs as root on purpose: Fly.io volumes, Render disks and Railway volumes are mounted
# root-owned, and the database, uploads and backups must be writable in /data.
RUN mkdir -p /data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
