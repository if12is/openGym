# Huawei Health Kit (mobile watch data)

The Android app reads heart rate, sleep, steps and calories from **Huawei Health
Kit** when the phone can talk to HMS (Huawei/Honor with Huawei Health). Phones
without HMS still fall back to Health Connect.

Health Kit will not return real data until the app is registered in AppGallery
Connect and the read scopes are approved. The APK builds without that file;
sign-in then fails with `not-configured` until you drop in `agconnect-services.json`.

## Package name

Must match the Android `applicationId` **exactly**:

```
ch.duartesantos.opengym
```

## SHA-256 of the signing certificate

Huawei matches the installed APK to this fingerprint. A mismatch is error `6003`.

From the keystore that signs the APK you install (debug keystore password
`gemakdebug`, alias `gemak`):

```sh
keytool -list -v \
  -keystore frontend/android/app/gemak-debug.keystore \
  -alias gemak \
  -storepass gemakdebug
```

Copy the **SHA-256** line into AppGallery Connect → Project settings → App
information → SHA-256 certificate fingerprint. Register both debug and release
certificates if you sign them differently.

CI generates `gemak-debug.keystore` on first run; compute the fingerprint from
the keystore that actually signs the APK you install, not from a guess.

## AppGallery Connect checklist

1. Huawei Developer account (identity verified). Heart rate / sleep / SpO₂ are
   **restricted** scopes: an individual account is often limited to steps and
   calories. Enterprise registration, or listing on AppGallery, is what Huawei
   currently requires for the advanced types this app uses.
2. Create a project → add an **Android** app with package `ch.duartesantos.opengym`.
3. Enable **Account Kit**.
4. Apply for **Health Kit** / Health Service Kit, **read-only**:
   - `heartrate.read`
   - `hearthealth.read` (resting HR)
   - `sleep.read`
   - `step.read`
   - `calories.read`
   - `activityrecord.read`
   - `oxygensaturation.read`
5. Download `agconnect-services.json` and place it at
   `frontend/android/app/agconnect-services.json` (gitignored; see the
   `.example` next to it). Rebuild the APK.
6. After approval, wait ~24 hours, then test on a phone with **HMS Core** and
   **Huawei Health**, watch already synced.

## Privacy policy URL

Huawei's review asks for a public privacy policy. The in-app copy lives at
`frontend/public/privacy-health.html` and is also shown from Health Connect's
consent screen. Host that page (or the same text) at a URL the reviewers can
open without installing the app.
