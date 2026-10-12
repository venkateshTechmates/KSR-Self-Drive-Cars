// Builds an installable APK on this computer (no Expo account needed):
//   npm run apk                       release APK → ../release/ksr-cars-react-native.apk
//   npm run apk -- --url https://…    a different default server
// Finds Android Studio's Java and the Android SDK, generates the native project
// (expo prebuild; android/ is generated and git-ignored) and runs Gradle. The APK is signed
// with the debug key, which is fine for testers; Play Store builds use EAS (see README.md).
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { url: { type: 'string' } } });
const app = resolve(import.meta.dirname, '..');
const win = process.platform === 'win32';
const first = (paths) => paths.find((p) => p && existsSync(p));

const javaHome = first([
  process.env.JAVA_HOME,
  win && 'C:\\Program Files\\Android\\Android Studio\\jbr',
  process.platform === 'darwin' && '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
  join(homedir(), 'android-studio', 'jbr'),
]);
const sdk = first([
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  win && join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
  join(homedir(), 'Library', 'Android', 'sdk'),
  join(homedir(), 'Android', 'Sdk'),
]);
if (!javaHome || !sdk) {
  console.error('[apk] Install Android Studio (it brings Java and the Android SDK), or set JAVA_HOME and ANDROID_HOME.');
  process.exit(1);
}

// Test builds may also talk to a computer over plain http (set in Settings in the app).
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk, KSR_ALLOW_HTTP: '1', ...(values.url ? { EXPO_PUBLIC_API_URL: values.url } : {}) };

function run(cmd, cwd = app) {
  console.info(`[apk] ${cmd}`);
  // One command line through the shell (Windows runs npx/gradlew as .cmd/.bat); no user input in it.
  const r = spawnSync(cmd, { cwd, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`[apk] failed: ${cmd}`);
    process.exit(1);
  }
}

run('npx expo prebuild --platform android --clean --no-install');
writeFileSync(join(app, 'android', 'local.properties'), `sdk.dir=${sdk.replaceAll('\\', '\\\\').replaceAll(':', '\\:')}\n`);
run(`"${join(app, 'android', win ? 'gradlew.bat' : 'gradlew')}" assembleRelease --no-daemon`, join(app, 'android'));

const apk = join(app, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const outDir = resolve(app, '..', 'release');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'ksr-cars-react-native.apk');
copyFileSync(apk, out);
console.info(`[apk] ready: ${out}`);
