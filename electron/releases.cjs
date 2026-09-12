// Release history for both programs, for the changelog.
//
// The changelog used to read one field -- updateState.updateInfo.releaseNotes,
// the notes attached to an *available* update. So it was blank whenever you
// were up to date (the common case), blank in a dev run where the updater is
// disabled outright, said nothing about the version you are actually running,
// and had nothing at all for the browser. "No changelog loaded yet" was the
// only thing most people ever saw.
//
// AAAxis/scout-gate is public, so the release list needs no token. Launcher
// releases are tagged `v*`. The browser fork publishes to a separate repo
// (AAAxis/scout-browser) and doesn't create GitHub Releases at all today --
// it only uploads to R2 -- so `browser-v*` entries below stay empty until
// that changes.
//
// Everything here is best-effort and cached. A changelog is not worth an error
// state -- if GitHub is unreachable, or has rate-limited this IP, the last
// answer is served with the date it was fetched.

const fs = require('node:fs');
const path = require('node:path');

const RELEASES_URL = 'https://api.github.com/repos/AAAxis/scout-gate/releases?per_page=30';
const CACHE_FILE = 'release-notes.json';
// Long enough that opening the changelog repeatedly costs one request, short
// enough that a release published today shows up today.
const CACHE_TTL_MS = 60 * 60 * 1000;

function cachePath(userDataPath) {
  return path.join(userDataPath, CACHE_FILE);
}

function readCache(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(userDataPath), 'utf8'));
    if (parsed && Array.isArray(parsed.launcher) && Array.isArray(parsed.browser)) {
      return parsed;
    }
  } catch {
    // No cache, or an unreadable one. Same thing to the caller.
  }
  return null;
}

function writeCache(userDataPath, payload) {
  try {
    fs.writeFileSync(cachePath(userDataPath), JSON.stringify(payload));
  } catch {
    // Best effort. A cache that cannot be written just means the next open
    // asks GitHub again.
  }
}

// A release tag to the version the app knows.
//
//   v1.0.57                          -> 1.0.57
//   browser-v151.0.7906.0-mac-arm64  -> 151.0.7906.0
//
// The browser's platform key is stripped so one entry represents the build
// regardless of which platform's release row it came from -- otherwise a
// changelog would list the same build two or three times.
function versionFromTag(tag) {
  const raw = String(tag || '');
  if (raw.startsWith('browser-v')) {
    return raw.slice('browser-v'.length).replace(/-(mac|win|linux)-[a-z0-9_]+$/i, '');
  }
  return raw.replace(/^v/, '');
}

function toEntry(release) {
  return {
    tag: release.tag_name || '',
    version: versionFromTag(release.tag_name),
    name: release.name || '',
    // Releases published before body_path was wired into the workflow have an
    // empty body. The UI shows the version and date for those rather than
    // pretending there is text.
    notes: (release.body || '').trim(),
    publishedAt: release.published_at || release.created_at || '',
  };
}

// Turns the API response into the two lists the changelog renders. Split out
// from the fetch so it stays testable.
function partitionReleases(raw) {
  const releases = Array.isArray(raw) ? raw : [];
  const launcher = [];
  const browser = [];
  const seenBrowser = new Set();
  for (const release of releases) {
    if (!release || release.draft) {
      continue;
    }
    const tag = String(release.tag_name || '');
    if (tag.startsWith('browser-v')) {
      const entry = toEntry(release);
      // One row per build, not per platform. mac and Windows publish the same
      // version separately and would otherwise both appear.
      if (!seenBrowser.has(entry.version)) {
        seenBrowser.add(entry.version);
        browser.push(entry);
      }
    } else if (/^v\d/.test(tag)) {
      launcher.push(toEntry(release));
    }
  }
  return {launcher, browser};
}

// `downloadJson` is passed in rather than imported: main.cjs already owns one,
// and a second HTTPS path here would be a second thing to keep correct.
function createReleaseNotes({userDataPath, downloadJson}) {
  let inFlight = null;

  async function load({force = false} = {}) {
    const cached = readCache(userDataPath);
    const fresh = cached && Date.now() - (cached.fetchedAtMs || 0) < CACHE_TTL_MS;
    if (cached && fresh && !force) {
      return {...cached, stale: false};
    }
    // Collapse concurrent opens onto one request.
    if (!inFlight) {
      inFlight = (async () => {
        const partitioned = partitionReleases(await downloadJson(RELEASES_URL));
        const payload = {
          ...partitioned,
          fetchedAt: new Date().toISOString(),
          fetchedAtMs: Date.now(),
        };
        writeCache(userDataPath, payload);
        return payload;
      })().finally(() => {
        inFlight = null;
      });
    }
    try {
      return {...await inFlight, stale: false};
    } catch (error) {
      if (cached) {
        // Offline, or rate-limited. The history has not changed since it was
        // cached; say when that was and show it.
        return {...cached, stale: true};
      }
      return {
        launcher: [], browser: [], fetchedAt: '', stale: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {load};
}

module.exports = {createReleaseNotes, partitionReleases, versionFromTag};
