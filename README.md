# StreamLift

A self-hosted download manager that streams files directly to cloud storage — no intermediate disk storage required. Supports HTTP/direct URL downloads and magnet link/torrent downloads, with real-time progress tracking across browser tabs.


## Features

- **HTTP Downloads** — stream any direct URL straight to cloud storage (zero local disk usage)
- **Torrent Downloads** — stream torrent files to cloud storage using an in-memory chunk store; no disk writes
- **Workers** — distribute downloads across multiple backend worker instances
- **Android TV** — watch-only Compose for TV app with code-based pairing, worker library, and Media3 playback
- **Real-time Progress** — live progress updates synced across all open tabs via SharedWorker + SSE
- **Offline-first** — IndexedDB-backed download list with delta sync to PostgreSQL
- **Guest Sessions** — each user gets an isolated folder in cloud storage

## Cloud Storage

Currently supported: **MEGA**. Designed to support additional providers in the future.

## Architecture

```
Frontend
  └── SharedWorker ──SSE──► Backend ──► Cloud Storage
        └── IndexedDB          └──► PostgreSQL
```

The frontend uses a SharedWorker so a single SSE connection handles progress across all open tabs. Downloads are claimed atomically in the DB to prevent duplicate starts across tabs.

---

## Implementations

### Backends

All backends expose the same API. Pick any one and point a frontend at it.

| Path | Language / Framework |
|------|----------------------|
| `nest-backend/` | TypeScript (NestJS) |
| `express-backend/` | JavaScript (Express) |
| `rust-backend/` | Rust (Axum) |

### Frontends

| Path | Language / Framework |
|------|----------------------|
| `next-frontend/` | TypeScript (Next.js 16, App Router) |
| `kotlin-tv/` | Kotlin (Compose for TV, Media3/ExoPlayer) |

---

## Getting Started

### Prerequisites

- PostgreSQL database
- Cloud storage account (currently MEGA)
- Node.js 20+ _(for NestJS / Express backends and Next.js frontend)_
- Rust + Cargo _(for Rust backend)_

### 1. Run a backend (pick one)

**NestJS**
```bash
cd nest-backend
cp .env.example .env
npm install
npm run db:push
npm run start:dev
```

**Express**
```bash
cd express-backend
cp .env.example .env
npm install
npm run db:push
npm run start
```

**Rust (Axum)**
```bash
cd rust-backend
cp .env.example .env
cargo run --release
```

### 2. Run a frontend (pick one)

**Next.js**
```bash
cd next-frontend
cp .env.local.example .env.local
npm install
npm run dev
```

### 3. Android TV (optional, Next.js backend)

The TV app is watch-only: it lists online local-storage workers and plays their video/audio, but it cannot add downloads, manage workers, or sign in.

1. Apply the TV pairing migration to the Next.js PostgreSQL database:
   ```bash
   cd next-frontend
   psql "$DATABASE_URL" -f db/migrations/0001_tv_pairing.sql
   ```
2. Build and install the APK (JDK 17 + Android SDK 35):
   ```bash
   cd kotlin-tv
   cp local.properties.example local.properties
   # set sdk.dir; optionally set streamlift.server.url
   ./gradlew :app:assembleDebug
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   ```
3. Launch the app and pair it:
   - Use the server URL baked in from `local.properties`, or set it in the TV Settings screen.
   - Open `/watch` on the web, choose **Connect to TV**, and enter the 6-character code shown on the TV.
   - Approve the device. Codes expire after 10 minutes; devices can be revoked from the same dialog.

The TV and the Next.js server must be able to reach each other. Debug builds allow cleartext HTTP for LAN testing; release builds require HTTPS. The worker/tunnel URLs used for thumbnails, HLS playback, and subtitles must also be reachable from the TV.

### Android TV releases

Signed release APKs are built by GitHub Actions and attached to GitHub Releases. The git tag is the version source of truth:

```bash
git tag -a tv-v0.1.0 -m "StreamLift TV 0.1.0"
git push origin tv-v0.1.0
```

The `Release Android TV APK` workflow then:

- derives `versionName` from the tag (`tv-v0.1.0` → `0.1.0`)
- derives `versionCode` as `major * 10000 + minor * 100 + patch` (`100`)
- builds and signs `kotlin-tv`
- publishes `streamlift-tv-0.1.0.apk` and its `.sha256` checksum

Download the APK from the repository's **Releases** page and install it with the **Downloader** app or `adb install -r streamlift-tv-0.1.0.apk`.

Release signing requires these repository secrets:

| Secret | Description |
|--------|-------------|
| `TV_KEYSTORE_BASE64` | Base64-encoded release keystore |
| `TV_KEYSTORE_PASSWORD` | Keystore password |
| `TV_KEY_ALIAS` | Key alias |
| `TV_KEY_PASSWORD` | Key password |

Generate the keystore once (back it up — updates require the same key):

```bash
keytool -genkeypair -v \
  -keystore streamlift-tv-release.jks \
  -alias streamlift-tv \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=StreamLift TV, O=StreamLift, C=IN"

base64 -i streamlift-tv-release.jks | pbcopy
```

Keystores are gitignored and must never be committed. Optionally set the repository variable `STREAMLIFT_SERVER_URL` to bake a default HTTPS server URL into release APKs.
