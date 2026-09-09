const {contextBridge, ipcRenderer} = require('electron');
const {routes: apiRoutes} = require('./api/routes.json');

// The channels a table-driven API route may use. An allow-list, not a
// pass-through: onApiRequest takes a channel name from the renderer, and a
// renderer that could name any channel could subscribe to every one of them.
const API_CHANNELS = new Set(
    apiRoutes.map((route) => route.channel).filter(Boolean));

contextBridge.exposeInMainWorld('scoutNative', {
  launchProfile: (payload, extraArgs) => ipcRenderer.invoke('scout:launch-profile', payload, extraArgs),
  listApiKeys: (ownerUserId) => ipcRenderer.invoke('scout:list-api-keys', ownerUserId),
  createApiKey: (name, folderScope, meta) =>
    ipcRenderer.invoke('scout:create-api-key', {name, folderScope, ...(meta || {})}),
  revokeApiKey: (id) => ipcRenderer.invoke('scout:revoke-api-key', id),
  applyIntegrationConfig: (integrationId, token) =>
    ipcRenderer.invoke('scout:apply-integration-config', {integrationId, token}),
  integrationStatus: (integrationId) =>
    ipcRenderer.invoke('scout:integration-status', {integrationId}),
  removeIntegrationConfig: (integrationId) =>
    ipcRenderer.invoke('scout:remove-integration-config', {integrationId}),
  repairIntegration: (integrationId) =>
    ipcRenderer.invoke('scout:repair-integration', {integrationId}),
  verifyIntegration: (integrationId) =>
    ipcRenderer.invoke('scout:verify-integration', {integrationId}),
  detectIntegrations: () => ipcRenderer.invoke('scout:detect-integrations'),
  checkProxy: (proxy) => ipcRenderer.invoke('scout:check-proxy', proxy),
  checkSelector: (profileId, selector) =>
    ipcRenderer.invoke('scout:check-selector', {profileId, selector}),
  openExternal: (url) => ipcRenderer.invoke('scout:open-external', url),
  bookmarkFavicon: (url) => ipcRenderer.invoke('scout:bookmark-favicon', url),
  setTheme: (preference) => ipcRenderer.invoke('scout:set-theme', preference),
  getLoginItem: () => ipcRenderer.invoke('scout:get-login-item'),
  setLoginItem: (enabled) => ipcRenderer.invoke('scout:set-login-item', enabled),
  resolveProfileRoot: (root) => ipcRenderer.invoke('scout:resolve-profile-root', root),
  revealPath: (target) => ipcRenderer.invoke('scout:reveal-path', target),

  // ── automation runs ──────────────────────────────────────────────────────
  // These are the runner's own IPC and deliberately do not go through the
  // HTTP-forwarding request/result pattern below: nothing here is answering a
  // loopback API call, so there is no requestId to match back.
  reserveCdpPort: () => ipcRenderer.invoke('scout:reserve-cdp-port'),
  resolveProfileCdp: (profileId) =>
    ipcRenderer.invoke('scout:resolve-profile-cdp', {profileId}),
  mintRunToken: (profileId, profileName, orgId, cdpPort, automations) =>
    ipcRenderer.invoke('scout:mint-run-token',
        {profileId, profileName, orgId, cdpPort, automations}),
  waitForCdp: (port, timeoutMs) =>
    ipcRenderer.invoke('scout:wait-for-cdp', {port, timeoutMs}),
  startAutomationRun: (payload) => ipcRenderer.invoke('scout:start-automation-run', payload),
  cancelAutomationRun: (runId) => ipcRenderer.invoke('scout:cancel-automation-run', {runId}),
  activeAutomationRuns: () => ipcRenderer.invoke('scout:active-automation-runs'),
  readRunScreenshot: (runId, name) =>
    ipcRenderer.invoke('scout:read-run-screenshot', {runId, name}),
  pendingAutomationRuns: () => ipcRenderer.invoke('scout:pending-automation-runs'),
  markAutomationRunFlushed: (runId) =>
    ipcRenderer.invoke('scout:mark-automation-run-flushed', {runId}),
  onAutomationRunEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:automation-run-event', listener);
    return () => ipcRenderer.removeListener('scout:automation-run-event', listener);
  },

  // ── Connectors ───────────────────────────────────────────────────────────
  // One way, renderer to main. The renderer reads `connectors` from Supabase --
  // this process holds no Supabase credentials and must not start -- and hands
  // the resolved list over so an AI or notify step can make its outbound call.
  // Held in memory over there and never written to disk.
  setConnectors: (connectors) => ipcRenderer.invoke('scout:set-connectors', {connectors}),
  // The Test button: the smallest real thing the service allows -- one tiny
  // completion for an AI connector, one real message for a messaging one.
  // Takes the config directly rather than an id so an unsaved edit can be
  // tried before it is written.
  testConnector: (connector) => ipcRenderer.invoke('scout:test-connector', {connector}),
  telegramLinkPoll: (token, code, welcome) =>
    ipcRenderer.invoke('scout:telegram-link-poll', {token, code, welcome}),
  // `parseMode` is Telegram's rich text switch -- 'HTML' for the marked-up
  // run summaries, absent for anything composed as plain text.
  telegramSend: (token, chatId, text, parseMode) =>
    ipcRenderer.invoke('scout:telegram-send', {token, chatId, text, parseMode}),
  // The endpoint's own model listing, for the form's model picker. Draft in,
  // like testConnector, so an unsaved key can prove itself.
  listConnectorModels: (connector) =>
    ipcRenderer.invoke('scout:list-connector-models', {connector}),
  onDeepLink: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:deep-link', listener);
    return () => ipcRenderer.removeListener('scout:deep-link', listener);
  },
  deepLinkReady: () => ipcRenderer.invoke('scout:deep-link-ready'),
  getUpdateStatus: () => ipcRenderer.invoke('scout:update-status'),
  getReleaseNotes: (options) => ipcRenderer.invoke('scout:release-notes', options || {}),
  runningSessionCount: () => ipcRenderer.invoke('scout:running-session-count'),
  checkForUpdates: () => ipcRenderer.invoke('scout:check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('scout:download-update'),
  installUpdate: () => ipcRenderer.invoke('scout:install-update'),
  onUpdateState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:update-state', listener);
    return () => ipcRenderer.removeListener('scout:update-state', listener);
  },
  getResourceStatus: () => ipcRenderer.invoke('scout:resource-status'),
  checkBrowserResource: () => ipcRenderer.invoke('scout:check-browser-resource'),
  downloadBrowserResource: () => ipcRenderer.invoke('scout:download-browser-resource'),
  onResourceState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:resource-state', listener);
    return () => ipcRenderer.removeListener('scout:resource-state', listener);
  },
  getApiStatus: () => ipcRenderer.invoke('scout:api-status'),
  onApiState: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:api-state', listener);
    return () => ipcRenderer.removeListener('scout:api-state', listener);
  },
  selectExtensionFolder: () => ipcRenderer.invoke('scout:select-extension-folder'),
  zipExtensionFolder: (folderPath) => ipcRenderer.invoke('scout:zip-extension-folder', folderPath),
  installBuiltInExtension: (key) =>
    ipcRenderer.invoke('scout:install-built-in-extension', {key}),
  builtInExtensionStatus: () => ipcRenderer.invoke('scout:built-in-extension-status'),
  catchUpBuiltInExtensions: (toggles) =>
    ipcRenderer.invoke('scout:catch-up-built-in-extensions', {toggles}),
  onBuiltInDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:built-in-download-progress', listener);
    return () => ipcRenderer.removeListener('scout:built-in-download-progress', listener);
  },
  selectCookieFile: () => ipcRenderer.invoke('scout:select-cookie-file'),
  selectCookieFiles: () => ipcRenderer.invoke('scout:select-cookie-files'),
  selectCookieFolder: () => ipcRenderer.invoke('scout:select-cookie-folder'),
  matchCookieFiles: (folderPath, profileNames) =>
    ipcRenderer.invoke('scout:match-cookie-files', {folderPath, profileNames}),
  saveTextFile: (defaultName, content) =>
    ipcRenderer.invoke('scout:save-text-file', {defaultName, content}),
  selectImportCsv: () => ipcRenderer.invoke('scout:select-import-csv'),
  selectProxyFile: () => ipcRenderer.invoke('scout:select-proxy-file'),
  selectBookmarkFile: () => ipcRenderer.invoke('scout:select-bookmark-file'),
  onBulkMatchCookiesRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:bulk-match-cookies-request', listener);
    return () => ipcRenderer.removeListener('scout:bulk-match-cookies-request', listener);
  },
  sendBulkMatchCookiesResult: (requestId, result, error) =>
    ipcRenderer.send('scout:bulk-match-cookies-result', {requestId, result, error}),
  onPushLocalCookiesRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:push-local-cookies-request', listener);
    return () => ipcRenderer.removeListener('scout:push-local-cookies-request', listener);
  },
  sendPushLocalCookiesResult: (requestId, result, error) =>
    ipcRenderer.send('scout:push-local-cookies-result', {requestId, result, error}),
  onCookieSyncPushRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:cookie-sync-push-request', listener);
    return () => ipcRenderer.removeListener('scout:cookie-sync-push-request', listener);
  },
  // The page-route pairs carry a fourth `status` argument the others do not:
  // their callers are the side panel and the start page, which act on the code
  // (409 means "switch workspace", 403 means "not yours", 500 means "we broke").
  // main.cjs defaults a missing one to 500, so an omitted status is the old
  // behaviour rather than a crash.
  sendCookieSyncPushResult: (requestId, result, error, status) =>
    ipcRenderer.send('scout:cookie-sync-push-result', {requestId, result, error, status}),
  onCookieSyncPullRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:cookie-sync-pull-request', listener);
    return () => ipcRenderer.removeListener('scout:cookie-sync-pull-request', listener);
  },
  sendCookieSyncPullResult: (requestId, result, error, status) =>
    ipcRenderer.send('scout:cookie-sync-pull-result', {requestId, result, error, status}),
  onCookieListRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:cookie-list-request', listener);
    return () => ipcRenderer.removeListener('scout:cookie-list-request', listener);
  },
  sendCookieListResult: (requestId, result, error, status) =>
    ipcRenderer.send('scout:cookie-list-result', {requestId, result, error, status}),
  onCookieSetsRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:cookie-sets-request', listener);
    return () => ipcRenderer.removeListener('scout:cookie-sets-request', listener);
  },
  sendCookieSetsResult: (requestId, result, error, status) =>
    ipcRenderer.send('scout:cookie-sets-result', {requestId, result, error, status}),
  onPanelAutomationsRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:panel-automations-request', listener);
    return () => ipcRenderer.removeListener('scout:panel-automations-request', listener);
  },
  sendPanelAutomationsResult: (requestId, result, error, status) =>
    ipcRenderer.send('scout:panel-automations-result', {requestId, result, error, status}),
  onPanelResolveAutomationRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:panel-resolve-automation-request', listener);
    return () =>
      ipcRenderer.removeListener('scout:panel-resolve-automation-request', listener);
  },
  sendPanelResolveAutomationResult: (requestId, result, error, status) =>
    ipcRenderer.send('scout:panel-resolve-automation-result',
        {requestId, result, error, status}),
  onReimportProxiesRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:reimport-proxies-request', listener);
    return () => ipcRenderer.removeListener('scout:reimport-proxies-request', listener);
  },
  sendReimportProxiesResult: (requestId, result, error) =>
    ipcRenderer.send('scout:reimport-proxies-result', {requestId, result, error}),
  onAssignProfileProxyRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:assign-profile-proxy-request', listener);
    return () => ipcRenderer.removeListener('scout:assign-profile-proxy-request', listener);
  },
  sendAssignProfileProxyResult: (requestId, result, error) =>
    ipcRenderer.send('scout:assign-profile-proxy-result', {requestId, result, error}),
  onGetProfileRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:get-profile-request', listener);
    return () => ipcRenderer.removeListener('scout:get-profile-request', listener);
  },
  sendGetProfileResult: (requestId, result, error) =>
    ipcRenderer.send('scout:get-profile-result', {requestId, result, error}),
  onListProxiesRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:list-proxies-request', listener);
    return () => ipcRenderer.removeListener('scout:list-proxies-request', listener);
  },
  sendListProxiesResult: (requestId, result, error) =>
    ipcRenderer.send('scout:list-proxies-result', {requestId, result, error}),
  onCreateProxyRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:create-proxy-request', listener);
    return () => ipcRenderer.removeListener('scout:create-proxy-request', listener);
  },
  sendCreateProxyResult: (requestId, result, error) =>
    ipcRenderer.send('scout:create-proxy-result', {requestId, result, error}),
  onUpdateProxyRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:update-proxy-request', listener);
    return () => ipcRenderer.removeListener('scout:update-proxy-request', listener);
  },
  sendUpdateProxyResult: (requestId, result, error) =>
    ipcRenderer.send('scout:update-proxy-result', {requestId, result, error}),
  onDeleteProxyRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:delete-proxy-request', listener);
    return () => ipcRenderer.removeListener('scout:delete-proxy-request', listener);
  },
  sendDeleteProxyResult: (requestId, result, error) =>
    ipcRenderer.send('scout:delete-proxy-result', {requestId, result, error}),
  onUpdateProfileRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:update-profile-request', listener);
    return () => ipcRenderer.removeListener('scout:update-profile-request', listener);
  },
  sendUpdateProfileResult: (requestId, result, error) =>
    ipcRenderer.send('scout:update-profile-result', {requestId, result, error}),
  onDeleteProfileRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:delete-profile-request', listener);
    return () => ipcRenderer.removeListener('scout:delete-profile-request', listener);
  },
  sendDeleteProfileResult: (requestId, result, error) =>
    ipcRenderer.send('scout:delete-profile-result', {requestId, result, error}),
  onUpdateFingerprintRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:update-fingerprint-request', listener);
    return () => ipcRenderer.removeListener('scout:update-fingerprint-request', listener);
  },
  sendUpdateFingerprintResult: (requestId, result, error) =>
    ipcRenderer.send('scout:update-fingerprint-result', {requestId, result, error}),
  onLaunchAutomationRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:launch-automation-request', listener);
    return () => ipcRenderer.removeListener('scout:launch-automation-request', listener);
  },
  sendLaunchAutomationResult: (requestId, result, error) =>
    ipcRenderer.send('scout:launch-automation-result', {requestId, result, error}),
  onListProfilesRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:list-profiles-request', listener);
    return () => ipcRenderer.removeListener('scout:list-profiles-request', listener);
  },
  sendListProfilesResult: (requestId, result, error) =>
    ipcRenderer.send('scout:list-profiles-result', {requestId, result, error}),
  // One subscribe/reply pair for every table-driven route, rather than a named
  // method per route. The dozen pairs around this one are the same four lines
  // with a different string in them; adding five more for the automations
  // routes would have been the point where that stopped being a style question.
  onApiRequest: (channel, callback) => {
    if (!API_CHANNELS.has(channel)) {
      return () => undefined;
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  // `status` lets the renderer pick the HTTP code: 404 for a row that is not
  // there, 403 for one this key may not see. Without it every refusal would be
  // reported as a server error.
  sendApiResult: (requestId, result, error, status) =>
    ipcRenderer.send('scout:api-result', {requestId, result, error, status}),
  onMonitoringReportRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:monitoring-report-request', listener);
    return () => ipcRenderer.removeListener('scout:monitoring-report-request', listener);
  },
  sendMonitoringReportResult: (requestId, result, error) =>
    ipcRenderer.send('scout:monitoring-report-result', {requestId, result, error}),
  onOAuthAuthorizeRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:oauth-authorize-request', listener);
    return () => ipcRenderer.removeListener('scout:oauth-authorize-request', listener);
  },
  sendOAuthAuthorizeResult: (requestId, approved, folderScope, keyName) =>
    ipcRenderer.send('scout:oauth-authorize-result', {requestId, approved, folderScope, keyName}),
  // A launch's start page asking for its own proxy to be re-checked. Answered
  // here rather than in main because the renderer is what can record the result
  // against the proxy row and compose the panel's next line -- see
  // recheckFromPage in main.cjs.
  onRecheckProxyRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:recheck-proxy-request', listener);
    return () => ipcRenderer.removeListener('scout:recheck-proxy-request', listener);
  },
  sendRecheckProxyResult: (requestId, result, error) =>
    ipcRenderer.send('scout:recheck-proxy-result', {requestId, result, error}),
  // A launch's start page asking for one of its own automations to be opened
  // here. One-way, unlike the pair above: main has already raised the window,
  // and there is no answer the page could show even if this failed -- see
  // openInLauncherFromPage in main.cjs.
  onOpenAutomationRequest: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('scout:open-automation-request', listener);
    return () => ipcRenderer.removeListener('scout:open-automation-request', listener);
  },
});
