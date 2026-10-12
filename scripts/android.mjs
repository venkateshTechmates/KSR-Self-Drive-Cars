// Android app builds (see Docs/ANDROID.md). Finds Android Studio's Java and the Android SDK,
// syncs the Capacitor project and runs Gradle.
//
//   npm run android:apk                     debug APK → release/ksr-self-drive-cars-debug.apk
//   npm run android:apk -- --url http://192.168.0.6:3000
//                                           the same, opening that address (phone on Wi-Fi)
//   npm run android:bundle -- --url https://www.example.com
//                                           Play Store bundle (.aab), signed with your upload key
//   npm run android:usb                     install on a USB phone/emulator and open it; the phone
//                                           reaches this computer's :3000 through `adb reverse`
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  options: { url: { type: 'string' } },
  allowPositionals: true,
});
const command = positionals[0] ?? 'apk';
const root = resolve(import.meta.dirname, '..');
const androidDir = join(root, 'android');
const win = process.platform === 'win32';

function firstExisting(paths) {
  return paths.find((p) => p && existsSync(p));
}

const javaHome = firstExisting([
  process.env.JAVA_HOME,
  win && 'C:\\Program Files\\Android\\Android Studio\\jbr',
  process.platform === 'darwin' && '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  '/opt/android-studio/jbr',
  join(homedir(), 'android-studio', 'jbr'),
]);
const sdk = firstExisting([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  win && join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
  join(homedir(), 'Library', 'Android', 'sdk'),
  join(homedir(), 'Android', 'Sdk'),
]);
if (!javaHome) fail('Java not found. Install Android Studio, or set JAVA_HOME to a JDK 21.');
if (!sdk) fail('Android SDK not found. Install Android Studio, or set ANDROID_HOME.');

const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };
const adb = join(sdk, 'platform-tools', win ? 'adb.exe' : 'adb');

function fail(message) {
  console.error(`[android] ${message}`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  console.info(`[android] ${cmd} ${args.join(' ')}`);
  const options = { stdio: 'inherit', env: { ...env, ...opts.env }, cwd: opts.cwd ?? root };
  // Windows runs .cmd/.bat files through the shell: pass one command line (the arguments are
  // this script's own, never user input).
  const r = opts.shell
    ? spawnSync([cmd, ...args].map((a) => (/[\s"]/.test(a) ? `"${a}"` : a)).join(' '), { ...options, shell: true })
    : spawnSync(cmd, args, options);
  if (r.status !== 0) fail(`${cmd} failed (exit ${r.status ?? r.signal}).`);
}

/** Copy the site address into the native project (capacitor.config.ts reads KSR_APP_URL). */
function sync(url) {
  if (url && !/^https?:\/\/[^/\s]+$/i.test(url.replace(/\/+$/, ''))) fail(`--url must look like https://www.example.com (got ${url}).`);
  writeFileSync(join(androidDir, 'local.properties'), `sdk.dir=${sdk.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}\n`);
  run(win ? 'npx.cmd' : 'npx', ['cap', 'sync', 'android'], { env: url ? { KSR_APP_URL: url } : {}, shell: win });
  const opened = JSON.parse(readFileSync(join(androidDir, 'app', 'src', 'main', 'assets', 'capacitor.config.json'), 'utf8')).server?.url;
  console.info(`[android] the app opens ${opened}`);
  return opened;
}

function gradle(task) {
  run(join(androidDir, win ? 'gradlew.bat' : 'gradlew'), [task, '--no-daemon'], { cwd: androidDir, shell: win });
}

function copyOut(from, name) {
  mkdirSync(join(root, 'release'), { recursive: true });
  const to = join(root, 'release', name);
  copyFileSync(from, to);
  console.info(`[android] ready: ${to}`);
  return to;
}

const debugApk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');

if (command === 'apk') {
  const opened = sync(values.url);
  gradle('assembleDebug');
  copyOut(debugApk, 'ksr-self-drive-cars-debug.apk');
  if (opened.startsWith('http://')) console.info('[android] Test build: start the site with `npm run build && npm start` on this computer first.');
} else if (command === 'bundle') {
  if (!values.url?.startsWith('https://')) fail('A Play Store build needs the live site: npm run android:bundle -- --url https://www.example.com');
  for (const k of ['KSR_UPLOAD_STORE_FILE', 'KSR_UPLOAD_STORE_PASSWORD', 'KSR_UPLOAD_KEY_ALIAS', 'KSR_UPLOAD_KEY_PASSWORD']) {
    if (!process.env[k]) fail(`Set ${k} (your upload key, see Docs/ANDROID.md).`);
  }
  sync(values.url);
  gradle('bundleRelease');
  copyOut(join(androidDir, 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab'), 'ksr-self-drive-cars.aab');
} else if (command === 'usb') {
  const devices = execFileSync(adb, ['devices'], { env, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter((l) => /\tdevice$/.test(l));
  if (devices.length === 0) fail('No phone or emulator found. Plug in the phone with USB debugging on (Docs/ANDROID.md).');
  const port = values.url ? new URL(values.url).port || '80' : '3000';
  sync(values.url ?? `http://localhost:${port}`);
  gradle('assembleDebug');
  run(adb, ['reverse', `tcp:${port}`, `tcp:${port}`]);
  run(adb, ['install', '-r', debugApk]);
  run(adb, ['shell', 'am', 'start', '-n', 'com.ksrselfdrivecars.app/.MainActivity']);
  console.info(`[android] Opened on the phone. Keep \`npm start\` (or the server on :${port}) running on this computer.`);
} else {
  fail('Commands: apk, bundle, usb');
}
