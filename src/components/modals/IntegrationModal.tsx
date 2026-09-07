// The connect/manage dialog for one integration.
//
// It answers four questions, in the order a user asks them: what will this do
// to my machine, what do I have to do next, what key is this connection running
// on, and what can I do with that key. The third and fourth were missing
// entirely -- the key existed only as a row on the API tab -- which is how a
// screen whose entire purpose is handing out credentials managed never to show
// one.
import {Check, Copy, KeyRound, TriangleAlert, X} from 'lucide-react';
import {Modal} from '../ui/Modal';
import {BusyButton} from '../ui/BusyButton';
import {IntegrationMark} from '../ui/icons';
import {AGENT_STARTER_PROMPT, MCP_TOOL_SUMMARY} from '../../data/integrations';
import {API_BASE_URL} from '../../data/apiDocs';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {Integration} from '../../data/integrations';
import type {ApiKeys, IntegrationsState} from '../../hooks/useApiKeys';
import type {ApiKey, ApiState} from '../../native';

// What a user has to paste for the two integrations that have no config file
// this app can write. Shown with the real token once, and with a placeholder
// before connecting, so the shape is visible either way.
//
// Two shapes, because the two of them read the key from genuinely different
// places: an env-based client takes environment variables out of its own .env, a generic MCP
// client wants a server block. Handing either one the other's format is a
// paste that silently does nothing.
function manualSnippet(integration: Integration, token: string | undefined, base: string) {
  const value = token || '<your key>';
  if (integration.manualFormat === 'env') {
    return [`MONTI_API_BASE=${base}`, `MONTI_API_TOKEN=${value}`].join('\n');
  }
  return JSON.stringify({
    mcpServers: {
      monti: {
        type: 'stdio',
        command: 'Scout Web',
        args: ['<the path shown after you connect>'],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          MONTI_API_TOKEN: value,
          MONTI_API_BASE: base,
        },
      },
    },
  }, null, 2);
}

// "Restart Codex" mid-sentence. Only the first character drops case: a plain
// toLowerCase() takes the product name down with it.
function midSentence(label: string) {
  return label.charAt(0).toLowerCase() + label.slice(1);
}

// Absolute, not relative: this is the auditing view of a key, and "3h ago"
// cannot be checked against anything. The card carries the relative form.
function dateLabel(iso: string | null): string {
  if (!iso) {
    return '';
  }
  const when = new Date(iso);
  return `${when.toLocaleDateString()} ${when.toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`;
}

export function IntegrationModal({integration, integrations, apiKeys, apiState}: {
  integration: Integration;
  integrations: IntegrationsState;
  apiKeys: ApiKeys;
  apiState: ApiState | null;
}) {
  const {data} = useWorkspace();
  // Newest first. Normally there is exactly one -- reissue revokes before it
  // mints -- but a machine that connected the same tool under an older build
  // can carry more, and the newest is the one the config actually holds.
  const connectedKeys = [...apiKeys.keysFor(integration.id)]
      .sort((a: ApiKey, b: ApiKey) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const key = connectedKeys[0];
  const state = integrations.stateFor(integration);
  const connected = connectedKeys.length > 0;
  const config = integrations.configs[integration.id];
  const result = integrations.results[integration.id];
  const token = integrations.tokens[integration.id];
  const verification = integrations.verifications[integration.id];
  const busy = integrations.busyId === integration.id;
  const manual = integration.category === 'manual';
  const base = apiState?.url || API_BASE_URL;
  const configPath = config?.configPath || integration.configLabel;
  const needsRepair = state === 'attention' && Boolean(config?.hasEntry) &&
    (config?.stale || !config?.commandExists || !config?.entryIsCurrent);
  // Whether the tool was found on this machine. Never blocks connecting -- a
  // false negative would make a working install unconnectable -- it only
  // changes what this dialog is willing to claim, and what the button says.
  const undetected = Boolean(config) && !manual && !config?.installed;
  const close = () => integrations.setOpenId('');

  return (
    <Modal
      className="small-modal integration-modal"
      onClose={close}
      header={
        <div className="integration-modal-title">
          <IntegrationMark integration={integration} size={22} />
          <div>
            <h2>{integration.name}</h2>
            <p>{integration.description}</p>
          </div>
        </div>
      }
      footer={connected ? (
        <>
          <button
            className="ghost danger"
            disabled={busy}
            onClick={() => void integrations.disconnect(integration)}
          >
            Disconnect
          </button>
          {needsRepair && (
            <BusyButton busy={busy} busyLabel="Repairing…"
              onClick={() => void integrations.repair(integration)}>
              Repair
            </BusyButton>
          )}
          <BusyButton busy={busy} busyLabel="Testing…" className="ghost"
            onClick={() => void integrations.test(integration)}>
            Test connection
          </BusyButton>
          <button onClick={close}>Done</button>
        </>
      ) : (
        <>
          <button className="ghost" disabled={busy} onClick={close}>Cancel</button>
          <BusyButton busy={busy} busyLabel="Connecting…"
            onClick={() => void integrations.connect(integration)}>
            {undetected ? 'Set up anyway' : 'Connect'}
          </BusyButton>
        </>
      )}
    >
      {/* ── Before connecting ──────────────────────────────────────────────
          What this is about to do, then the one decision there is to make. */}
      {!connected && (
        <section className="integration-steps">
          <h3>What connecting does</h3>
          <ol>
            <li>Creates an API key scoped to the folders you pick.</li>
            <li>
              {manual ?
                `Shows you that key once, to paste into ${integration.configLabel} — there is no config file here for Scout Web to write.` :
                `Writes an "monti" MCP server into ${integration.configLabel}, pointing at the server bundled in this app. Nothing to install.`}
            </li>
            <li>{integration.restartLabel}. {integration.confirmLabel}</li>
          </ol>
        </section>
      )}

      {!connected && (
        <label className="field">
          <span>Grant access to</span>
          <select
            value={integrations.scope}
            onChange={(event) => integrations.setScope(event.target.value)}
          >
            <option value="">All folders</option>
            {data.state.folders.map((folder) => (
              <option key={folder.id} value={folder.id}>{folder.name}</option>
            ))}
          </select>
          <span className="field-hint">
            A scoped key can only see and launch profiles in that folder.
          </span>
        </label>
      )}

      {/* ── After connecting ───────────────────────────────────────────────
          One line, at the top, saying what is left to do for this tool. Every
          one of these reads its config at process start and there is no reload
          signal we can send, so there is always something -- and which thing
          differs enough between a CLI and an editor to be worth spelling out
          per tool rather than saying "restart it". */}
      {connected && state === 'connected' && (
        <section className="integration-next">
          <h3>Your move</h3>
          {manual ? (
            <p>
              Put the key at the bottom of this dialog into{' '}
              {integration.configLabel}, then {midSentence(integration.restartLabel)}.{' '}
              {integration.confirmLabel}
            </p>
          ) : (
            <p>
              {integration.restartLabel} — it reads {integration.configLabel} at
              startup, so an instance that was already running has not seen this
              yet. {integration.confirmLabel}
            </p>
          )}
        </section>
      )}

      {/* Not a dead end, and not an error: the settings are written and
          correct, the tool is simply not here. Installing it is the whole of
          the remaining work, and nothing has to be redone afterwards. */}
      {/* Suppressed while a result line is up: that line has just said the same
          thing about the write that produced it, and saying it twice reads as
          two separate problems. */}
      {state === 'awaiting-tool' && !result && (
        <section className="integration-next">
          <h3>Your move</h3>
          <p>
            Install {integration.name}. Everything on this side is done — the key
            exists and {configPath} is written — and {integration.name} reads that
            file when it starts, so it will pick this up on its first run with
            nothing to redo here.
          </p>
        </section>
      )}

      {/* The broken-wiring state that Repair does not cover: the entry is not
          merely stale, it is gone, so there is nothing to repoint. Replacing
          the key is the fix, because minting one rewrites the file on the way
          through -- which is worth saying, since "replace the key" does not
          sound like an answer to "the config entry vanished". */}
      {connected && state === 'attention' && !needsRepair && (
        <section className="integration-next">
          <h3>Your move</h3>
          <p>
            {config ?
              `${configPath} no longer has the monti entry — something else edited or replaced the file. Replace the key below: minting a new one writes the entry back at the same time.` :
              `Checking what ${integration.name} has on disk…`}
          </p>
        </section>
      )}

      {/* ── The key ────────────────────────────────────────────────────────
          The thing this screen hands out, finally shown on the screen that
          hands it out. Everything here is recoverable from the key store; the
          one field that is not, the token itself, says so in its own words
          rather than being quietly absent. */}
      {connected && key && (
        <section className="integration-steps">
          <h3><KeyRound size={13} /> Its key</h3>
          <div className="integration-facts is-columns">
            <div>
              <span>Name</span>
              <code title={key.name}>{key.name}</code>
            </div>
            <div>
              <span>Key</span>
              <code>&middot;{key.tokenPreview}</code>
            </div>
            <div>
              <span>Can reach</span>
              <code>{apiKeys.describeScope(key, data.state.folders)}</code>
            </div>
            <div>
              <span>Created</span>
              <code>{dateLabel(key.createdAt)}</code>
            </div>
            <div>
              <span>Last used</span>
              <code>{key.lastUsedAt ? dateLabel(key.lastUsedAt) : 'Never'}</code>
            </div>
          </div>

          {/* The constraint, stated once and without a lecture. Only a hash and
              those four characters are kept, so there is no version of this UI
              that could reveal the value -- and the useful half of that
              sentence is the sentence after it, which is a real way out. */}
          <p className="integration-key-note">
            Only a hash of the key is stored, so its value cannot be shown again
            — not here, not anywhere. If you need the value itself, replace the
            key: that revokes this one and{' '}
            {manual ?
              'shows you the new one, once.' :
              `writes the new one into ${configPath} for you.`}
          </p>
          <div className="integration-key-actions">
            <BusyButton
              busy={busy}
              busyLabel="Replacing…"
              className="ghost"
              onClick={() => void integrations.reissue(integration)}
            >
              Replace key
            </BusyButton>
            {connectedKeys.length > 1 && (
              <span className="integration-key-extra">
                {connectedKeys.length - 1} older key
                {connectedKeys.length > 2 ? 's' : ''} from an earlier connection
                still work{connectedKeys.length > 2 ? '' : 's'} — replace, or
                revoke on the API tab.
              </span>
            )}
          </div>
        </section>
      )}

      {/* ── What to do with it ─────────────────────────────────────────────
          Two audiences, and the first one's answer is "nothing". Saying that
          out loud is the point: a user who has just been shown a credential
          assumes there is a step left for them, and for eight of these ten
          there is not. */}
      {connected && (
        <section className="integration-steps">
          <h3>Using it</h3>
          <p className="integration-usage">
            {manual ?
              `${integration.name} needs this value itself — put it where ${integration.configLabel} expects it and it will send it on every call.` :
              `${integration.name} does not need anything from you: the key is already in ${configPath} and it is sent on every call. It is shown above so you know what exists and can revoke it.`}
          </p>
          <div className="integration-facts is-columns">
            <div>
              <span>Base URL</span>
              <code>{base}</code>
            </div>
            <div>
              <span>Every /v1/* request</span>
              <code>Authorization: Bearer &lt;key&gt;</code>
            </div>
          </div>
          <p className="integration-usage">
            That URL is loopback — it answers here and nowhere else. Agents call
            the MCP tools by name rather than using it; plain HTTP is for the
            things that are not MCP clients, like your own scripts. Every
            endpoint and a curl example for each are on the API page on the
            website — the MCP &amp; Agents tab links to it.
          </p>
        </section>
      )}

      {/* ── Reference ──────────────────────────────────────────────────────
          Below the fold of the flow: worth having, never the next move.

          Open before connecting, because there it is the argument for doing so;
          folded away afterwards, because a dialog you opened to check on a live
          connection should not make you scroll past the sales pitch to reach
          the key. */}
      {connected ? (
        <details className="integration-guide">
          <summary>Tools it gets</summary>
          <div className="integration-guide-body">
            <ul className="integration-tools">
              {MCP_TOOL_SUMMARY.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <CopyPromptButton />
          </div>
        </details>
      ) : (
        <section className="integration-steps">
          <h3>Tools it gets</h3>
          <ul className="integration-tools">
            {MCP_TOOL_SUMMARY.map((line) => <li key={line}>{line}</li>)}
          </ul>
          <CopyPromptButton />
        </section>
      )}

      <div className="integration-facts">
        <div>
          <span>{manual ? 'Paste into' : 'Writes to'}</span>
          <code title={configPath}>{configPath}</code>
        </div>
        <div>
          <span>Local API</span>
          <code>{base} ({apiState?.status || 'unknown'})</code>
        </div>
        {!manual && (
          // The path, not a verdict. "Detected" is a claim the user cannot
          // check; the bundle or file that was found is a fact they can.
          <div>
            <span>{integration.name}</span>
            <code title={config?.installedEvidence}>
              {config?.installed ?
                config.installedEvidence || 'found on this machine' :
                'not found on this machine'}
            </code>
          </div>
        )}
      </div>

      {undetected && !connected && (
        <p className="apply-status-note">
          {integration.name} was not found on this machine. You can still write the
          settings now — they are harmless on their own and will be waiting when you
          install it.
        </p>
      )}

      {needsRepair && (
        <p className="apply-status-error">
          <TriangleAlert size={14} /> This connection points at a server that is not
          installed. Repair rewrites it to use the one bundled in this app, keeping
          your existing key.
        </p>
      )}

      {result && (
        <p className={result.ok ? 'apply-status-ok' : 'apply-status-error'}>{result.message}</p>
      )}

      {/* Per-check rather than one verdict: "not ready" tells a user nothing
          about which of five independent things to go and fix. */}
      {verification && (
        <ul className="integration-checks">
          {verification.checks.map((check) => (
            <li key={check.id} className={check.ok ? 'is-ok' : 'is-bad'}>
              {check.ok ? <Check size={14} /> : <X size={14} />}
              <div>
                <strong>{check.label}</strong>
                {check.detail && <span>{check.detail}</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ── The one-time secret ────────────────────────────────────────────
          Last, because it is the thing to act on before this dialog closes,
          and last is where the eye finishes. Only the manual integrations ever
          reach this: for the other eight the token goes straight into a config
          file and the user has no use for it. */}
      {manual && token && (
        <section className="integration-secret">
          <h3>Your key — shown once</h3>
          <p>
            Copy it now. Only a hash is kept here, so once this dialog closes
            this value exists nowhere but wherever you paste it.
          </p>
          <CopyableSecret value={token} fresh />
          <p>Then put it in {integration.configLabel}, like this:</p>
          <CopyableSecret value={manualSnippet(integration, token, base)} />
        </section>
      )}

      {/* The same block before connecting, with a placeholder where the key
          goes: what you are signing up to paste should be visible before you
          mint a credential, not after. */}
      {manual && !token && (
        <section className="integration-secret">
          <h3>What you will paste</h3>
          <CopyableSecret value={manualSnippet(integration, undefined, base)} />
        </section>
      )}
    </Modal>
  );
}

// A one-time secret with a copy button. Shared by the manual-integration token
// above and the newly created key dialog, so both present a raw key the same way.
//
// `fresh` marks the block that has just appeared and will never appear again:
// it draws one accent ring, once, so the value does not arrive as another slab
// of monospace in a dialog that already has two. The ring is suppressed under
// prefers-reduced-motion, where it becomes a static border of the same colour.
// A ready-made first message for the connected agent, one click to the
// clipboard. Same fire-and-forget copy as CopyableSecret: the value is not a
// secret and the paste target is another app, so there is nothing to confirm.
function CopyPromptButton() {
  return (
    <button
      className="ghost"
      onClick={() => { void navigator.clipboard.writeText(AGENT_STARTER_PROMPT); }}
      title="Copy a starter prompt to paste into the agent"
      type="button"
    >
      <Copy size={14} /> Copy prompt
    </button>
  );
}

export function CopyableSecret({value, fresh}: {value: string; fresh?: boolean}) {
  return (
    <div className={fresh ? 'snippet-block is-fresh' : 'snippet-block'}>
      <button
        className="snippet-copy"
        onClick={() => { void navigator.clipboard.writeText(value); }}
        title="Copy to clipboard"
      >
        <Copy size={14} /> Copy
      </button>
      <pre>{value}</pre>
    </div>
  );
}
