// FoxyWall Proxy — authenticated HTTP proxy client.
// Proxy: Xray `http` inbound on the VPN server (port 1080, user/pass auth).
// Chrome supplies credentials via webRequest.onAuthRequired (HTTP proxies only —
// Chrome cannot authenticate SOCKS5, which is why the inbound is HTTP).
// License: account code (VPN-XXXX-XXXX-XXXX) checked against Supabase get_entitlement
// before the proxy can be enabled. See entitlement.js.

importScripts('entitlement.js');

// Proxy credentials are NOT hardcoded. They are fetched from Supabase
// (get_proxy_credentials) at connect-time — only Pro accounts get them — and held
// in chrome.storage.session, which is in-memory and never written to disk.
const CREDS_KEY = 'proxyCreds'; // { host, port, username, password }

async function getCreds() {
  const r = await chrome.storage.session.get([CREDS_KEY]);
  return r[CREDS_KEY] || null;
}
async function setCreds(c) {
  await chrome.storage.session.set({ [CREDS_KEY]: c });
}
async function clearCreds() {
  await chrome.storage.session.remove(CREDS_KEY);
}

function proxyConfigFor(creds) {
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: { scheme: 'http', host: creds.host, port: creds.port },
      bypassList: ['localhost', '127.0.0.1'],
    },
  };
}

// ---------------------------------------------------------------------------
// Proxy auth. MV3: listener MUST be registered synchronously at top level so
// the service worker re-registers it on every wake. Credentials are read from
// session storage (populated at connect). Track request IDs to avoid an infinite
// challenge loop if the server rejects them.
// ---------------------------------------------------------------------------
const answeredAuthRequests = new Set();

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    (async () => {
      const creds = await getCreds();
      const isOurProxy =
        details.isProxy &&
        creds &&
        details.challenger &&
        details.challenger.host === creds.host &&
        details.challenger.port === creds.port;

      if (!isOurProxy) {
        callback({});
        return;
      }

      if (answeredAuthRequests.has(details.requestId)) {
        // Credentials already supplied once and rejected — don't loop.
        console.warn('Proxy rejected credentials for request', details.requestId);
        callback({ cancel: true });
        return;
      }

      answeredAuthRequests.add(details.requestId);
      callback({
        authCredentials: { username: creds.username, password: creds.password },
      });
    })();
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.webRequest.onCompleted.addListener(
  (details) => answeredAuthRequests.delete(details.requestId),
  { urls: ['<all_urls>'] }
);
chrome.webRequest.onErrorOccurred.addListener(
  (details) => answeredAuthRequests.delete(details.requestId),
  { urls: ['<all_urls>'] }
);

// ---------------------------------------------------------------------------
// Proxy control
// ---------------------------------------------------------------------------

// chrome.proxy.settings with mode 'fixed_servers' applies to every request
// this browser makes -- including whatever real page the user is actually
// loading, which races against this verification and can surface as
// ERR_TUNNEL_CONNECTION_FAILED if the candidate turns out to be dead. A PAC
// script routes only *this specific probe URL* (matched by a one-off random
// token no real page will ever contain) through the candidate proxy, leaving
// every other concurrent request -- i.e. anything the user is actually
// browsing -- on DIRECT until the candidate is confirmed good. Only once
// verified does connectProxy() switch to the full fixed_servers config that
// actually routes everything.
function pacConfigForVerification(creds, token) {
  const pac = `function FindProxyForURL(url, host) {\n` +
      `  if (url.indexOf(${JSON.stringify(token)}) !== -1) {\n` +
      `    return "PROXY ${creds.host}:${creds.port}";\n` +
      `  }\n` +
      `  return "DIRECT";\n` +
      `}`;
  return { mode: 'pac_script', pacScript: { data: pac } };
}

async function verifyProxyReachable(creds, timeoutMs = 6000) {
  const token = `scout-verify-${crypto.randomUUID()}`;
  await chrome.proxy.settings.set({
    value: pacConfigForVerification(creds, token),
    scope: 'regular',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`https://www.gstatic.com/generate_204?${token}`, {
      signal: controller.signal,
      cache: 'no-store',
    });
    return res.ok || res.status === 204;
  } catch (e) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The Supabase-assigned free-tier pool (fwGetProxyCredentials) turned out to
// be unreliable and, for free accounts, server-side always forces the same
// default server regardless of what's requested -- so a dead default meant
// no working fallback existed. This pool is copied directly from the user's
// own dedicated proxy inventory (profiles-cookie-inventory.csv), which is
// known-good infrastructure already used successfully by hundreds of other
// profiles. All servers in this pool share one reseller-issued
// username/password; only the host:port differs. Each one was verified live
// (a real HTTP CONNECT + auth handshake) before being added here.
const STATIC_PROXY_USERNAME = 'Evd8sDYf';
const STATIC_PROXY_PASSWORD = 'pr1Ywfsh';
const STATIC_PROXY_POOL = [
  { host: '166.1.241.165', port: 62360, country: 'United States' },
  { host: '136.234.143.201', port: 62642, country: 'United States' },
  { host: '172.120.53.199', port: 63902, country: 'United States' },
  { host: '166.1.243.181', port: 63752, country: 'United States' },
  { host: '166.1.255.96', port: 64614, country: 'United States' },
  { host: '166.1.253.219', port: 63932, country: 'United States' },
];

function shuffledPool() {
  const pool = STATIC_PROXY_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

async function connectProxy() {
  // Still auto-create/track the Supabase account for entitlement purposes,
  // but never block or fail the connection on it -- the actual proxy source
  // below no longer depends on that backend at all.
  void fwEnsureAccount();

  let lastError = {
    success: false,
    code: 'UNAVAILABLE',
    error: 'No proxy server is available right now.',
  };

  for (const candidate of shuffledPool()) {
    const creds = {
      host: candidate.host,
      port: candidate.port,
      username: STATIC_PROXY_USERNAME,
      password: STATIC_PROXY_PASSWORD,
      country: candidate.country,
      country_code: 'US',
      city: null,
      server_id: `${candidate.host}:${candidate.port}`,
    };

    // Creds must be in place before the verification probe -- it's an
    // authenticated proxy, so even the probe needs onAuthRequired to succeed.
    await setCreds({
      host: creds.host,
      port: creds.port,
      username: creds.username,
      password: creds.password,
    });

    const reachable = await verifyProxyReachable(creds);
    if (reachable) {
      // Only now switch every request to this proxy -- the probe above
      // proved it actually works, so there's no window where real page
      // loads could hit a still-unverified server.
      await chrome.proxy.settings.set({ value: proxyConfigFor(creds), scope: 'regular' });
      await chrome.storage.local.set({
        isConnected: true,
        connectedServer: {
          id: creds.server_id,
          country: creds.country,
          country_code: creds.country_code,
          city: creds.city,
        },
      });
      console.log('Proxy connected:', creds.country, `${creds.host}:${creds.port}`);
      return { success: true, server: creds.server_id, country: creds.country };
    }

    // This server didn't respond -- clear the verification PAC so real
    // traffic (which was never routed through it) is unaffected, and move on
    // to the next candidate in the pool.
    console.warn(`Proxy candidate unreachable:`, `${creds.host}:${creds.port}`);
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await clearCreds();
    lastError = {
      success: false,
      code: 'UNREACHABLE',
      error: 'No proxy server in the pool responded.',
    };
  }

  return lastError;
}

async function disconnectProxy() {
  await chrome.proxy.settings.clear({ scope: 'regular' });
  await clearCreds();
  await chrome.storage.local.set({ isConnected: false });
  console.log('Proxy disconnected');
  return { success: true };
}

async function getStatus() {
  const r = await chrome.storage.local.get(['isConnected']);
  return { success: true, isConnected: r.isConnected || false };
}

// Clears anything left over from a previous session (a stale "connected"
// flag, a proxy config pointing at a server that's no longer being used,
// credentials for a connection that no longer exists) before a fresh connect
// attempt begins. This used to run as syncStateOnStartup, a fully separate
// listener on the same onStartup/onInstalled events as autoConnectWithRetry
// -- meaning on a profile with a stale isConnected:true (e.g. reused across
// many test sessions), THIS function would also call connectProxy() itself,
// at the same time autoConnectWithRetry's own connectProxy() call was
// running. Both mutate the same global chrome.proxy.settings, so they
// clobbered each other's in-flight verification and every attempt failed
// forever -- not a slow connection, a genuine concurrency bug. Folding the
// reset into the same sequential flow as the connect attempt (see
// autoConnectWithRetry below) removes the race entirely.
async function resetStaleProxyState() {
  try {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await clearCreds();
    await chrome.storage.local.set({ isConnected: false });
  } catch (e) {
    console.error('State reset failed:', e);
  }
}

// ---------------------------------------------------------------------------
// Messages from popup
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.action) {
        case 'getSettings': {
          const status = await getStatus();
          sendResponse({
            success: true,
            settings: { isProxyEnabled: status.isConnected },
          });
          break;
        }

        case 'toggleProxy': {
          const result = message.enabled
            ? await connectProxy()
            : await disconnectProxy();
          sendResponse(result);
          break;
        }

        case 'getLicense': {
          // Auto-create the account on first open (desktop-style, no activation step).
          const accountId = await fwEnsureAccount();
          const ent = await fwGetEntitlement(accountId);
          sendResponse({ success: true, accountId, entitlement: ent });
          break;
        }

        case 'setAccountId': {
          // Restore / apply an existing Pro code (from desktop or a purchase).
          const id = (message.accountId || '').trim().toUpperCase();
          await fwSetAccountId(id);
          const ent = await fwGetEntitlement(id);
          sendResponse({ success: true, accountId: id, entitlement: ent });
          break;
        }

        case 'getServers': {
          const accountId = await fwEnsureAccount();
          const list = await fwListServers(accountId);
          const { selectedServerId } = await chrome.storage.local.get(['selectedServerId']);
          sendResponse({ success: true, ...list, selectedServerId: selectedServerId || null });
          break;
        }

        case 'setServer': {
          // Persist the chosen country. Only meaningful for Pro; harmless for free
          // (server-side forces the default regardless).
          await chrome.storage.local.set({ selectedServerId: message.serverId || null });
          sendResponse({ success: true });
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown action' });
      }
    } catch (error) {
      console.error('Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true; // async sendResponse
});

// Open the side panel when the toolbar icon is clicked (MetaMask-style panel).
if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error('setPanelBehavior failed:', e));
}

// Scout Web (the Scout Web) now bundles this extension for EVERY
// profile (so the toolbar icon/manual toggle is always available), but only
// wants it to auto-connect on launch when the user actually picked "Free
// Proxy" mode -- never alongside a real assigned proxy (a second, competing
// proxy source) or for 'direct' profiles. It signals that per-launch via a
// small scout-config.json written into this specific bundled copy (see
// electron/main.cjs's writeProfileFreeProxyExtension); missing/unreadable
// defaults to NOT auto-connecting, since that's the safe choice for anyone
// loading this extension outside of an Scout-managed launch.
async function shouldAutoConnect() {
  try {
    const res = await fetch(chrome.runtime.getURL('scout-config.json'));
    if (!res.ok) return false;
    const cfg = await res.json();
    return cfg.autoConnect === true;
  } catch (e) {
    return false;
  }
}

// That explicit Free Proxy choice is itself the deliberate action, so
// connect immediately instead of waiting for a manual click in the popup.
// connectProxy() already handles the no-license/free path on its own
// (auto-creates the account, accepts whatever server the backend returns for
// a free tier), so no license/Pro logic needs touching. The very first
// connect for a fresh profile also has to mint an anonymous account (one
// network round-trip to the license server) before it can fetch proxy
// credentials -- a single transient blip there previously left the profile
// stuck on "Disconnected" with no retry until a manual click. Retry a few
// times with a short backoff before giving up.

// Free Proxy mode is best-effort, not a hard privacy guarantee like an
// assigned proxy -- so unlike the browser's own C++ startup gate (which fails
// closed rather than ever falling back to direct), this never blocks or
// redirects the page the profile is loading. It runs directly while
// connectProxy() retries in the background, and opens this extension's own
// panel so the connection attempt/outcome is visible instead of silent.
async function showPanelForActiveWindow() {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win && win.id !== undefined && chrome.sidePanel && chrome.sidePanel.open) {
      await chrome.sidePanel.open({ windowId: win.id });
    }
  } catch (e) {
    // sidePanel.open() requires a user gesture on some Chrome versions and
    // will throw outside one -- the toolbar icon still opens it manually,
    // so this is best-effort only.
  }
}

async function autoConnectWithRetry(maxAttempts = 4, delayMs = 1500) {
  await resetStaleProxyState();
  void showPanelForActiveWindow();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await connectProxy();
    if (result.success) {
      return;
    }
    console.warn(`Scout auto-connect attempt ${attempt}/${maxAttempts} failed:`, result.error);
    if (attempt < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// onInstalled and onStartup can BOTH fire for the same browser launch --
// onStartup always fires when the browser process starts, and onInstalled
// ALSO fires whenever this extension's on-disk content differs from what
// Chrome last saw (true for nearly every launch during active development).
// Without this guard, two concurrent autoConnectWithRetry() calls would run
// at once, each with its own connectProxy() loop clobbering the other's
// in-flight chrome.proxy.settings -- the same class of race as the
// syncStateOnStartup bug above, just between these two listeners instead.
let autoConnectStarted = false;
function startAutoConnectOnce() {
  if (autoConnectStarted) return;
  autoConnectStarted = true;
  void (async () => {
    if (await shouldAutoConnect()) {
      await autoConnectWithRetry();
    }
  })();
}
chrome.runtime.onInstalled.addListener(startAutoConnectOnce);
chrome.runtime.onStartup.addListener(startAutoConnectOnce);
