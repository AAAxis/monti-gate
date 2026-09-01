import type {
  MontiAutomation,
  MontiProfile,
  MontiProxy,
  AutomationRun,
  BuiltInExtensionToggles,
  RuntimeFingerprint,
  SharedExtension,
} from './types';
import type {
  AutomationStep, AutomationVars, RunLogEntry, RunTrigger,
} from './automations/types';
import type {RuntimeConnector} from './data/connectors';
import type {SessionField} from './lib/homePage';
import type {ThemePreference} from './theme';

export type ProxyConfig = {
  id?: string;
  host?: string;
  port?: number;
  type?: 'http' | 'socks5';
  username?: string;
  password?: string;
};

export type LaunchProfilePayload = {
  id: string;
  name: string;
  userDataDir: string;
  // The profile's colour, exactly as `profiles.color` stores it: one of the six
  // preset keys, or a custom hex. Not a browser argument -- on macOS the main
  // process picks the wrapper bundle's Dock icon from it, so an open session is
  // identifiable by the same colour its row carries in the table.
  color?: string | null;
  proxy?: ProxyConfig | null;
  // True only when the profile's proxy_mode is explicitly 'free_proxy':
  // bundles the FoxyWall Proxy extension as a fallback. Never set for
  // 'direct' (no proxy, no fallback extension either) or 'assigned' (a real
  // proxy is present in `proxy` instead).
  useFreeProxy?: boolean;
  extensionPaths?: string[];
  // Team-synced extensions (see SharedExtension in ./types) -- main.cjs
  // materializes each into a local cache (downloading from the Web Store or
  // Supabase Storage on first use) before launch.
  sharedExtensions?: SharedExtension[];
  commandLineSwitches?: string;
  // Full resolved fingerprint, keyed exactly like monti::Fingerprint's JSON
  // dict. electron/main.cjs resolves any proxy-derived fields still missing
  // (timezone/languages/lat-long) and serializes this into
  // --monti-fingerprint-json for the browser to apply before first navigation.
  runtimeFingerprint?: RuntimeFingerprint | null;
  startUrl?: string;
  homeHtml?: string;
  cookieImportPath?: string | null;
  cookieImportUrl?: string | null;
  cookieImportName?: string | null;
  // The org's on/off switches for the built-in "stock" extensions (Extensions
  // tab), passed through as one map rather than a boolean per extension: which
  // extensions exist, and what a missing value means for each, is
  // electron/built-in-extensions.cjs's business alone. Adding a fifth is a row
  // in that table, not another field here.
  builtInExtensions?: BuiltInExtensionToggles;
  // This launch's page credential and the loopback port to spend it on — the
  // same {port, token} embedded in homeHtml. Carried as a field too so
  // built-in-extensions.cjs can hand it to the cookie-manager extension
  // (monti-launch.json). Null when minting failed; the extension then shows
  // sync as unavailable rather than broken.
  startPage?: {port: number; token: string} | null;
  // Everything the browser's side panel shows about this session, resolved at
  // launch: who this profile is, what its proxy is doing, and what it may run.
  // built-in-extensions.cjs writes it beside the panel extension as
  // monti-session.json; the panel reads that file for its first paint.
  //
  // The proxy block is homeProxyStatus() output verbatim, the same object the
  // start page is built from, so the two surfaces cannot word one session two
  // different ways. Null when the launch could not mint a run token — the same
  // polarity as `startPage` above, and the panel's signal that this window was
  // not launched from the launcher.
  sessionPanel?: SessionPanelData | null;
};

// Passed unresolved on `theme` for the reason anonymousHomeHtml documents:
// 'system' has to stay 'system' so prefers-color-scheme keeps deciding inside
// the browser, a separate process on a machine whose appearance can change
// while a session is open.
export type SessionPanelData = {
  // No colour: a profile's colour is six theme-dependent token triples
  // (lib/profileColors.ts), and the panel would have to carry all thirty-six to
  // paint a 10px swatch correctly in both themes. The panel is inside the window
  // it describes, so the name is identification enough.
  profile: {id: string; name: string};
  theme: ThemePreference;
  proxy: {ok: boolean; title: string; detail: string; fields?: SessionField[]};
  recheckable: boolean;
  automations: Array<{id: string; name: string}>;
};

export type CookieFileSelection = {
  path: string;
  name?: string;
  count: number;
  base64?: string;
};

// `reason` is why the check failed, classified in main by classifyProxyFailure.
// `error` is already a sentence written for a person, so nothing has to switch on
// this to produce copy -- it is here so the UI can treat a credentials problem
// differently from a dead host (offer the credentials editor, say) without
// pattern-matching English.
export type ProxyFailureReason =
  | 'auth-required' | 'auth-rejected' | 'dns' | 'unreachable' | 'timeout'
  | 'lookup' | 'unknown';

export type ProxyCheckResult = {
  ok: boolean;
  ip?: string;
  country?: string;
  countryCode?: string;
  // Where the geolocation lookup placed the egress IP. `timezone` is validated
  // against ICU in the main process before it gets here, so an absent one means
  // "no provider gave a usable zone" rather than "not looked up".
  timezone?: string;
  city?: string;
  region?: string;
  latitude?: number;
  longitude?: number;
  pingMs?: number;
  reason?: ProxyFailureReason;
  error?: string;
};

export type UpdateState = {
  status:
    | 'disabled'
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  currentVersion: string;
  lastCheckedAt: string;
  updateInfo: {
    version: string;
    releaseName?: string;
    releaseDate?: string;
    releaseNotes?: string;
  } | null;
  progress: {
    percent: number;
    bytesPerSecond: number;
    transferred: number;
    total: number;
  } | null;
  downloaded: boolean;
  error: string | null;
  canCheck: boolean;
  provider: 'github' | 'generic' | 'disabled';
};

export type ResourceState = {
  browserStatus: 'idle' | 'checking' | 'downloading' | 'installing' | 'ready' | 'error';
  // The installed version, not the feed's. These were the same field until the
  // feed started carrying a real version -- it reported whatever the last
  // manifest said, which for months was the literal "1.0.0".
  browserVersion: string;
  browserPath: string;
  installedBuildId: string;
  installedVersion: string;
  installedAt: string;
  availableVersion: string;
  availableReleaseDate: string;
  availableSize: number;
  notes: string;
  lastCheckedAt: string;
  updateAvailable: boolean;
  progress: {
    percent: number;
    transferred: number;
    total: number;
  } | null;
  error: string | null;
};

export type ReleaseEntry = {
  tag: string;
  version: string;
  name: string;
  // Empty for releases published before the workflow started passing
  // body_path. The changelog shows version and date for those rather than a
  // blank panel.
  notes: string;
  publishedAt: string;
};

export type ReleaseNotes = {
  launcher: ReleaseEntry[];
  browser: ReleaseEntry[];
  fetchedAt: string;
  // Served from cache because GitHub could not be reached or rate-limited us.
  stale?: boolean;
  error?: string;
};

export type ApiState = {
  status: 'starting' | 'ready' | 'error';
  port: number;
  url: string;
  error: string | null;
};

export type LoginItemState = {
  openAtLogin: boolean;
  // False in a dev run (`npm run dev`), where the login item would point at the
  // Electron binary rather than at EasyDeck Launcher.
  packaged: boolean;
};

export type ApiKey = {
  id: string;
  name: string;
  tokenPreview: string;
  // null means every folder (full access); an array (possibly empty) is an
  // explicit allow-list of folder ids.
  folderScope: string[] | null;
  // Who created it. The key store is per-install, so this is the only thing
  // separating one signed-in account's keys from another's on a shared machine.
  ownerUserId: string | null;
  orgId: string | null;
  // Set only by the Integrations connect flow. A key created by hand on the API
  // tab has none, which is what stops a key merely *named* "Claude Code" from
  // reading as a live connection.
  integrationId: string | null;
  // Predates ownership being recorded: still listed so it can be revoked, never
  // counted as a connection.
  legacy: boolean;
  createdAt: string;
  lastUsedAt: string | null;
};

// What the target tool's config says right now, as opposed to what this app's
// key store says. Both have to agree before an integration is really connected
// -- a key can exist while the config entry has been deleted, and an entry can
// exist while pointing at something that no longer runs.
export type IntegrationStatus = {
  configPath: string | null;
  // The manual MCP cards have no config file for us to write; they
  // connect by showing the user a snippet instead.
  manual: boolean;
  // Whether the tool itself was found on this machine: an application bundle,
  // an executable, or a file only that tool writes -- never the config file
  // this app writes, and never the dot-directory holding it, which is what used
  // to make an uninstalled Cursor read as Connected.
  //
  // It gates what a card may claim, never whether you can connect: a false
  // negative would otherwise make a working install unconnectable.
  installed: boolean;
  // The exact path that proved it, so the UI can show a fact instead of making
  // a claim. Empty when nothing was found, and for the manual integrations.
  installedEvidence: string;
  hasEntry: boolean;
  // The entry names the server this build ships, rather than an older install's
  // path or the Python bridge that no longer exists.
  entryIsCurrent: boolean;
  stale: boolean;
  commandExists: boolean;
  apiReady: boolean;
};

// One row per thing that can independently be broken, so the dialog can say
// which step failed instead of one blended verdict.
export type IntegrationCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type IntegrationVerification = {
  ok: boolean;
  checks: IntegrationCheck[];
};

type MontiNative = {
  launchProfile(payload: LaunchProfilePayload, extraArgs?: string[]): Promise<{
    ok: boolean;
    pid?: number;
    appPath?: string;
    // Path to the per-profile wrapper .app that was actually spawned (see
    // electron/main.cjs's writeProfileLauncherApp) -- its Dock/Cmd+Tab name is
    // the profile's own name, since that identity comes from the bundle, not
    // from the shared EasyDeck Browser binary or any window title.
    launcherAppPath?: string;
    error?: string;
  }>;
  // Named, scoped keys enforced on every /v1/* request to the local
  // automation API (see AUTOMATION_KEYS_PATH in main.cjs). Raw token is only
  // ever returned from createApiKey, at creation time -- only its hash is
  // persisted, so it can't be recovered later.
  // Takes the signed-in user's id: the store is shared by every account that
  // has ever signed in on this machine, so the filtering has to happen here.
  listApiKeys?(ownerUserId: string | null): Promise<ApiKey[]>;
  createApiKey?(
    name: string,
    folderScope: string[] | null,
    meta?: {ownerUserId?: string | null; orgId?: string | null; integrationId?: string | null},
  ): Promise<ApiKey & {token: string}>;
  revokeApiKey?(id: string): Promise<{revoked: boolean}>;
  // Writes the MCP server registration directly into the target tool's own
  // config file (~/.claude.json, ~/.codex/config.toml, ...) instead of handing
  // back a snippet to copy/paste -- see electron/integrations.cjs for why
  // (every CLI-command form proved unreliable on Windows). What it points at is
  // the server bundled in this app, so connecting installs nothing.
  applyIntegrationConfig?(
    integrationId: string,
    token: string,
  ): Promise<{ok: boolean; path?: string; error?: string}>;
  // Reads the target tool's config back. Needed because applyIntegrationConfig
  // is fire-and-forget: nothing else notices if the user later edits or deletes
  // the block it wrote.
  integrationStatus?(integrationId: string): Promise<IntegrationStatus>;
  // Deletes the monti entry this app wrote. Pairs with revokeApiKey -- revoking
  // alone leaves the tool pointed at a dead token.
  removeIntegrationConfig?(integrationId: string): Promise<{ok: boolean; path?: string | null; error?: string}>;
  // Repoints a stale entry at this build's server, keeping the token already in
  // the file. needsKey means that token is gone or revoked, so the caller has
  // to run the normal connect flow (which needs an owner id only it knows).
  repairIntegration?(
    integrationId: string,
  ): Promise<{ok: boolean; path?: string; needsKey?: boolean; error?: string}>;
  // Actually starts what the config says to start and speaks MCP to it. The
  // only check that can tell a live integration from a dead one.
  verifyIntegration?(integrationId: string): Promise<IntegrationVerification>;
  // Which agent tools look present on this machine, in one call.
  detectIntegrations?(): Promise<Record<string, boolean>>;
  checkProxy?(proxy: ProxyConfig): Promise<ProxyCheckResult>;
  // How many elements a selector matches on a profile's open page. Read-only:
  // it evaluates querySelectorAll(...).length and nothing else, so the step
  // editor's Check button cannot submit the form it is describing.
  checkSelector?(profileId: string, selector: string): Promise<{
    ok: boolean;
    count?: number;
    // The profile is not open, which is a thing to say rather than an error.
    notRunning?: boolean;
    error?: string;
  }>;
  // Opens a page in the user's real browser. The main process only honours
  // https: URLs on hosts we own (plus localhost in dev), so a rejected URL
  // resolves false rather than throwing.
  openExternal?(url: string): Promise<boolean>;
  // Resolves a bookmark's favicon to a data: URI, fetched from the site itself
  // and cached on disk by host. Null when the site exposes no usable icon --
  // the bookmark card falls back to a letter monogram.
  bookmarkFavicon?(url: string): Promise<string | null>;
  // Keeps the native window chrome in step with the in-app theme, so the shell
  // does not paint light behind a dark renderer. Takes the preference, not the
  // resolved theme -- 'system' must stay 'system' in the main process or
  // prefers-color-scheme stops updating in the renderer.
  setTheme?(preference: 'system' | 'light' | 'dark'): Promise<boolean>;
  // Open-at-login, read from and written to the OS. `packaged` is false in a
  // dev run, where the entry would register the Electron binary rather than the
  // app, so Settings shows the row disabled instead of lying about it.
  getLoginItem?(): Promise<LoginItemState>;
  setLoginItem?(enabled: boolean): Promise<LoginItemState>;
  // Turns the renderer's profile-data root into the absolute path this process
  // will actually use. A relative root resolves against the app's userData
  // directory, which only the main process knows -- see resolveProfileUserDataDir
  // in electron/main.cjs.
  resolveProfileRoot?(root: string): Promise<{path: string; exists: boolean}>;
  revealPath?(target: string): Promise<{ok: boolean; error?: string}>;

  // ── automation runs ──────────────────────────────────────────────────────
  // The renderer owns the data and this process owns the session, so a run
  // starts by handing over a fully resolved automation plus a cdpUrl, and
  // progress comes back through onAutomationRunEvent.
  //
  // The renderer cannot allocate its own port (no node:net) and must not hold
  // the CDP socket (a closed window would abandon a browser mid-run), which is
  // what splits the work across this boundary at all.
  reserveCdpPort?(): Promise<number>;
  // Where a profile's debugging endpoint is, or null. Resolves from this
  // process's own launch record first and then from Chromium's
  // DevToolsActivePort file, so a session survives restarting the launcher.
  resolveProfileCdp?(profileId: string): Promise<{
    running: boolean;
    cdpUrl?: string;
    pid?: number | null;
    error?: string;
  }>;
  // A per-launch credential for the generated start page, which is a file://
  // document with no key of its own. It authorizes exactly two things: running
  // one of the listed automations against this profile on this port, and
  // re-checking this profile's assigned proxy. Nothing else.
  //
  // cdpPort is null on a launch with nothing to run -- there is no debugging
  // port on those, and the token is minted anyway so the page can still
  // re-check its proxy. An empty `automations` list matches no id, so such a
  // token can run nothing.
  //
  // `orgId` is the workspace the launch was composed under, stamped onto the
  // token so the cookie routes can resolve this profile against the org it
  // belongs to rather than whichever one is active when the request arrives.
  // It is never accepted from a request body -- see run-token.cjs's mint().
  mintRunToken?(
    profileId: string,
    profileName: string,
    orgId: string,
    cdpPort: number | null,
    automations: Array<{id: string; name: string; steps: unknown[]}>,
  ): Promise<string>;
  // Waits for a port this process handed out to start answering. The on-launch
  // trigger needs it: the browser takes a moment to bind the port after being
  // spawned with it, so resolving immediately would report "not open" for a
  // window that is opening.
  waitForCdp?(port: number, timeoutMs?: number): Promise<{
    ok: boolean;
    cdpUrl?: string;
    error?: string;
  }>;
  // Returns as soon as the run is registered, NOT when it finishes: a real run
  // is minutes long, so anything that awaited completion would look like a hang.
  startAutomationRun?(payload: {
    automation: MontiAutomation;
    profile: MontiProfile;
    trigger: RunTrigger;
    cdpUrl: string;
    vars?: AutomationVars;
    // calleeId -> steps for every callAutomation in the tree, resolved by the
    // renderer (resolveCallTree) -- main has no automation catalogue.
    resolvedAutomations?: Record<string, AutomationStep[]>;
    // Variable names to mask in the run's log and sealed record: the `secret`
    // parameters of the root automation and of every callee. Collected by the
    // renderer for the same reason resolvedAutomations is -- main holds no
    // catalogue, so it cannot see a callee's declarations to work them out.
    secretVarNames?: string[];
    // True when this run had to launch the profile, false when it attached to a
    // window that was already open. The main process will only honour the
    // automation's close_on_finish for the first kind -- see the handler in
    // main.cjs. Only startRun can answer it, which is why it is sent rather
    // than worked out over there.
    ownsSession?: boolean;
  }): Promise<{ok: boolean; runId?: string; error?: string; status?: number}>;
  // Hands the workspace's connectors to the main process, which is the only
  // side that can make an outbound call. One way, and memory-only over there
  // -- see electron/automation/connectors.cjs. Called on every change,
  // including the change to an empty list.
  setConnectors?(connectors: RuntimeConnector[]): Promise<{ok: boolean}>;
  // The Test button. Takes a resolved connector rather than an id so an
  // unsaved draft can be tried before it is written. For an AI connector this
  // is one tiny completion; for a messaging one it sends a real test message.
  testConnector?(connector: RuntimeConnector): Promise<{ok: boolean; error?: string}>;
  // The notification bot. Linking watches the bot's getUpdates feed for the
  // deep-link code (the bot has no webhook); sending is the standard Telegram
  // adapter against the member's own chat. Both outbound calls live in main.
  // `welcome` is the reply the bot sends into the chat once Start lands --
  // composed renderer-side, because which workspaces will message this chat is
  // something only the renderer knows.
  telegramLinkPoll?(token: string, code: string, welcome?: string):
    Promise<{ok: boolean; chatId?: string; username?: string | null; error?: string}>;
  // `parseMode` is Telegram's rich text switch. 'HTML' means `text` is markup
  // whose every interpolated value has already been escaped; main falls back
  // to sending it unformatted if Telegram refuses to parse it.
  telegramSend?(token: string, chatId: string, text: string, parseMode?: 'HTML'):
    Promise<{ok: boolean; error?: string}>;
  // What models an AI connector's endpoint serves, so the form offers a real
  // choice. Takes the resolved draft, key included, like testConnector.
  listConnectorModels?(connector: RuntimeConnector):
    Promise<{ok: boolean; models?: string[]; error?: string}>;
  cancelAutomationRun?(runId: string): Promise<{ok: boolean}>;
  // Runs in flight right now, so a window that reopens mid-run rejoins it
  // rather than showing nothing.
  activeAutomationRuns?(): Promise<AutomationRun[]>;
  readRunScreenshot?(runId: string, name: string): Promise<string | null>;
  // The crash buffer: runs that reached a terminal status on disk but may never
  // have been written to Supabase, because the window was closed or the user
  // was signed out when they finished.
  pendingAutomationRuns?(): Promise<AutomationRun[]>;
  markAutomationRunFlushed?(runId: string): Promise<{ok: boolean}>;
  onAutomationRunEvent?(
    callback: (event:
      | {type: 'started'; runId: string; run: AutomationRun}
      | {type: 'log'; runId: string; entry: RunLogEntry}
      // `notification` rides along when the automation's notify-on-finish
      // setting fired: main composed it off the sealed record, and the
      // renderer writes it to the `notifications` table (this side of the
      // boundary is the one with Supabase).
      | {type: 'finished'; runId: string; run: AutomationRun; notification?: {
          kind: string;
          title: string;
          body: string;
          status?: string | null;
          automation_id?: string | null;
          run_id?: string | null;
          sendError?: string | null;
        };}) => void,
  ): () => void;

  // monti:// deep links. `auth` carries the PKCE authorization code back from
  // Google-via-Supabase; `open` just means "focus the app" and carries nothing.
  // Call deepLinkReady() after subscribing -- links that arrived during a cold
  // start are queued in the main process and replayed on that signal.
  onDeepLink?(
    callback: (payload: {action: 'auth'; code?: string; error?: string} | {action: 'open'}) => void,
  ): () => void;
  deepLinkReady?(): Promise<boolean>;
  getUpdateStatus?(): Promise<UpdateState>;
  getReleaseNotes?(options?: {force?: boolean}): Promise<ReleaseNotes>;
  runningSessionCount?(): Promise<number>;
  checkForUpdates?(): Promise<UpdateState>;
  downloadUpdate?(): Promise<UpdateState>;
  installUpdate?(): Promise<{ok: boolean; error?: string}>;
  onUpdateState?(callback: (state: UpdateState) => void): () => void;
  getResourceStatus?(): Promise<ResourceState>;
  checkBrowserResource?(): Promise<ResourceState>;
  downloadBrowserResource?(): Promise<ResourceState>;
  onResourceState?(callback: (state: ResourceState) => void): () => void;
  getApiStatus?(): Promise<ApiState>;
  onApiState?(callback: (state: ApiState) => void): () => void;
  selectExtensionFolder?(): Promise<string | null>;
  zipExtensionFolder?(folderPath: string): Promise<{ok: boolean; base64?: string; error?: string}>;
  // Downloads a built-in whose files are not vendored in extensions/ (currently
  // CaptchaPlugin alone, ~56 MB). Resolves {ok:false} instead of throwing so the
  // caller can leave the org's toggle off and surface the reason.
  installBuiltInExtension?(
    key: keyof BuiltInExtensionToggles,
  ): Promise<{ok: boolean; error?: string; alreadyInstalled?: boolean}>;
  // Which of those this machine has on disk. The toggle is org-wide but the
  // bytes are local, so a card needs both to know what to offer.
  builtInExtensionStatus?(): Promise<{installed: Partial<Record<string, boolean>>}>;
  // Picks up anything a teammate enabled on their own machine.
  catchUpBuiltInExtensions?(toggles: BuiltInExtensionToggles | undefined): Promise<{ok: boolean}>;
  onBuiltInDownloadProgress?(
    callback: (payload: {key: string; receivedBytes: number; totalBytes: number}) => void,
  ): () => void;
  selectCookieFile?(): Promise<CookieFileSelection | null>;
  // Several at once, for the cookie import dialog. Null when the picker was
  // cancelled; never an empty array.
  selectCookieFiles?(): Promise<CookieFileSelection[] | null>;
  selectCookieFolder?(): Promise<string | null>;
  matchCookieFiles?(
    folderPath: string,
    profileNames: string[],
  ): Promise<Record<string, CookieFileSelection | null>>;
  saveTextFile?(defaultName: string, content: string): Promise<string | null>;
  selectImportCsv?(): Promise<{path: string; content: string} | null>;
  // Raw text of a proxy list file (.txt/.csv/.list); parsed by lib/proxies.ts.
  selectProxyFile?(): Promise<{path: string; content: string} | null>;
  // Raw text of a browser's exported bookmarks (Netscape bookmark HTML);
  // parsed by lib/bookmarkImport.ts.
  selectBookmarkFile?(): Promise<{path: string; content: string} | null>;
  // Local automation API (POST http://127.0.0.1:39219/v1/cookies/bulk-match)
  // support: main.cjs forwards a bulk cookie-match request here so it can run
  // against the signed-in renderer's cloud state, then reports the result
  // back over sendBulkMatchCookiesResult so the HTTP caller gets a response.
  onBulkMatchCookiesRequest?(
    callback: (payload: {requestId: string; folderPath: string; profileIds: string[] | null}) => void,
  ): () => void;
  sendBulkMatchCookiesResult?(
    requestId: string,
    result?: {matched: number; total: number},
    error?: string,
  ): void;
  onPushLocalCookiesRequest?(
    callback: (payload: {requestId: string; profileId: string; profileName: string; cookies: unknown[]}) => void,
  ): () => void;
  sendPushLocalCookiesResult?(
    requestId: string,
    result?: {matched: boolean; count: number},
    error?: string,
  ): void;
  // `orgId` is the workspace the run token was minted under, forwarded off the
  // token entry by main.cjs. Empty for a token minted before it was carried, so
  // the handler treats absence as "the active workspace" and behaves as before.
  //
  // The six page-route pairs below take a fourth `status` argument the rest do
  // not. Their callers act on the code -- 409 means "switch workspace back",
  // 403 means "not in this workspace", 500 means the launcher broke -- and
  // without it every refusal reached the panel as a 500. main.cjs defaults a
  // missing status to 500, so it stays optional.
  onCookieSyncPushRequest?(
    callback: (
      payload: {
        requestId: string; profileId: string; orgId?: string;
        cookies: unknown[]; saveAs?: string; saveToSetId?: string;
      },
    ) => void,
  ): () => void;
  sendCookieSyncPushResult?(
    requestId: string,
    result?: {saved: number; set?: string},
    error?: string,
    status?: number,
  ): void;
  // `setId` picks a set this profile is not assigned to. Optional: absent means
  // the assigned set, which is what every caller before the panel's picker did.
  onCookieSyncPullRequest?(
    callback: (payload: {
      requestId: string; profileId: string; orgId?: string; setId?: string;
    }) => void,
  ): () => void;
  // Read-only inspection: what the launcher holds for this profile, without
  // applying it. Metadata only -- see the handler for why `value` is not here.
  onCookieListRequest?(
    callback: (payload: {
      requestId: string; profileId: string; orgId?: string; setId?: string;
    }) => void,
  ): () => void;
  sendCookieListResult?(
    requestId: string,
    result?: {
      set: string | null;
      setId: string | null;
      count: number;
      cookies: Array<{
        domain: string; name: string; path: string;
        secure: boolean; httpOnly: boolean; sameSite: string;
        expires: number | null;
      }>;
    },
    error?: string,
    status?: number,
  ): void;
  sendCookieSyncPullResult?(
    requestId: string,
    result?: {
      cookies: unknown[]; set: string | null; setId: string | null; assigned: boolean;
    },
    error?: string,
    status?: number,
  ): void;
  // Every cookie set in the launch's workspace, metadata only, so the panel can
  // offer a picker rather than one "Load from Launcher" button.
  onCookieSetsRequest?(
    callback: (payload: {requestId: string; profileId: string; orgId?: string}) => void,
  ): () => void;
  sendCookieSetsResult?(
    requestId: string,
    result?: {
      assignedId: string | null;
      sets: Array<{
        id: string; name: string; count: number;
        folder_id: string | null; tags: string[]; updated_at: string;
      }>;
    },
    error?: string,
    status?: number,
  ): void;
  // Every automation in the launch's workspace, for the panel's list.
  //
  // No `steps`, no `variables`, no `parameters`: steps carry selectors, urls
  // and typed values, and parameters can carry resolved secrets. This payload
  // lands in a document that goes on to visit arbitrary sites.
  onPanelAutomationsRequest?(
    callback: (payload: {requestId: string; profileId: string; orgId?: string}) => void,
  ): () => void;
  sendPanelAutomationsResult?(
    requestId: string,
    result?: {
      automations: Array<{
        id: string; name: string; description: string;
        pinned: boolean; assigned: boolean;
        icon: string; color: string;
      }>;
    },
    error?: string,
    status?: number,
  ): void;
  // Resolves one workspace automation into a runnable tile -- steps, called
  // automations, variables and the names of the secret ones -- for a panel run
  // of a workflow this launch was not handed. The answer goes to the main
  // process and the runner, never to the panel.
  onPanelResolveAutomationRequest?(
    callback: (payload: {
      requestId: string; profileId: string; orgId?: string; automationId: string;
    }) => void,
  ): () => void;
  sendPanelResolveAutomationResult?(
    requestId: string,
    result?: {
      automation: Record<string, unknown>;
      resolvedAutomations?: Record<string, unknown>;
      vars?: Record<string, unknown>;
      secretVarNames?: string[];
      paramsBlocked?: string;
    },
    error?: string,
    status?: number,
  ): void;
  onReimportProxiesRequest?(
    callback: (payload: {requestId: string; proxies: Array<Record<string, unknown>>}) => void,
  ): () => void;
  sendReimportProxiesResult?(
    requestId: string,
    result?: {updated: number; created: number; total: number},
    error?: string,
  ): void;
  onAssignProfileProxyRequest?(
    callback: (payload: {
      requestId: string;
      profileId: string;
      proxyId?: string;
      proxyHost?: string;
      proxyPort?: number;
      allowedFolders: string[] | null;
    }) => void,
  ): () => void;
  sendAssignProfileProxyResult?(
    requestId: string,
    result?: {matched: boolean; profileId: string; proxyId?: string},
    error?: string,
  ): void;
  // POST /v1/profiles/get: full profile detail by id, including credentials --
  // deliberately separate from the bulk list-profiles endpoint (which only
  // returns id+name) so a broad "list all profiles" call never bulk-exposes
  // every stored password at once.
  onGetProfileRequest?(
    callback: (payload: {requestId: string; profileId: string; allowedFolders: string[] | null}) => void,
  ): () => void;
  sendGetProfileResult?(
    requestId: string,
    result?: {profile: MontiProfile | null},
    error?: string,
  ): void;
  // GET /v1/proxies: full proxy list, each annotated with which profiles
  // currently use it -- lets an MCP-driven agent find an unassigned proxy
  // to swap in without cross-referencing list_profiles itself.
  onListProxiesRequest?(
    callback: (payload: {requestId: string}) => void,
  ): () => void;
  sendListProxiesResult?(
    requestId: string,
    result?: {proxies: Array<MontiProxy & {assignedProfileIds: string[]}>},
    error?: string,
  ): void;
  // POST /v1/proxies/create
  onCreateProxyRequest?(
    callback: (payload: {
      requestId: string;
      name: string;
      type: 'http' | 'socks5';
      host: string;
      port: number;
      username?: string;
      password?: string;
    }) => void,
  ): () => void;
  sendCreateProxyResult?(
    requestId: string,
    result?: {proxyId: string},
    error?: string,
  ): void;
  // POST /v1/proxies/update: partial field patch, same shape as update-profile.
  onUpdateProxyRequest?(
    callback: (payload: {
      requestId: string;
      proxyId: string;
      fields: Partial<Pick<MontiProxy, 'name' | 'type' | 'host' | 'port' | 'username' | 'password'>>;
    }) => void,
  ): () => void;
  sendUpdateProxyResult?(
    requestId: string,
    result?: {matched: boolean},
    error?: string,
  ): void;
  // POST /v1/proxies/delete: also unassigns (sets proxy_id null) any profile
  // currently using this proxy, so no profile is left pointing at a proxy_id
  // that no longer exists.
  onDeleteProxyRequest?(
    callback: (payload: {requestId: string; proxyId: string}) => void,
  ): () => void;
  sendDeleteProxyResult?(
    requestId: string,
    result?: {deleted: boolean; unassignedProfileIds: string[]},
    error?: string,
  ): void;
  // POST /v1/profiles/update: partial field patch
  // (name/tags/status/color/avatar/folder_id/email/password, plus
  // proxy_mode/start_url/automation_id). `avatar` is narrowed to `brand:<slug>`
  // or '' in main.cjs -- the https-URL half of the field is the editor's only,
  // so a key cannot make the launcher fetch a picture from a host of the
  // caller's choosing. proxy_mode/start_url/automation_id are the fields whose
  // value-dependent checks (a proxy must exist before 'assigned'; an automation
  // id must resolve) the renderer does, because main.cjs owns no data.
  // Bare proxy_id assignment stays with assign-proxy, which resolves against
  // the library, and fingerprint has its own endpoint (update-fingerprint,
  // below) since it merges a nested object.
  onUpdateProfileRequest?(
    callback: (payload: {
      requestId: string;
      profileId: string;
      fields: Partial<Pick<MontiProfile,
        'name' | 'tags' | 'status' | 'color' | 'avatar' | 'folder_id' | 'email' | 'password' |
        'login_url' | 'proxy_mode' | 'proxy_id' | 'start_url' | 'automation_id'>>;
      // null grants every folder; an array is the allow-list this key may
      // write to. Both ends of a folder move are checked against it.
      allowedFolders: string[] | null;
    }) => void,
  ): () => void;
  sendUpdateProfileResult?(
    requestId: string,
    result?: {matched: boolean; profileId: string},
    error?: string,
  ): void;
  // POST /v1/profiles/delete: soft-deletes (moves to Trash, same as the
  // Delete button in the UI) unless permanent is true. allowedFolders scopes
  // which profiles a folder-restricted key may delete, same as get/launch.
  onDeleteProfileRequest?(
    callback: (payload: {
      requestId: string;
      profileId: string;
      permanent: boolean;
      allowedFolders: string[] | null;
    }) => void,
  ): () => void;
  sendDeleteProfileResult?(
    requestId: string,
    result?: {deleted: boolean; permanent: boolean},
    error?: string,
  ): void;
  // POST /v1/profiles/update-fingerprint: merges the given fields into the
  // profile's existing fingerprint object rather than replacing it wholesale.
  onUpdateFingerprintRequest?(
    callback: (payload: {
      requestId: string;
      profileId: string;
      fingerprint: Record<string, unknown>;
      allowedFolders: string[] | null;
    }) => void,
  ): () => void;
  sendUpdateFingerprintResult?(
    requestId: string,
    result?: {matched: boolean; profileId: string},
    error?: string,
  ): void;
  // POST /v1/profiles/launch-automation: main.cjs already chose a free CDP
  // port before forwarding this -- the renderer's job is only to resolve the
  // profileId against cloud state and launch it, same as a manual Launch
  // click, just with --remote-debugging-port appended and no interactive
  // proxy-check/error-dialog UI (main process's spawnProfileUnchecked is the
  // authoritative proxy gate either way).
  onLaunchAutomationRequest?(
    callback: (payload: {
      requestId: string;
      profileId: string;
      cdpPort: number;
      // null = the calling key has full access; an array is the folder
      // allow-list it was scoped to when created/approved.
      allowedFolders: string[] | null;
    }) => void,
  ): () => void;
  sendLaunchAutomationResult?(
    requestId: string,
    result?: {ok: boolean; pid?: number; error?: string},
    error?: string,
  ): void;
  // The shared pair for routes declared in electron/api/routes.json, in place
  // of a named on*/send* pair each. `channel` is checked against the table in
  // preload before anything is subscribed, so an unknown name is inert rather
  // than a way to listen in on every other channel.
  //
  // The payload is deliberately loose here: main.cjs has already checked it
  // against the route's declared fields, and each handler in
  // useAutomationBridge narrows it to the shape that route sends.
  onApiRequest?(
    channel: string,
    callback: (payload: never) => void,
  ): () => void;
  sendApiResult?(
    requestId: string,
    result?: unknown,
    error?: string,
    // The HTTP code to answer with. Omitted means 500.
    status?: number,
  ): void;
  onListProfilesRequest?(
    callback: (payload: {requestId: string; folder: string | null; allowedFolders: string[] | null}) => void,
  ): () => void;
  sendListProfilesResult?(
    requestId: string,
    result?: {profiles: Array<{id: string; name: string}>},
    error?: string,
  ): void;
  onMonitoringReportRequest?(
    callback: (payload: {
      requestId: string;
      runId: string;
      profileId: string;
      ok: boolean;
      detail: string;
      screenshotBase64: string | null;
    }) => void,
  ): () => void;
  sendMonitoringReportResult?(requestId: string, result?: {ok: true}, error?: string): void;
  // Loopback "Connect" flow (GET /v1/oauth/authorize): an external app
  // (e.g. an external MCP client) opens that URL in a real browser; this fires so the
  // renderer can show an approve/deny dialog, then reports back which
  // folders to actually grant (defaulting to what the caller requested, but
  // the human approving can narrow it).
  onOAuthAuthorizeRequest?(
    callback: (payload: {requestId: string; clientName: string; requestedScope: string}) => void,
  ): () => void;
  sendOAuthAuthorizeResult?(
    requestId: string,
    approved: boolean,
    folderScope: string[] | null,
    keyName: string,
  ): void;
  // POST /v1/proxies/recheck-from-page: a launch's start page asking for its
  // own proxy line to be brought up to date. main.cjs has already verified the
  // run token and takes profileId off that token's entry, so nothing the page
  // sent chooses which proxy is tested. The answer is the panel's next three
  // fields, composed by homeProxyStatus -- the same function that wrote the
  // wording the page launched with.
  onRecheckProxyRequest?(
    callback: (payload: {requestId: string; profileId: string}) => void,
  ): () => void;
  sendRecheckProxyResult?(
    requestId: string,
    result?: {proxyOk: boolean; title: string; detail: string},
    error?: string,
  ): void;
  // POST /v1/automations/open-in-launcher: a launch's start page or side panel
  // asking for one of its own automations to be opened here. One-way -- main has
  // already raised the window, so there is nothing to answer and nothing the
  // caller could show if this never arrived.
  //
  // A non-null `automationId` came off the run token's entry check, not off the
  // request body, so it names a workflow this launch was already offering.
  //
  // Null means the caller named none: "the Automations tab for this profile",
  // which is what the side panel offers a launch with nothing attached to run.
  // The handler resolves that to the same place a since-deleted workflow does.
  onOpenAutomationRequest?(
    callback: (payload: {automationId: string | null; profileId: string}) => void,
  ): () => void;
};

declare global {
  interface Window {
    montiNative?: MontiNative;
  }
}

export const native = window.montiNative;
