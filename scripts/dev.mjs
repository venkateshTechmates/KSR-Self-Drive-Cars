// npm run dev: the API server (restarts on change) + Vite (hot reload), one terminal.
// Vite on :8080 proxies /api and /media to the server on :3000.
import { spawn } from 'node:child_process';

const procs = [
  ['api', process.execPath, ['--watch-path=server', '--watch-path=shared', '--disable-warning=ExperimentalWarning', 'server/index.ts'], { PORT: '3000' }],
  // Extra arguments go to Vite, e.g. `npm run dev:lan` (--host) for a phone on the same Wi-Fi.
  ['web', process.execPath, ['node_modules/vite/bin/vite.js', ...process.argv.slice(2)], {}],
].map(([name, cmd, args, env]) => {
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk) => chunk.toString().replace(/^(?=.)/gm, `[${name}] `);
  child.stdout.on('data', (d) => process.stdout.write(prefix(d)));
  child.stderr.on('data', (d) => process.stderr.write(prefix(d)));
  child.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`);
    shutdown(code ?? 0);
  });
  return child;
});

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
