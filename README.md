# Scout Web

**The control plane for anonymous, disposable browser identities.**

Scout Web is the desktop app that manages everything about your browser
profiles — proxies, cookies, extensions, fingerprints — without ever letting
that data touch the browser session itself. Every profile it launches starts
from zero: no shared state, no cross-contamination, no fingerprint leakage
between identities. The browser only ever sees what Scout Web hands it at
launch time, and nothing more.

We built it because every other multi-profile browser tool we tried made the
same mistake: mixing management state (accounts, proxy pools, saved cookies)
into the same process as the actual browsing session. That's a liability, not
a feature. Scout Web keeps them apart on purpose.

## What it does

- **Profiles** — create, clone, tag, fold into folders, bulk-launch, bulk-edit.
- **Proxies** — a shared, searchable proxy library with live health checks
  (egress IP, country, latency) and CSV bulk import.
- **Cookies** — a shared cookie-set library. Upload once, assign to any
  profile, swap between profiles without re-uploading.
- **Fingerprints** — per-profile OS/browser/canvas/WebGL/WebRTC/audio spoofing,
  coherent by construction (no mismatched OS+UA+timezone combinations).
- **Extensions** — team-shared extensions (Web Store or local folder),
  materialized fresh on every machine that needs them.
- **Auto-updates** — background update checks, automatic download, and a
  one-click restart when you're ready.
- **A local automation API** — script profile creation and launch from your
  own tooling.

## Architecture: two processes, one boundary

Scout Web is one half of a deliberate two-process design:

```
┌───────────────────────┐        launch payload         ┌───────────────────────┐
│    Scout Web     │ ─────────────────────────────▶│    Monti Browser      │
│  (this repo, open     │   (proxy, fingerprint,        │  (proprietary,        │
│   source)             │    cookies, extensions)       │   closed source)      │
│                       │                               │                       │
│  owns:                │                               │  owns:                │
│  · account/session    │                               │  · profile runtime    │
│  · cloud-synced       │                               │  · proxy application  │
│    profiles/proxies/  │                               │  · extension loading  │
│    cookies/folders    │                               │  · fingerprint flags  │
│  · API tokens         │                               │  · session cookies    │
└───────────────────────┘                               └───────────────────────┘
```

Scout Web never embeds browser UI, and Monti Browser never signs in to an
account or shows any management surface. Each browser session is handed
exactly one launch payload and nothing else — it doesn't know your account
exists.

Monti Browser is our proprietary anti-detect Chromium engine — it's closed
source and distributed as a compiled binary that Scout Web downloads and
launches on demand. This repo is the entire open-source surface of the
product: the control plane, the UI, and the launch orchestration.

## Getting started

```sh
npm install
npm run dev      # Vite + Electron, hot-reloaded
npm run build    # production frontend build
npm run dist     # package an installer (electron-builder)
```

Requires a `.env` with `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` for
cloud sync — see `.env.example`.

## Contributing

Agent/AI handoff notes live in `AGENTS.md` — read it before making changes,
especially anything touching the process boundary above.
