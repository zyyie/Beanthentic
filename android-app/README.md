# Beanthentic – Android app (homepage only)

Android project: Beanthentic homepage sa isang WebView, walang server. Hero images from internet kapag may data.

**App source (important files only):**
- `app/src/main/assets/index.html` — buong homepage (inlined)
- `app/src/main/assets/css/` — base, layout, components, responsive
- `app/src/main/assets/js/` — navigation.js, ui.js
- `app/src/main/java/.../MainActivity.kt` — WebView
- `app/src/main/AndroidManifest.xml`, `res/` — config at icons

---

## Paano gumawa ng APK (Build the APK)

Kailangan mo ng **Android Studio**: https://developer.android.com/studio

### Para gumana ang "Generate APKs"

1. **Open the project**  
   Android Studio → **File → Open** → piliin ang folder na **`android-app`** (yung may `build.gradle.kts`).

2. **Hintayin ang Gradle sync**  
   Sa baba, hintayin na matapos ang "Gradle sync" (first time maaaring mag-download ng dependencies).

3. **Build ng APK**  
   - **Build → Generate App Bundles or APKs → Generate APKs**
   - Sa dialog: piliin **APK** (kung may tanong), tapos **Next**
   - Piliin **release** (o **debug** kung gusto mo mas mabilis), tapos **Create**
   - Kung may lumabas na "Signing", puwede mo i-skip o gamitin ang default — naka-set na ang project para gumana kahit walang sariling keystore

4. **Kung may error**  
   - Gamitin na lang: **Build → Build Bundle(s) / APK(s) → Build APK(s)**  
   - Ito gumagawa ng **debug** APK na pwedeng i-install agad (walang signing setup).

5. **Hanapin ang APK**  
   Pag tapos na ang build:
   - **Release:** `android-app/app/build/outputs/apk/release/app-release.apk`
   - **Debug:** `android-app/app/build/outputs/apk/debug/app-debug.apk`
   - Pwede mo rin i-click ang link na "locate" sa notification sa baba ng Android Studio.

### Install sa phone

- I-copy ang APK sa phone at i-open para i-install, **o**
- Ikonekta ang phone (USB debugging on) at gamitin **Run → Run 'app'**.

## What’s included

- Homepage: header, hero (slider), about, footer — lahat naka-inline sa isang `index.html`.
- Assets: `assets/index.html`, `assets/css/`, `assets/js/` (navigation.js, ui.js).
- “Dashboard” sa header ay disabled (link does nothing); APK = homepage only.
- Hero images ay from internet kapag may connectivity.

## Signing the APK (optional)

The built APK is **unsigned**. To install on most devices you can use the debug build instead:

- **Build → Build Bundle(s) / APK(s) → Build APK(s)** (builds debug by default),  
  or run: `./gradlew assembleDebug`

The debug APK is at: **app/build/outputs/apk/debug/app-debug.apk** and can be installed for testing.

For release (e.g. Play Store), create a keystore and configure signing in **Build → Generate Signed Bundle / APK**.
