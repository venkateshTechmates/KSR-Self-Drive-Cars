// In-process scheduled jobs (replaces pg_cron; 9.3, 10.4, 10.5, 11). A 60-second tick runs
// whatever is due. Each run is recorded in job_runs (name, last_run_at, last_result), so a
// restart doesn't run a job twice and a daily job missed while the service was down runs
// at the next start. Failures are logged and recorded; they never stop the process.
//
//   notify            every minute         send queued emails (outbox)
//   overdue           every 15 minutes     overdue-return alerts
//   document-expiry   daily 08:00 IST      mark expired documents, queue expiry reminders
//   retention         daily 03:00 IST      erase documents past retention, stale records, old sessions
//   backup            daily 02:00 IST      VACUUM INTO backups/ksr-YYYY-MM-DD.db, keep the newest 14
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { addDaysIso, fromIst, istDateIso, MS_MINUTE } from '../../shared/time.ts';
import { systemCtx } from '../access/context.ts';
import { purgeExpiredSessions } from '../auth/sessions.ts';
import { config } from '../config.ts';
import { getDb, nowIso, one, run, tx } from '../db/connection.ts';
import { drainOutbox, drainSoon } from '../notify.ts';
import { runRetentionPurge } from '../routes/functions.ts';
import { markExpiredDocuments, queueExpiryReminders, queueOverdueAlerts } from './tasks.ts';

const TICK_MS = 60_000;
/** A failed daily job is tried again after this long (instead of waiting a whole day). */
const DAILY_RETRY_MS = 60 * MS_MINUTE;
const KEEP_BACKUPS = 14;

type Schedule = { every: number } | { dailyAtIst: string };

interface Job {
  name: string;
  schedule: Schedule;
  run: () => Promise<unknown> | unknown;
}

interface JobRun {
  last_run_at: string;
  last_result: string | null;
}

// ------------------------------------------------------------------ backups (10.5)

const BACKUP_RE = /^ksr-\d{4}-\d{2}-\d{2}\.db$/;

/** Copy the live database to backups/ksr-<IST date>.db and keep the newest KEEP_BACKUPS. */
export function backupDatabase(now: Date = new Date(), dir: string = config.backupsDir): { file: string; kept: number; removed: number } {
  mkdirSync(dir, { recursive: true });
  const name = `ksr-${istDateIso(now)}.db`;
  const target = join(dir, name);
  const temp = `${target}.tmp`;
  // VACUUM INTO refuses to overwrite, so write a temp copy and move it into place.
  rmSync(temp, { force: true });
  getDb().exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
  renameSync(temp, target);

  const backups = readdirSync(dir)
    .filter((f) => BACKUP_RE.test(f))
    .sort()
    .reverse();
  const old = backups.slice(KEEP_BACKUPS);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return { file: name, kept: backups.length - old.length, removed: old.length };
}

// ------------------------------------------------------------------ jobs

export const JOBS: readonly Job[] = [
  { name: 'notify', schedule: { every: MS_MINUTE }, run: () => drainOutbox(50) },
  {
    name: 'overdue',
    schedule: { every: 15 * MS_MINUTE },
    run: () => {
      const queued = tx(() => queueOverdueAlerts(systemCtx()));
      if (queued) drainSoon();
      return { queued };
    },
  },
  {
    name: 'document-expiry',
    schedule: { dailyAtIst: '08:00' },
    run: () => {
      const result = tx(() => {
        const ctx = systemCtx();
        return { expired: markExpiredDocuments(ctx), reminders: queueExpiryReminders(ctx) };
      });
      if (result.reminders) drainSoon();
      return result;
    },
  },
  {
    name: 'retention',
    schedule: { dailyAtIst: '03:00' },
    run: async () => {
      const purge = await runRetentionPurge(systemCtx());
      const sessions = tx(() => purgeExpiredSessions());
      return { ...purge, sessions };
    },
  },
  { name: 'backup', schedule: { dailyAtIst: '02:00' }, run: () => backupDatabase() },
];

/** The latest scheduled time of a daily job at or before `now`. */
function lastDailySlot(timeIst: string, now: Date): Date {
  const today = istDateIso(now);
  const slot = fromIst(today, timeIst)!;
  return slot.getTime() <= now.getTime() ? slot : fromIst(addDaysIso(today, -1), timeIst)!;
}

function lastFailed(runInfo: JobRun): boolean {
  try {
    return (JSON.parse(runInfo.last_result ?? 'null') as { ok?: boolean } | null)?.ok === false;
  } catch {
    return false;
  }
}

export function isDue(job: Job, last: JobRun | undefined, now: Date): boolean {
  if (!last) return true;
  const lastAt = Date.parse(last.last_run_at);
  if (Number.isNaN(lastAt)) return true;
  if ('every' in job.schedule) {
    // A little slack so a tick that fires a moment early still counts.
    return now.getTime() - lastAt >= job.schedule.every - 5_000;
  }
  if (lastAt < lastDailySlot(job.schedule.dailyAtIst, now).getTime()) return true;
  return lastFailed(last) && now.getTime() - lastAt >= DAILY_RETRY_MS;
}

function record(name: string, at: string, result: unknown): void {
  let text: string;
  try {
    text = JSON.stringify(result ?? null).slice(0, 4000);
  } catch {
    text = 'null';
  }
  run(
    `INSERT INTO job_runs (name, last_run_at, last_result) VALUES (?, ?, ?)
     ON CONFLICT (name) DO UPDATE SET last_run_at = excluded.last_run_at, last_result = excluded.last_result`,
    name,
    at,
    text,
  );
}

/** Run every job that is due now, one after another. Never throws. */
export async function runDueJobs(now: Date = new Date(), jobs: readonly Job[] = JOBS): Promise<string[]> {
  const ran: string[] = [];
  for (const job of jobs) {
    try {
      const last = one<JobRun>('SELECT last_run_at, last_result FROM job_runs WHERE name = ?', job.name);
      if (!isDue(job, last, now)) continue;
      // Claim the run first, so a crash or restart mid-job doesn't run it again straight away.
      const startedAt = nowIso();
      record(job.name, startedAt, { ok: null, started: true });
      ran.push(job.name);
      try {
        const result = await job.run();
        record(job.name, startedAt, { ok: true, result: result ?? null });
      } catch (err) {
        const message = `${(err as Error)?.name ?? 'Error'}: ${(err as Error)?.message ?? String(err)}`.slice(0, 500);
        console.error(`[jobs] ${job.name} failed:`, message);
        record(job.name, startedAt, { ok: false, error: message });
      }
    } catch (err) {
      console.error(`[jobs] could not run ${job.name}:`, (err as Error)?.message ?? String(err));
    }
  }
  return ran;
}

/** Start the tick (unref'd, so it never keeps the process alive). Returns a stop function. */
export function startScheduler(): () => void {
  if (!config.runJobs) return () => {};
  if (!existsSync(config.backupsDir)) mkdirSync(config.backupsDir, { recursive: true });

  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return; // a long job (e.g. a backup) is still going
    running = true;
    try {
      await runDueJobs();
    } catch (err) {
      console.error('[jobs] tick failed:', (err as Error)?.message ?? String(err));
    } finally {
      running = false;
    }
  };

  // First tick shortly after start-up (runs jobs missed while the service was down).
  const first = setTimeout(() => void tick(), 2_000);
  first.unref();
  const timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
