// Start the KSR Self Drive Cars service: one process, one SQLite file, API + files + web app.
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { bootstrapOwnerFromEnv, hasOwner, openAndMigrate } from './boot.ts';
import { config, smtpConfigured } from './config.ts';
import { startScheduler } from './jobs/scheduler.ts';

openAndMigrate();
await bootstrapOwnerFromEnv();

const stopJobs = config.runJobs ? startScheduler() : () => {};
const server = serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  console.info(`[ksr] listening on http://localhost:${info.port} (data: ${config.dataDir})`);
  if (!smtpConfigured()) console.info('[ksr] SMTP is not configured: emails are written to this log instead of being sent.');
  if (!hasOwner()) console.info('[ksr] No Owner yet. Run `npm run create-owner -- --email you@example.com --name "Your name"`, or set OWNER_EMAIL/OWNER_PASSWORD.');
});

function shutdown(signal: string) {
  console.info(`[ksr] ${signal}: shutting down`);
  stopJobs();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
