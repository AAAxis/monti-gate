// The Connectors view of the Automations tab: the workspace's AI endpoints and
// messaging targets, as cards on the same grid metrics as the automations.
//
// Cards rather than settings rows because these moved OUT of Settings: a
// connector is only ever used from an automation, so it lives beside them --
// one connector kind among several, not a screen of its own.
//
// Members see everything read-only with secrets masked. The masking is a
// courtesy and NOT a boundary: every org member can read the `config` column
// (that is what lets a teammate run a shared workflow), so hiding the value
// here only keeps it off screens and screenshots. Writes are owner-only, and
// that IS enforced -- by RLS, with the buttons hidden to match.
import {useState} from 'react';
import {
  Cable, Check, Hash, Mail, MessageCircle, Phone, Plus, Send, Sparkles, X,
} from 'lucide-react';
import {Badge} from '../ui/Badge';
import {BusyButton} from '../ui/BusyButton';
import {native} from '../../native';
import {
  connectorLogo, connectorLogoAdapt, presetFor, runtimeConnector, secretKeysFor,
} from '../../data/connectors';
import {useOrg} from '../../org';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ConnectorPreset} from '../../data/connectors';
import type {ScoutConnector} from '../../types';

// Preset icon keys -> glyphs. A map rather than dynamic lookup for the same
// reason automations/icons.ts has one: lucide is imported by name and a key
// that misses falls back to the neutral plug.
const ICONS: Record<string, typeof Cable> = {
  'sparkles': Sparkles,
  'send': Send,
  'hash': Hash,
  'message-circle': MessageCircle,
  'phone': Phone,
  'mail': Mail,
};

export function connectorGlyph(preset: ConnectorPreset | null): typeof Cable {
  return (preset && ICONS[preset.icon]) || Cable;
}

// A kind's mark: the brand image when one exists (assets/connectors, falling
// back to the tag catalogue's cut in assets/brands), the lucide glyph when
// none does. Through <img> with its own colours, the same route the tag marks
// take -- see assets/connectors/README.md.
export function ConnectorMark({kind, preset, size = 20}: {
  kind: string;
  preset: ConnectorPreset | null;
  size?: number;
}) {
  const logo = connectorLogo(kind);
  if (logo) {
    const adapt = connectorLogoAdapt(kind);
    return (
      <img
        alt=""
        className={adapt ? `connector-logo ${adapt}` : 'connector-logo'}
        src={logo}
        style={{height: size - 2}}
      />
    );
  }
  const Glyph = connectorGlyph(preset);
  return <Glyph size={size} strokeWidth={1.75} />;
}

// The last four characters, which are there so the value can be compared
// against the credential the user holds -- the only thing a masked secret is
// for.
function maskSecret(value: string): string {
  return value.length > 4 ? `••••${value.slice(-4)}` : '••••';
}

// One line of non-secret fact per card, chosen per kind: the model for an AI
// connector, the chat for a bot, the host for a webhook or mail server. Never
// a secret -- a webhook URL's path is the credential, so only its host shows.
function detailFor(connector: ScoutConnector): string {
  const config = connector.config || {};
  switch (connector.kind) {
    case 'telegram':
      return config.chatId ? `chat ${config.chatId}` : '';
    case 'slack':
    case 'discord':
      try {
        return new URL(config.webhookUrl || '').host;
      } catch {
        return '';
      }
    case 'whatsapp':
      return config.to ? `to ${config.to}` : '';
    case 'smtp':
      return [config.host, config.to ? `to ${config.to}` : ''].filter(Boolean).join(' · ');
    default:
      return config.model || '';
  }
}

type TestResult = {ok: boolean; message: string};

function ConnectorCard({connector, canEdit, onEdit}: {
  connector: ScoutConnector;
  canEdit: boolean;
  onEdit: (connector: ScoutConnector) => void;
}) {
  const {connectors, toast} = useWorkspace();
  const preset = presetFor(connector.kind);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);

  const secretKey = secretKeysFor(connector.kind)
      .find((key) => (connector.config || {})[key]);
  const secretValue = secretKey ? connector.config[secretKey] : '';
  const detail = detailFor(connector);

  // The smallest real thing the service allows: one tiny completion, or one
  // real message. Available to members too -- they run these connectors, so
  // being able to diagnose one is the point of the button.
  async function runTest() {
    setTesting(true);
    setTest(null);
    const answer = await native?.testConnector?.(runtimeConnector(connector));
    setTesting(false);
    setTest(answer ?
      {
        ok: answer.ok,
        message: answer.ok ?
          (connector.category === 'message' ? 'Message sent.' : 'Replied ok.') :
          answer.error || 'The test did not run.',
      } :
      {ok: false, message: 'Testing needs the desktop app.'});
  }

  async function remove() {
    // The consequence named before the click: steps keep the id, and the run
    // that hits it will fail with "this connector no longer exists".
    if (!window.confirm(
        `Delete "${connector.name}"? Steps and automations that name it will fail ` +
        'until they are pointed at another connector.')) {
      return;
    }
    if (await connectors.remove(connector.id)) {
      toast.setMessage(`${connector.name} removed`);
    }
  }

  return (
    <article className="automation-card connector-card">
      <div className="automation-card-head">
        <span aria-hidden="true" className="extension-mark is-fallback">
          <ConnectorMark kind={connector.kind} preset={preset} size={20} />
        </span>
        <h3>{connector.name}</h3>
        {connector.is_default && (
          <Badge tone="active">
            {/* Two defaults coexist -- one per category -- so an unlabelled
                "Default" on two cards would read as a bug. */}
            {connector.category === 'message' ? 'Default messaging' : 'Default AI'}
          </Badge>
        )}
      </div>

      {/* Carries flex:1 like the automation card's description, so card feet
          line up across the row. */}
      <p>
        {preset ?
          [preset.label, detail].filter(Boolean).join(' · ') :
          `This version of Scout Web doesn't recognise "${connector.kind}". ` +
            'It keeps working for newer builds; update the app to edit it here.'}
      </p>

      {secretValue && (
        <div className="automation-card-meta">
          <span className="connector-card-secret" title="Only the last four characters are shown">
            {maskSecret(secretValue)}
          </span>
        </div>
      )}

      {test && (
        <p className={`connector-card-test ${test.ok ? 'is-ok' : 'is-bad'}`}>
          {test.ok ? <Check size={13} /> : <X size={13} />}
          <span>{test.message}</span>
        </p>
      )}

      <div className="extension-card-foot">
        <BusyButton
          busy={testing}
          busyLabel="Testing"
          className="ghost"
          onClick={() => void runTest()}
          title={connector.category === 'message' ?
            'Sends a real test message through this connector' :
            'Asks the model for a one-word reply'}
        >Test</BusyButton>
        {canEdit && (
          <>
            <button className="ghost" onClick={() => onEdit(connector)}>Edit</button>
            {!connector.is_default && (
              <button
                className="ghost"
                onClick={() => void connectors.setDefault(connector.id)}
                title={connector.category === 'message' ?
                  'Steps that name no connector will send through this one' :
                  'AI steps that name no provider will use this one'}
              >Make default</button>
            )}
            <button
              aria-label={`Delete ${connector.name}`}
              className="ghost icon-button connector-card-delete"
              onClick={() => void remove()}
              title="Delete this connector"
              type="button"
            ><X size={14} /></button>
          </>
        )}
      </div>
    </article>
  );
}

export function ConnectorsView({onNew, onEdit}: {
  onNew: () => void;
  onEdit: (connector: ScoutConnector) => void;
}) {
  const {data} = useWorkspace();
  const org = useOrg();
  const canEdit = org.isOwner;
  const list = data.state.connectors;

  if (list.length === 0) {
    return (
      <section className="tab-empty">
        <span className="tab-empty-mark">
          <Cable size={26} strokeWidth={1.5} />
        </span>
        <h2>No connectors yet</h2>
        <p>
          A connector is an outside service your automations can call — an AI model
          to ask mid-run, or a chat to message when something finishes. Steps store
          only the connector&apos;s name; the credential never leaves the workspace.
          {canEdit ? '' : ' An owner of this workspace can add one.'}
        </p>
        {canEdit && (
          <div className="tab-empty-actions">
            <button className="primary" onClick={onNew}>
              <Plus size={18} /> Add your first connector
            </button>
          </div>
        )}
      </section>
    );
  }

  // AI first, then messaging, alphabetical inside each -- so the two halves
  // read as two runs of cards rather than an interleaved shuffle.
  const shown = [...list].sort((a, b) =>
    a.category === b.category ?
      a.name.localeCompare(b.name) :
      (a.category === 'ai' ? -1 : 1));

  return (
    <div className="automation-grid">
      {shown.map((connector) => (
        <ConnectorCard
          canEdit={canEdit}
          connector={connector}
          key={connector.id}
          onEdit={onEdit}
        />
      ))}
      {canEdit && (
        <button className="automation-card extension-add-tile" onClick={onNew} type="button">
          <span className="extension-add-icon"><Plus size={20} strokeWidth={1.75} /></span>
          <span className="extension-add-label">New connector</span>
          <span className="extension-add-hint">An AI model or a chat to message</span>
        </button>
      )}
    </div>
  );
}
