# StreamLift

A self-hosted download manager that streams files directly to cloud storage — no intermediate disk storage required. Supports HTTP/direct URL downloads and magnet link/torrent downloads, with real-time progress tracking across browser tabs.


## Features

- **HTTP Downloads** — stream any direct URL straight to cloud storage (zero local disk usage)
- **Torrent Downloads** — stream torrent files to cloud storage using an in-memory chunk store; no disk writes
- **Workers** — distribute downloads across multiple backend worker instances
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
| `next-frontend/` | TypeScript (Next.js 15, App Router) |

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
