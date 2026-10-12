// KSR Self Drive Cars, React Native app (Expo). See mobile/README.md.
//
//   EXPO_PUBLIC_API_URL   the KSR server the app talks to by default (the app's Settings
//                         screen can change it). Default: the live site on Render.
//   KSR_ALLOW_HTTP=1      allow plain http (test builds that talk to a computer, not https).
import type { ConfigContext, ExpoConfig } from 'expo/config';

const apiUrl = (process.env.EXPO_PUBLIC_API_URL ?? 'https://ksr-self-drive-cars.onrender.com').replace(/\/+$/, '');
const allowHttp = apiUrl.startsWith('http://') || process.env.KSR_ALLOW_HTTP === '1';

const INK = '#1d2125';

// app.json holds only what EAS writes there itself (the project id and owner after
// `eas init`); everything else is here.
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'KSR Cars',
  slug: 'ksr-self-drive-cars',
  scheme: 'ksrcars',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  backgroundColor: '#e9ebe7',
  android: {
    // Different from the website app (com.ksrselfdrivecars.app), so both can be installed.
    package: 'com.ksrselfdrivecars.mobile',
    versionCode: Number(process.env.KSR_VERSION_CODE ?? 1),
    adaptiveIcon: {
      backgroundColor: '#000000',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    // "Take photo" in the full admin (licence, documents, handover photos).
    permissions: ['android.permission.CAMERA'],
    softwareKeyboardLayoutMode: 'resize',
  },
  ios: { supportsTablet: false, bundleIdentifier: 'com.ksrselfdrivecars.mobile' },
  web: { favicon: './assets/favicon.png', bundler: 'metro' },
  plugins: [
    'expo-router',
    'expo-web-browser',
    ['expo-splash-screen', { image: './assets/splash-icon.png', imageWidth: 180, resizeMode: 'contain', backgroundColor: INK }],
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: allowHttp,
          // Phones and the emulator; leaving out 32-bit x86 keeps the APK smaller.
          buildArchs: ['arm64-v8a', 'armeabi-v7a', 'x86_64'],
        },
      },
    ],
  ],
  experiments: { typedRoutes: true },
  extra: { ...config.extra, apiUrl },
});
