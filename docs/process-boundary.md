# Process Boundary

Scout is two apps.

## Scout Web

Launcher is the control plane. It talks to Supabase and stores cloud-backed
manager data:

- profiles
- proxies
- folders
- statuses
- shared bookmarks
- shared extensions
- per-profile command line switches
- API tokens

Scout Web starts browser sessions by spawning Monti Browser with explicit runtime
arguments. It never opens the dashboard inside a browser tab.

## Monti Browser

Browser is the anonymous data plane. It receives one profile launch payload and
opens a browser session.

Browser does not sign in to Supabase. Browser does not show the Scout Web table.
Browser does not manage cloud profiles.

## Launch Contract

Launcher passes:

- `--monti-profile-launch`
- `--monti-profile-id`
- `--monti-profile-name`
- `--monti-profile-icon` — absolute path to a PNG the launcher generated for
  this profile's colour and the user's current theme. The browser retints its
  own Dock tile from it (macOS only). It has to be passed rather than derived,
  because the artwork and the theme both live on the launcher side; and it has
  to be the browser that applies it, because all sessions share one bundle and
  the only per-session handle on a Dock tile is the running process.
- `--user-data-dir`
- proxy flags
- shared extension paths
- per-profile command line switches

The Browser process should treat those values as runtime input only.

## Automation runs cross this boundary in one direction only

The runner (`electron/automation/`) drives a launched profile over CDP from the
main process, which is a new kind of traffic but not a new kind of coupling:

- **Main still holds no Supabase credentials.** The renderer resolves the
  automation and the profile, hands them over as plain values at start, and the
  runner streams events back for the renderer to persist. Nothing here reads or
  writes a row.
- **The session lives in main because the renderer is a window.**
  `window-all-closed` does not quit on macOS, so a window closed mid-run would
  abandon a browser that is still being driven. Main already owns
  `automationLaunches`, the port allocator and the kill path.
- **The debugging port is opened only when something will drive it.** An
  always-on `--remote-debugging-port` is connectable by any local process and
  CDP attachment is observable from the page, so it is gated on a profile
  actually having an automation attached.
- **No `--remote-allow-origins`.** Our clients connect from Node and send no
  `Origin`, which Chromium accepts. Passing `*` — which this used to do — let
  any web page in any browser on the machine drive an open profile.

The launch payload gains one optional argument (`startPage`) carrying the tiles
and the run token. It is still assembled in exactly one place,
`src/lib/launch.ts`.
