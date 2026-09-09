// Local automation API keys, and the integrations that create them.
//
// The key store is per-install -- one automation-keys.json shared by every
// account that has ever signed in on this machine -- so the list has to be
// filtered by the signed-in user. It used to be loaded once at mount and never
// cleared, which is why signing in as a new account still showed the previous
// one's keys, and with them its integrations as Connected.
import {useCallback, useEffect, useState} from 'react';
import {native} from '../native';
import type {ApiKey, ApiState, IntegrationStatus, IntegrationVerification} from '../native';
import type {Integration, IntegrationId} from '../data/integrations';
import type {ScoutFolder} from '../types';

export type ApiKeys = ReturnType<typeof useApiKeys>;

export function useApiKeys(userId: string | null, orgId: string | null) {
  const [keys, setKeys] = useState<ApiKey[]>([]);

  const refresh = useCallback(async () => {
    const listed = await native?.listApiKeys?.(userId);
    setKeys(listed || []);
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Empty string means "no folder chosen", which is full access -- the same
  // thing a null folderScope means to the main process. A one-element array is
  // an explicit single-folder grant.
  function scopeFromSelection(folderId: string) {
    return folderId ? [folderId] : null;
  }

  async function create(name: string, folderId: string) {
    if (!native?.createApiKey) {
      return null;
    }
    const created = await native.createApiKey(name || 'Unnamed key', scopeFromSelection(folderId));
    await refresh();
    return created;
  }

  async function revoke(id: string) {
    await native?.revokeApiKey?.(id);
    await refresh();
  }

  // A key belongs to an integration only if the connect flow stamped it with
  // that integration's id. This used to compare key.name against the display
  // name, which meant any key ever created on this machine called "Claude Code"
  // -- by a previous account, by hand on the API tab, or by an OAuth client
  // that chose its own key name -- made the card read Connected.
  function keysFor(integrationId: IntegrationId) {
    return keys.filter((key) => key.integrationId === integrationId);
  }

  function describeScope(key: ApiKey, folders: ScoutFolder[]) {
    if (!key.folderScope) {
      return 'All folders';
    }
    return key.folderScope
        .map((id) => folders.find((folder) => folder.id === id)?.name || id)
        .join(', ') || 'No folders';
  }

  return {
    keys,
    setKeys,
    refresh,
    create,
    revoke,
    keysFor,
    describeScope,
    scopeFromSelection,
    userId,
    orgId,
  };
}

export type IntegrationsState = ReturnType<typeof useIntegrations>;

// How a card reads. Derived from four independent facts, because any one of
// them can be true while the integration is dead: this app has a key, the
// tool's config carries our entry, that entry points at something that still
// exists, and the tool it was all written for is actually on this machine.
// Reporting on the key alone is what used to show Connected for a tool that
// failed to start the server on every launch.
//
// 'awaiting-tool' is the fourth fact's own state, and it is deliberately not
// 'attention': everything this app controls is correct and there is nothing to
// repair. Writing the config for a tool you are about to install is a perfectly
// reasonable thing to have done -- it just cannot be called Connected, because
// nothing is connected to anything until the tool exists.
export type ConnectionState = 'connected' | 'attention' | 'awaiting-tool' | 'idle';

export function useIntegrations(apiKeys: ApiKeys, apiState: ApiState | null) {
  // Which integration's dialog is open, '' for none.
  const [openId, setOpenId] = useState<IntegrationId | ''>('');
  const [scope, setScope] = useState('');
  const [busyId, setBusyId] = useState<IntegrationId | ''>('');
  const [results, setResults] = useState<Partial<Record<IntegrationId, {ok: boolean; message: string}>>>({});
  const [tokens, setTokens] = useState<Partial<Record<IntegrationId, string>>>({});
  // Keyed by integration, like `results` and `configs`. A single slot meant the
  // checks from the last tool you tested rendered under the next tool's name --
  // a green "Can reach your profiles" sitting in Cursor's dialog because you
  // had tested Claude Code a minute earlier. Exactly the kind of borrowed truth
  // this screen exists to stop telling.
  const [verifications, setVerifications] =
    useState<Partial<Record<IntegrationId, IntegrationVerification>>>({});
  // What each tool's config file says right now, as opposed to what this app's
  // key store says. Filled by refreshStatus.
  const [configs, setConfigs] = useState<Partial<Record<IntegrationId, IntegrationStatus>>>({});
  // Which tools look present on this machine. Advisory -- it never gates
  // connecting, only the label on an unconnected card.
  const [detected, setDetected] = useState<Record<string, boolean>>({});

  const refreshStatus = useCallback(async (integrationId: IntegrationId) => {
    if (!native?.integrationStatus) {
      return null;
    }
    const status = await native.integrationStatus(integrationId);
    setConfigs((prev) => ({...prev, [integrationId]: status}));
    return status;
  }, []);

  // Loads every card's real state at once, so the tab is honest on arrival
  // rather than only after a dialog is opened.
  const refreshAll = useCallback(async (ids: IntegrationId[]) => {
    const [statuses, found] = await Promise.all([
      Promise.all(ids.map(async (id) => [id, await native?.integrationStatus?.(id)] as const)),
      native?.detectIntegrations?.() ?? Promise.resolve({}),
    ]);
    setConfigs((prev) => {
      const next = {...prev};
      for (const [id, status] of statuses) {
        if (status) {
          next[id] = status;
        }
      }
      return next;
    });
    setDetected(found || {});
  }, []);

  // Connected needs all four facts to agree. Anything short of that with a key
  // present is "needs attention" or "awaiting tool" -- never silently
  // Connected.
  function stateFor(integration: Integration): ConnectionState {
    const hasKey = apiKeys.keysFor(integration.id).length > 0;
    const config = configs[integration.id];
    if (!hasKey) {
      return 'idle';
    }
    if (config?.manual) {
      return 'connected';
    }
    if (!config) {
      // Status not loaded yet -- don't claim either way.
      return 'attention';
    }
    if (!config.hasEntry || !config.entryIsCurrent || !config.commandExists) {
      return 'attention';
    }
    // Our half is sound. Whether any of it is doing anything depends on the
    // tool being here to read it.
    return config.installed ? 'connected' : 'awaiting-tool';
  }

  // Why a card is not simply Connected, in the user's terms. One line, naming
  // the thing to do about it.
  function reasonFor(integration: Integration): string {
    const config = configs[integration.id];
    const hasKey = apiKeys.keysFor(integration.id).length > 0;
    // Nothing to explain: an unconnected card is not in a state that needs a
    // reason, and whether the tool is on this machine is now the presence chip's
    // job in the card's head. This used to return one of two sentences here --
    // "Found on this machine" / "X was not found on this machine" -- which put
    // the phrase at the foot of every card in the grid, where a row of them read
    // as a claim rather than a detection result.
    if (!hasKey) {
      return '';
    }
    if (!config) {
      return 'Checking…';
    }
    if (!config.hasEntry) {
      return `${config.configPath || integration.configLabel} no longer has the scout entry`;
    }
    if (config.stale || !config.commandExists) {
      return 'Points at a server that is not installed — repair it';
    }
    if (!config.entryIsCurrent) {
      return 'Points at an older install — repair it';
    }
    // Said before the API line on purpose: with no tool here, whether our own
    // API happens to be up is not the user's next move.
    if (!config.installed) {
      return `Set up and waiting — install ${integration.name} and it will pick this up`;
    }
    if (!config.apiReady) {
      return 'The local API is not running';
    }
    return '';
  }

  function open(integration: Integration) {
    setOpenId(integration.id);
    setScope('');
    // Clear this tool's own stale result on reopen -- checks from ten minutes
    // ago describe a machine that may have changed since.
    setVerifications((prev) => ({...prev, [integration.id]: undefined}));
    void refreshStatus(integration.id);
  }

  // Mints a scoped key and writes the tool's config in one step. Nothing to
  // install and no path to supply: the config points at the MCP server bundled
  // in this app, started through the launcher's own binary.
  //
  // The two manual integrations get the raw token revealed instead, because
  // they have no config file for this app to write.
  async function connect(integration: Integration) {
    if (!native?.createApiKey) {
      return;
    }
    setBusyId(integration.id);
    try {
      const created = await native.createApiKey(
          integration.name,
          apiKeys.scopeFromSelection(scope),
          {ownerUserId: apiKeys.userId, orgId: apiKeys.orgId, integrationId: integration.id},
      );
      await apiKeys.refresh();
      if (integration.category === 'manual') {
        setTokens((prev) => ({...prev, [integration.id]: created.token}));
        setResults((prev) => ({
          ...prev,
          [integration.id]: {
            ok: true,
            message: 'Copy this into your client as SCOUT_API_TOKEN — it is shown once.',
          },
        }));
        await refreshStatus(integration.id);
        return;
      }
      if (!native.applyIntegrationConfig) {
        return;
      }
      const result = await native.applyIntegrationConfig(integration.id, created.token);
      // Re-read before reporting, so what is said next is what the disk says
      // and not what we intended. It also settles the one question the old
      // message quietly assumed the answer to: whether the tool we just wrote
      // settings for is here to read them.
      const status = await refreshStatus(integration.id);
      const missing = Boolean(status) && !status?.manual && !status?.installed;
      setResults((prev) => ({
        ...prev,
        [integration.id]: result.ok ?
          {
            ok: true,
            message: missing ?
              `Wrote ${result.path}. ${integration.name} is not on this machine yet — ` +
                'install it and it will pick this up. Nothing else to do here.' :
              `Wrote ${result.path}. ${integration.restartLabel} to pick it up.`,
          } :
          {ok: false, message: result.error || 'Failed to write config'},
      }));
    } finally {
      setBusyId('');
    }
  }

  // Repoints a stale entry at this build's server, keeping the key that is
  // already in the file. Falls back to a full connect when that key is gone --
  // minting a new one needs the owner ids only this side knows.
  async function repair(integration: Integration) {
    setBusyId(integration.id);
    try {
      const result = await native?.repairIntegration?.(integration.id);
      if (result?.needsKey) {
        setBusyId('');
        await connect(integration);
        return;
      }
      setResults((prev) => ({
        ...prev,
        [integration.id]: result?.ok ?
          {ok: true, message: `Updated ${result.path}. ${integration.restartLabel} to pick it up.`} :
          {ok: false, message: result?.error || 'Could not repair this connection'},
      }));
      await refreshStatus(integration.id);
    } finally {
      setBusyId('');
    }
  }

  // The only honest answer to "I lost my key" / "I need the raw value".
  //
  // Nothing can hand back an existing token: createAutomationKey persists a
  // SHA-256 hash and a four-character preview, and that is all there is. So the
  // recovery path is not recovery at all -- it is replacement. The old keys go
  // first so that a machine is never left with two live keys for one tool (one
  // in the config, one orphaned but still granting access), and connect() then
  // mints the replacement and rewrites the config with it in the same step it
  // always did.
  //
  // Deliberately not folded into connect(): connect() is also what runs on a
  // card that has never been connected, and revoking there would be a no-op
  // dressed up as a destructive action.
  async function reissue(integration: Integration) {
    setBusyId(integration.id);
    try {
      for (const key of apiKeys.keysFor(integration.id)) {
        await native?.revokeApiKey?.(key.id);
      }
      await apiKeys.refresh();
    } finally {
      setBusyId('');
    }
    await connect(integration);
  }

  // Both halves, in the order that cannot strand the user: config first, then
  // the key. Revoking first would leave the tool pointed at a dead token if the
  // config write then failed.
  async function disconnect(integration: Integration) {
    setBusyId(integration.id);
    try {
      await native?.removeIntegrationConfig?.(integration.id);
      for (const key of apiKeys.keysFor(integration.id)) {
        await native?.revokeApiKey?.(key.id);
      }
      await apiKeys.refresh();
      await refreshStatus(integration.id);
      setTokens((prev) => ({...prev, [integration.id]: ''}));
      setVerifications((prev) => ({...prev, [integration.id]: undefined}));
      setResults((prev) => ({
        ...prev,
        [integration.id]: {
          ok: true,
          message: 'Disconnected. The key is revoked and the config entry removed.',
        },
      }));
    } finally {
      setBusyId('');
    }
  }

  // Actually starts the configured server and speaks MCP to it, in the main
  // process. Everything cheaper than this can pass while the integration is
  // dead -- which is the state this tab used to report as Connected.
  async function test(integration: Integration) {
    setBusyId(integration.id);
    setVerifications((prev) => ({...prev, [integration.id]: undefined}));
    try {
      await refreshStatus(integration.id);
      const result = await native?.verifyIntegration?.(integration.id);
      setVerifications((prev) => ({
        ...prev,
        [integration.id]: result || {
          ok: false,
          checks: [{
            id: 'native',
            label: 'Scout Web',
            ok: false,
            detail: 'Verification is only available in the desktop app.',
          }],
        },
      }));
    } finally {
      setBusyId('');
    }
  }

  // Everything the outgoing account established, dropped on sign-out so the
  // Integrations tab can never show their connections during the gap.
  function reset() {
    setResults({});
    setTokens({});
    setConfigs({});
    setVerifications({});
    setOpenId('');
  }

  return {
    openId, setOpenId,
    scope, setScope,
    busyId, results, tokens, verifications, configs, detected,
    apiState,
    open, connect, disconnect, repair, reissue, test, reset,
    refreshStatus, refreshAll, stateFor, reasonFor,
  };
}
