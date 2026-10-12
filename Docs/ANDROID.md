# Android app

One app for customers and staff. It is a native Android shell (Capacitor 8) that opens the KSR
website, so customers browse and book, and staff tap **Staff sign-in** (in the footer, shown only
in the app) to use the admin. Every website deploy reaches the app at once; a new app build is
needed only to change the address, the icon or the native settings.

What the app adds to the website:

| In the app | How |
|---|---|
| Back button closes the open dialog or menu, then goes back a page, then leaves the app | `src/lib/native.ts` |
| Exports, documents and ZIPs open the share sheet (save to Files or Drive, or send) | `src/lib/download.ts` |
| "Take photo" uses the camera (licence, documents, handover, receipts) | camera permission, asked on first use |
| Phone, WhatsApp and Maps links open those apps; policy pages open in an in-app browser | `src/lib/native.ts` |
| Stays clear of the status bar, the navigation bar and the keyboard | `android/app/src/main/java/.../MainActivity.java` |
| "No connection" page with Try again | `app-shell/offline.html` |
| KSR icon and launch screen | `npm run android:assets` |

Package name: `com.ksrselfdrivecars.app`. It is permanent once the app is on Google Play;
change it in `capacitor.config.ts` and `android/app/build.gradle` before the first upload if you
want a different one.

## Needs

Android Studio (it brings Java 21 and the Android SDK). The scripts find both. The first build
downloads Gradle and SDK parts and takes a few minutes.

## Try it on a phone (before the site is online)

The app needs the server. On this computer, run the site and keep it running:

```bash
npm run build
npm start            # http://localhost:3000, also reachable from your Wi-Fi
```

**Over Wi-Fi** (phone and computer on the same network):

```bash
npm run android:apk -- --url http://192.168.0.6:3000    # this computer's address: ipconfig → IPv4
```

Copy `release/ksr-self-drive-cars-debug.apk` to the phone (USB, Drive or WhatsApp to yourself),
open it and allow "Install unknown apps" for the app you opened it with. If the phone can't
connect, allow Node.js through Windows Firewall for the network you are on, and check that the
computer's address hasn't changed.

**Over USB** (no Wi-Fi needed): turn on Developer options › USB debugging on the phone, plug it
in, accept the prompt, then:

```bash
npm run android:usb      # builds, installs, opens; the phone reaches localhost:3000 through adb reverse
```

To look inside the running app, open `chrome://inspect` in Chrome on the computer (debug builds only).

## Publish on Google Play

1. Deploy the site (Docs/DEPLOY.md) so it has an `https://` address.
2. Create an upload key once and keep it safe; without it you can't update the app:
   ```bash
   "C:\Program Files\Android\Android Studio\jbr\bin\keytool" -genkeypair -v -keystore ksr-upload.jks -alias ksr -keyalg RSA -keysize 2048 -validity 10000
   ```
   Store `ksr-upload.jks` and its passwords outside the repository (`*.jks` is git-ignored).
3. Build the bundle with the live address. Raise `KSR_VERSION_CODE` for every upload:
   ```bash
   KSR_UPLOAD_STORE_FILE=/path/to/ksr-upload.jks KSR_UPLOAD_STORE_PASSWORD=… \
   KSR_UPLOAD_KEY_ALIAS=ksr KSR_UPLOAD_KEY_PASSWORD=… \
   KSR_VERSION_CODE=1 KSR_VERSION_NAME=1.0 \
   npm run android:bundle -- --url https://www.example.com
   ```
   (In PowerShell, set each with `$env:NAME = "value"` first.) The result is `release/ksr-self-drive-cars.aab`.
4. In Google Play Console: create the app, complete the store listing, content rating and the
   Data safety form (the app collects name, phone, licence details and photos for bookings, as
   in the privacy notice), then upload the `.aab` to internal testing first.

Google Play accepts apps that show a website when they work like an app; this one adds the
camera, share sheet, back button, offline page and in-app staff tools. Write the store listing
around booking cars and managing rentals.

## Other commands

| Command | Does |
|---|---|
| `npm run android:open` | opens the project in Android Studio (run on an emulator from there) |
| `npm run android:assets` | redraws the icon and launch screen from the KSR plate logo |
| `npm run dev:lan` | the dev server reachable from the phone (`--url http://<this computer>:8080`) |

The native project lives in `android/` (committed). `android/app/src/main/assets/public`,
`capacitor.config.json` and the build outputs are generated and git-ignored.
