// The MCP & Agents tab (id 'integrations'): which agent tools can drive this
// account's profiles.
//
// Moved out of SimpleTabs.tsx, which was down to this one occupant and whose
// header comment already recorded that the other tabs left as they grew. This
// one grew: sections, search, per-card status with a reason, and a Connect that
// happens on the card.
//
// The central rule here is that a card never claims more than has been checked.
// "A key exists" used to be enough to print Connected, which it is not: the
// wiring lives in a file another tool can edit, and it can point at something
// that no longer exists. `integrations.stateFor` is the only thing that decides.
//
// The second rule, added later: the key a connection runs on is part of the
// connection and belongs on the screen that owns it. It used to exist only on
// the API tab, where it appeared as a row named after a tool with no way back
// to that tool -- so the question "where are my keys, and what do I do with
// one" had no answer anywhere on this screen. The card now carries the key's
// identity, and the disclosure below the bar answers the second half once for
// all ten of them rather than ten times over.
import {useEffect, useMemo, useState} from 'react';
import {Clock, ExternalLink, KeyRound, MonitorCheck, MonitorX, Plug, Search, SquareTerminal, TriangleAlert, Unplug} from 'lucide-react';
import {Badge} from '../ui/Badge';
import {BusyButton} from '../ui/BusyButton';
import {EmptyState} from '../ui/EmptyState';
import {IntegrationMark} from '../ui/icons';
import {INTEGRATIONS} from '../../data/integrations';
import {API_BASE_URL} from '../../data/apiDocs';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {Integration, IntegrationId} from '../../data/integrations';
import type {ApiKeys, IntegrationsState} from '../../hooks/useApiKeys';

const ALL_IDS = INTEGRATIONS.map((integration) => integration.id);

// "2 minutes ago" beats a date here: the question a card answers is "is this
// thing actually being used", and a timestamp from today reads as noise. The
// dialog prints real dates instead -- it is the place you go to audit a key,
// and "3h ago" is not something you can compare against a calendar.
function sinceLabel(iso: string | null): string {
  if (!iso) {
    return '';
  }
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) {
    return 'used just now';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `used ${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `used ${hours}h ago`;
  }
  return `used ${new Date(iso).toLocaleDateString()}`;
}

function IntegrationCard({integration, apiKeys, integrations, onOpen}: {
  integration: Integration;
  apiKeys: ApiKeys;
  integrations: IntegrationsState;
  onOpen: (integration: Integration) => void;
}) {
  const {data} = useWorkspace();
  const state = integrations.stateFor(integration);
  const reason = integrations.reasonFor(integration);
  const config = integrations.configs[integration.id];
  const busy = integrations.busyId === integration.id;
  const key = apiKeys.keysFor(integration.id)[0];
  const manual = integration.category === 'manual';
  const needsRepair = state === 'attention' && Boolean(config?.hasEntry) &&
    (config?.stale || !config?.commandExists || !config?.entryIsCurrent);
  // Detection is never a gate -- it can be wrong, and a wrong "no" must not
  // make a working install unconnectable. It changes the wording instead, so
  // the click is a deliberate one rather than a surprise.
  const undetected = Boolean(config) && !config?.manual && !config?.installed;
  // Three different promises, and the button has to keep whichever it makes.
  // "Set up…" ends in an ellipsis because it opens a dialog rather than doing
  // the thing; "Set up anyway" answers the "not found on this machine" line
  // directly above it.
  let connectLabel = 'Connect';
  if (manual) {
    connectLabel = 'Set up…';
  } else if (undetected) {
    connectLabel = 'Set up anyway';
  }

  return (
    <div className={`integration-card is-${state}`}>
      {/* Both chips sit with the name, at the top of the card. The presence one
          used to be a sentence in the card's foot ("Cursor was not found on
          this machine"), which put the least conditional fact about a tool --
          whether it is even here -- last, and repeated the phrase "found on
          this machine" down the whole grid until it read as a claim every card
          was making. As a chip beside the name it is one word-shaped thing you
          can scan a column of. */}
      <div className="integration-card-head">
        <IntegrationMark integration={integration} />
        <h2>{integration.name}</h2>
        {state === 'connected' && (
          <Badge tone="active" icon={<span className="status-chip-dot" />}>Connected</Badge>
        )}
        {state === 'attention' && (
          <Badge tone="warmup" icon={<TriangleAlert size={12} />}>Needs attention</Badge>
        )}
        {/* Muted rather than amber: nothing is broken and there is nothing to
            fix here -- the tool simply is not on this machine, so calling this
            Connected would be the lie this state exists to remove. */}
        {state === 'awaiting-tool' && (
          <Badge icon={<Clock size={12} />}>Waiting for {integration.name}</Badge>
        )}
        {/* Said out loud rather than left blank. A card with no chip at all is
            indistinguishable from one whose status has not loaded yet, and this
            is the state most of the cards are in on a first visit. */}
        {state === 'idle' && <Badge icon={<Unplug size={12} />}>Not connected</Badge>}
        {/* Only alongside "Not connected": the other three states already imply
            the answer -- you cannot be Connected to something that is not here,
            and "Waiting for X" says it outright. Detection is real: it looks for
            an application bundle, an executable, or a file only that tool
            writes, never for the config file this app itself creates. The chip
            carries the exact path it found as its tooltip, so it shows its
            working rather than asking to be believed. The two manual cards have
            nothing to detect -- the server reports them present so they are
            never labelled missing -- so they keep the connection chip and skip
            this one. */}
        {state === 'idle' && !manual && config && (
          config.installed ? (
            <Badge
              tone="info"
              icon={<MonitorCheck size={12} />}
              title={config.installedEvidence ? `Found: ${config.installedEvidence}` : undefined}
            >
              Found on this machine
            </Badge>
          ) : (
            <Badge
              icon={<MonitorX size={12} />}
              title={`Nothing on disk identifies ${integration.name}. You can still set it up — the settings are harmless on their own and will be waiting when you install it.`}
            >
              Not on this machine
            </Badge>
          )
        )}
      </div>
      <p>{integration.description}</p>

      {/* Any card with a key prints that key: it is the thing a user arrives on
          this tab looking for, and it exists in every state but idle. Name
          first, because the name is what the API tab's list and any audit of
          "what can reach my profiles" is conducted in.
          The second line is whichever of the two matters. A healthy connection
          has no reason left to give, so it gets the scope and the last use; a
          card that needs attention gives up those two for the one sentence
          naming what to do -- printing "All folders · used 2h ago" over a
          connection that is broken is worse than printing nothing.

          Dropped entirely when there is neither, which on a first visit is most
          of the grid: an unconnected card has no key and, now that presence is a
          chip in the head, no reason left to give, so this was reserving 36px of
          nothing under every description. */}
      {(key || reason) && (
      <div className="integration-card-meta">
        {key ? (
          <>
            <span className="integration-card-key">
              <KeyRound size={12} />
              <span className="integration-card-key-name" title={key.name}>{key.name}</span>
              <code>&middot;{key.tokenPreview}</code>
            </span>
            <span>
              {reason || `${apiKeys.describeScope(key, data.state.folders)}${
                key.lastUsedAt ? ` · ${sinceLabel(key.lastUsedAt)}` : ' · never used'}`}
            </span>
          </>
        ) : <span>{reason}</span>}
      </div>
      )}

      {/* Never more than two, and the second is always the quiet one. Repair
          only ever accompanies Manage (it needs a key and a broken entry, which
          is the attention state); Connect only ever accompanies Details. */}
      <div className="integration-card-actions">
        {needsRepair && (
          <BusyButton
            busy={busy}
            busyLabel="Repairing…"
            onClick={() => void integrations.repair(integration)}
          >
            Repair
          </BusyButton>
        )}
        {state === 'idle' ? (
          <>
            {/* The two manual cards never connect from here. Their whole
                connect flow is "here is a token, shown once, paste it
                somewhere" -- and that token only has a surface in the dialog,
                so minting it from the card would burn a one-time secret onto a
                screen that has nowhere to print it. */}
            <BusyButton
              busy={busy}
              busyLabel="Connecting…"
              onClick={() => {
                if (manual) {
                  onOpen(integration);
                  return;
                }
                void integrations.connect(integration);
              }}
            >
              {connectLabel}
            </BusyButton>
            {/* The dialog was unreachable from an unconnected card: the only
                button on it connected, so everything that dialog says about
                what is about to be written, and the folder scoping it offers,
                could only be read after the writing had happened. */}
            {!manual && (
              <button className="ghost integration-card-more" onClick={() => onOpen(integration)}>
                Details
              </button>
            )}
          </>
        ) : (
          <button className="ghost" onClick={() => onOpen(integration)}>Manage</button>
        )}
      </div>
    </div>
  );
}

export function IntegrationsTab({apiKeys, integrations, onOpen, onOpenApiPage}: {
  apiKeys: ApiKeys;
  integrations: IntegrationsState;
  onOpen: (integration: Integration) => void;
  // Opens the website's API reference. The launcher used to carry an API tab
  // of its own; that surface lives on the site now, and this tab is where a
  // user goes looking for it.
  onOpenApiPage: () => void;
}) {
  const [query, setQuery] = useState('');
  const {refreshAll} = integrations;

  // Read every tool's real state on arrival. Without this the tab shows
  // whatever the key store implies until a dialog is opened, which is exactly
  // the stale picture this rebuild exists to remove.
  useEffect(() => {
    void refreshAll(ALL_IDS as IntegrationId[]);
  }, [refreshAll]);

  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return INTEGRATIONS;
    }
    // The id is in the haystack so that "vscode" finds VS Code and "gemini"
    // finds the CLI -- the two names a user is most likely to type are the ones
    // the display name spells differently.
    return INTEGRATIONS.filter((integration) =>
      integration.name.toLowerCase().includes(needle) ||
      integration.id.toLowerCase().includes(needle) ||
      integration.description.toLowerCase().includes(needle));
  }, [query]);

  const apiState = integrations.apiState;
  const apiReady = apiState?.status === 'ready';
  const connectedCount = INTEGRATIONS
      .filter((integration) => integrations.stateFor(integration) === 'connected').length;

  return (
    <section className="api-panel">
      {/* Two clusters on one surface: what the tab runs on, and how to get
          around it. Left is the local API -- the one dependency every card
          shares -- as a chip plus the address it is answering on. Right is the
          count and the filter, which are both ways of narrowing ten cards. */}
      <section className="integration-bar">
        <div className="integration-bar-main">
          <Badge
            tone={apiReady ? 'active' : 'warmup'}
            icon={<span className="status-chip-dot" />}
          >
            {apiReady ? 'Local API ready' : `Local API ${apiState?.status || 'not running'}`}
          </Badge>
          <code title={apiState?.url || API_BASE_URL}>{apiState?.url || API_BASE_URL}</code>
        </div>
        <div className="integration-bar-side">
          {/* The one number worth carrying at the top: with ten cards spread
              over three sections, "how much of this is actually live" is
              otherwise a counting exercise. */}
          <span className="integration-bar-count">
            <strong>{connectedCount}</strong> of {INTEGRATIONS.length} connected
          </span>
          <label className="integration-search">
            <Search size={15} />
            <input
              aria-label="Search integrations"
              placeholder="Search integrations"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      </section>

      {/* The pill above states the fact; this states what the fact means. A
          stopped API is the one condition under which every card on this tab is
          decoration, and the pill alone never said so. */}
      {!apiReady && (
        <p className="apply-status-note">
          Until the local API is running, nothing here can reach your profiles.
          {apiState?.error ?
            ` It reported: ${apiState.error}` :
            ' It starts with the app — reopening EasyDeck is usually enough.'}
        </p>
      )}

      <section className="api-note integration-api-note">
        <Plug size={18} />
        <span>
          Connecting mints an API key scoped to the folders you choose and writes
          it into that tool's own config, so the tool can launch, navigate, read
          and screenshot your profiles. The MCP server ships inside this app —
          there is nothing to install.
        </span>
        <button type="button" className="ghost" onClick={onOpenApiPage}>
          <SquareTerminal size={15} />
          API
          <ExternalLink size={13} />
        </button>
      </section>

      {/* Folded away by default and open in one click. The answer to "what do I
          do with a key" is four lines long and the same for all ten tools, so
          it is neither worth ten repetitions inside the dialogs nor worth
          standing permanently between the user and the cards. */}
      <details className="integration-guide">
        <summary>
          <KeyRound size={15} />
          How these keys work
        </summary>
        <div className="integration-guide-body">
          <p>
            For every tool above you never touch the key yourself: connecting
            writes it into that tool's config file and the tool sends it on every
            call. It is shown on the card so you can see what exists, what it can
            reach, and revoke it.
          </p>
          <div className="integration-facts is-columns">
            <div>
              <span>Base URL</span>
              <code>{API_BASE_URL}</code>
            </div>
            <div>
              <span>Every /v1/* request</span>
              <code>Authorization: Bearer &lt;key&gt;</code>
            </div>
          </div>
          <p>
            The base URL is loopback: it answers on this machine and is not
            reachable from anywhere else, so the key never leaves it either.
          </p>
          <p>
            A connected agent does not use that URL directly — it calls the MCP
            tools by name (list profiles, launch, navigate, screenshot). Plain
            HTTP is for everything that is not an MCP client: your own scripts,
            a cron job, a CI step.
          </p>
          <p className="integration-guide-more">
            Every endpoint with a curl example, plus keys you can make by hand
            for those scripts, are on the{' '}
            <button type="button" className="link-button" onClick={onOpenApiPage}>
              API page
            </button>{' '}
            on the website.
          </p>
        </div>
      </details>

      {matched.length > 0 && (
        <section className="integration-section">
          <div className="integration-grid">
            {matched.map((integration) => (
              <IntegrationCard
                key={integration.id}
                integration={integration}
                apiKeys={apiKeys}
                integrations={integrations}
                onOpen={onOpen}
              />
            ))}
          </div>
        </section>
      )}

      {/* The search can only ever empty this tab, never the install itself --
          so the way out is the way back, and the block says so rather than
          leaving a lone grey sentence where ten cards were. */}
      {!matched.length && (
        <EmptyState
          icon={<Search size={20} />}
          title={`Nothing matches “${query}”`}
          body={`All ${INTEGRATIONS.length} integrations are still here — this is only the filter.`}
        >
          <button className="ghost" onClick={() => setQuery('')}>Clear search</button>
        </EmptyState>
      )}
    </section>
  );
}
