# Paano bawasan ang storage ng Android Studio / build

Pag nag-build ka, nadadagdagan ang storage dahil sa **build outputs** at **cache**. Pwede mo bawasan nang hindi nasisira ang project.

---

## 1. Linisin ang **project lang** (Beanthentic android-app)

Pwede mo burahin ang folders na ito **anytime**. Magre-recreate sila pag nag-build ka ulit.

**Sa File Explorer (manual):**
- Buksan ang folder `android-app`
- Burahin: **`build`** (buong folder)
- Burahin: **`.gradle`** (buong folder, naka-hidden kaya enable "Hidden items")

**O gamit ang PowerShell** (naka-open sa folder na `Beanthentic`):
```powershell
cd android-app
Remove-Item -Recurse -Force build -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force .gradle -ErrorAction SilentlyContinue
Write-Host "Project build cache cleared."
```

Makakatipid ka ng roughly **hundreds of MB** per build.

---

## 2. Linisin ang **Gradle cache** (lahat ng projects)

Ito yung pinakamalaki. Nasa user folder:

- **`C:\Users\Lyndon\.gradle\caches`**

Pwede mo burahin ang **buong `caches` folder**. Next build magdo-download ulit ang kailangan (mabagal lang unang build).

**PowerShell:**
```powershell
Remove-Item -Recurse -Force "$env:USERPROFILE\.gradle\caches" -ErrorAction SilentlyContinue
Write-Host "Gradle caches cleared."
```

Makakatipid ka ng **GB** (1–5 GB o higit pa).

---

## 3. Linisin ang **Android Studio** cache

- Menu: **File → Invalidate Caches...**
- Piliin **Invalidate and Restart**

O manual, burahin ang folder (palitan ang version kung iba sa iyo):

- **`C:\Users\Lyndon\AppData\Local\Google\AndroidStudio*\caches`**

---

## 4. Bawasan ang **emulator** (AVD) storage

Kung gumagamit ka ng emulator, malaki ang system images.

- **Tools → Device Manager** (o AVD Manager)
- Sa bawat virtual device: **⋮** → **Delete**
- O sa disk: **`C:\Users\Lyndon\.android\avd`** — burahin ang folder ng AVD na hindi mo na ginagamit

---

## 5. One-time: Clean sa loob ng Android Studio

Pagkatapos mag-build:

- **Build → Clean Project**
- Pag gusto mo mas aggressive: **Build → Clean Project**, tapos burahin manual ang `android-app/build` at `android-app/.gradle` (tingnan #1).

---

## Maikling summary

| Gawa                    | Saan                    | Epekto sa storage   |
|-------------------------|-------------------------|----------------------|
| Burahin `build` + `.gradle` | `android-app/`          | ~200–500 MB+        |
| Burahin Gradle caches   | `C:\Users\Lyndon\.gradle\caches` | 1–5+ GB             |
| Invalidate Caches       | Android Studio          | Depende sa usage    |
| Tanggalin AVD           | Device Manager / `.android/avd` | 1–3 GB per AVD      |

**Tip:** Pag tapos mo na i-test ang APK at hindi ka muna magbu-build, okay lang i-run ang #1 at #2 para bawasan agad ang storage.

---

## Pagkatapos mag-clean, paano mag-build ulit

1. **Buksan ang project sa Android Studio**  
   File → Open → piliin ang folder **`android-app`**.

2. **Sync Gradle**  
   Click ang **elephant icon** (Sync Project with Gradle Files) sa toolbar, o **File → Sync Project with Gradle Files**. Hintayin hanggang "Gradle sync finished".

3. **Build**  
   **Build → Clean Project**, tapos **Build → Rebuild Project** o **Build → Build APK(s)**.

Kung may error pa rin: **File → Invalidate Caches... → Invalidate and Restart**, tapos ulit ang Sync at Build.
