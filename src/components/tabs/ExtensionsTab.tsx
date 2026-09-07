// The Extensions tab: what this org has, and what it could add.
//
// Split out of SimpleTabs.tsx the same way Cookies and Bookmarks were -- it
// grew two views and a card grid, which is past what "a list and nothing else"
// covers.
//
// Two views rather than two tabs in the rail. Installing is something you do
// once and then forget, so it does not deserve permanent nav real estate; but
// it is also the answer to "where do I get more", which a modal hidden behind
// an Add button was never going to be. The chips are the same control the
// proxy-mode selector uses.
//
// No panel around any of this. The cards *are* the content, so wrapping them
// in a raised white sheet stacked a surface on a surface and made the page
// read as one object containing small ones rather than as a set of things.
//
// Installed is a single grid, not "Bundled" plus "Added by your team". Two
// headed sections meant a fresh install opened on a heading followed by an
// apology -- "No extensions added yet" -- for a state that is not a problem
// and needs no words. The badge on each card already says where it came from,
// and the grid ends in an Add tile, so the same information is there as an
// invitation instead of an absence.
import {useEffect, useState} from 'react';
import {BadgeCheck, Check, Download, FolderUp, Link2, Plus, ShieldCheck, Trash2} from 'lucide-react';
import {Badge} from '../ui/Badge';
import {ExtensionMark} from '../ui/icons';
import {
  BUILT_IN_EXTENSIONS, CATALOG_CATEGORIES, EXTENSION_CATALOG, builtInExtensionEnabled,
  extensionLogo,
} from '../../data/extensionCatalog';
import {native} from '../../native';
import {useOrg} from '../../org';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ReactNode} from 'react';
import type {BuiltInExtension, CatalogExtension} from '../../data/extensionCatalog';
import type {SharedExtension} from '../../types';

type View = 'installed' | 'discover';

export function ExtensionsTab({onAddExtension}: {onAddExtension: () => void}) {
  const {data, library} = useWorkspace();
  const [view, setView] = useState<View>('installed');
  // Bundled plus shared, which is what "Installed" means on the chip above and
  // in the grid below. Off ones are still installed, so this is not a count of
  // what is running.
  const installedCount =
    BUILT_IN_EXTENSIONS.length + data.state.shared_extensions.length;

  return (
    <section className="extensions-tab">
      {/* The tab's frame, on the same paper surface the Integrations bar uses:
          what you are looking at on the left, how many of them and how to get
          another on the right. Loose on the page these three read as three
          unrelated controls sitting above the cards. */}
      <section className="integration-bar">
        {/* radiogroup, matching the proxy-mode chips in ProfileModal -- these
          * are one choice of two, and a `tablist` would owe the reader
          * aria-controls and real tabpanels that this does not have. */}
        <div className="choice-chips" role="radiogroup" aria-label="Extensions view">
          {(['installed', 'discover'] as const).map((option) => (
            <button
              aria-checked={view === option}
              className={view === option ? 'choice-chip active' : 'choice-chip'}
              key={option}
              onClick={() => setView(option)}
              role="radio"
              type="button"
            >
              {option === 'installed' ? 'Installed' : 'Discover'}
            </button>
          ))}
        </div>
        <div className="integration-bar-side">
          <span className="integration-bar-count">
            <strong>{installedCount}</strong> installed
          </span>
          <button className="ghost" onClick={onAddExtension}>
            <Link2 size={16} /> Add from link
          </button>
          {/* Straight to the OS folder picker -- there is nothing to type
              first, so a dialog before it would be an empty stop. */}
          <button className="ghost" onClick={() => void library.addExtensionFromFolder()}>
            <FolderUp size={16} /> Add from folder
          </button>
        </div>
      </section>

      {view === 'installed' ?
        <InstalledView onBrowse={() => setView('discover')} /> :
        <DiscoverView />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------

function InstalledView({onBrowse}: {onBrowse: () => void}) {
  const org = useOrg();
  const {data} = useWorkspace();

  return (
    <>
      {/* Shaped like the Integrations tab's note, for the same reason: it is a
          standing fact about the screen rather than a message about something
          that just happened, and a bare grey paragraph above a grid of cards
          reads as a caption for the first card. */}
      {/* Shown to everyone, not only to the people who cannot act on it. It used
          to be a permission warning for members; as of 2026-08-10 every member
          may change these, which makes the org-wide blast radius the thing worth
          saying -- and worth saying to the person about to click. */}
      {org.orgId && (
        <section className="api-note">
          <ShieldCheck size={18} />
          <span>
            The bundled extensions apply to everyone in {org.org?.name || 'this organization'},
            so turning one off turns it off for the whole team.
          </span>
        </section>
      )}

      <div className="extension-grid">
        {BUILT_IN_EXTENSIONS.map((entry) => (
          <BuiltInExtensionCard entry={entry} key={entry.key} />
        ))}

        {data.state.shared_extensions.map((extension) => (
          <SharedExtensionCard extension={extension} key={extension.id} />
        ))}

        {/* Last tile rather than a separate button, on the pattern the start
          * page's bookmark grid already uses: the way to get another one of
          * these sits where the next one would go. */}
        <button className="extension-card extension-add-tile" onClick={onBrowse} type="button">
          <span className="extension-add-icon"><Plus size={20} strokeWidth={1.75} /></span>
          <span className="extension-add-label">Add an extension</span>
          <span className="extension-add-hint">Browse the catalog</span>
        </button>
      </div>
    </>
  );
}

// A built-in card. Most are a plain switch, because their files are vendored in
// extensions/ and are always there. One is not: Captcha Plugin's ~56 MB comes
// from the Web Store on demand, so its first enable has to fetch before the
// org's toggle can honestly say it is on.
//
// The org toggle is shared but the bytes are per machine, so "on" and
// "downloaded" are genuinely different facts and the card reads both.
function BuiltInExtensionCard({entry}: {entry: BuiltInExtension}) {
  const {data, library} = useWorkspace();
  const enabled = builtInExtensionEnabled(data.state.built_in_extensions, entry);
  const [installed, setInstalled] = useState(!entry.downloadsOnEnable);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState('');

  // Whether this machine has the files, and progress for a download already
  // running (this window's, or the catch-up pass started at sign-in).
  useEffect(() => {
    if (!entry.downloadsOnEnable) {
      return undefined;
    }
    let live = true;
    void native?.builtInExtensionStatus?.().then((status) => {
      if (live) setInstalled(Boolean(status?.installed?.[entry.key]));
    });
    const stop = native?.onBuiltInDownloadProgress?.((progress) => {
      if (!live || progress.key !== entry.key) return;
      setPercent(progress.totalBytes ?
        Math.floor((progress.receivedBytes / progress.totalBytes) * 100) : null);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [entry.downloadsOnEnable, entry.key]);

  const downloading = percent !== null && !installed;

  async function toggle(next: boolean) {
    setError('');
    // Turning off never deletes the download: the files stay cached so turning
    // it back on is instant, and a teammate toggling it off on their machine
    // should not cost everyone else 56 MB again.
    if (!next || installed || !entry.downloadsOnEnable) {
      void library.setBuiltInExtensionEnabled(entry.key, next);
      return;
    }
    setPercent(0);
    const result = await native?.installBuiltInExtension?.(entry.key);
    setPercent(null);
    // The toggle is only written once the bytes are actually on disk. Writing
    // it first would leave every profile in the org claiming an extension they
    // then silently launch without.
    if (result?.ok) {
      setInstalled(true);
      void library.setBuiltInExtensionEnabled(entry.key, true);
      return;
    }
    setError(result?.error || 'Download failed. Check your connection and try again.');
  }

  return (
    <ExtensionCard
      badge="Included"
      enabled={enabled}
      logo={extensionLogo(entry.slug)}
      name={entry.name}
      note={entry.note}
      onToggle={(next) => void toggle(next)}
      status={
        downloading ? `Downloading… ${percent}%` :
          error ? <span className="extension-card-error">{error}</span> : null
      }
      tagline={entry.tagline}
      tint={entry.tint}
      toggleDisabled={downloading}
      verified
    />
  );
}

function SharedExtensionCard({extension}: {extension: SharedExtension}) {
  const {library} = useWorkspace();
  // Only Web Store entries can be matched to catalog artwork: a folder upload
  // has no id we could have shipped an icon for.
  const catalogEntry = EXTENSION_CATALOG.find((entry) => entry.id === extension.webstoreId);

  return (
    <ExtensionCard
      action={
        <button
          aria-label={`Remove ${extension.name || extension.id}`}
          className="icon-button extension-remove"
          onClick={() => void library.removeExtension(extension.id)}
        >
          <Trash2 size={16} />
        </button>
      }
      badge={extension.source === 'webstore' ? 'Web Store' : 'Shared folder'}
      enabled={extension.enabled !== false}
      logo={extensionLogo(catalogEntry?.slug)}
      name={extension.name || extension.id}
      onToggle={(next) => void library.setExtensionEnabled(extension.id, next)}
      tagline={catalogEntry?.tagline || 'Loads into every profile this organization launches.'}
    />
  );
}

// ---------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------

// Twelve entries in four labelled groups. No search box: a filter earns its
// place when scrolling is the slower way to find something, and at this size
// the whole catalog fits in about a screen. Anything not here is reached by
// pasting its Web Store link, which is what the header button is for.
function DiscoverView() {
  const {data, library} = useWorkspace();
  // Matched on the Web Store id, not the name: the name is whatever whoever
  // added it typed, and an extension added by link would otherwise still read
  // as installable here.
  const installedIds = new Set(
      data.state.shared_extensions.map((extension) => extension.webstoreId));

  return (
    <>
      {CATALOG_CATEGORIES.map((category) => (
        <section className="extensions-category" key={category.id}>
          <h2 className="extensions-group">{category.label}</h2>
          <div className="extension-grid">
            {EXTENSION_CATALOG
                .filter((entry) => entry.category === category.id)
                .map((entry) => (
                  <CatalogCard
                    entry={entry}
                    installed={installedIds.has(entry.id)}
                    key={entry.id}
                    onInstall={() => void library.addExtensionFromWebStore(entry.id, entry.name)}
                  />
                ))}
          </div>
        </section>
      ))}
    </>
  );
}

function CatalogCard({entry, installed, onInstall}: {
  entry: CatalogExtension;
  installed: boolean;
  onInstall: () => void;
}) {
  return (
    <article className="extension-card">
      <div className="extension-card-head">
        <ExtensionMark logo={extensionLogo(entry.slug)} />
        <h3>{entry.name}</h3>
        {/* Green, the same tone Connected takes on the Integrations tab: this
            is the one chip in the catalog that means "already yours", and it
            answers the Install button that would otherwise be here. */}
        {installed && <Badge tone="active" icon={<Check size={12} />}>Installed</Badge>}
      </div>
      <p>{entry.tagline}</p>
      {!installed && (
        <div className="extension-card-foot">
          <button onClick={onInstall}><Download size={16} /> Install</button>
        </div>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------
// The card both views share
// ---------------------------------------------------------------------------

function ExtensionCard({action, badge, enabled, logo, name, note, onToggle, status, tagline, tint,
  toggleDisabled, verified}: {
  action?: ReactNode;
  badge: string;
  enabled: boolean;
  logo?: string;
  name: string;
  note?: string;
  onToggle: (enabled: boolean) => void;
  // Beside the switch: what is happening right now (a download's progress, why
  // one failed), as opposed to `note`, which is a standing fact about the
  // extension.
  status?: ReactNode;
  tagline: string;
  tint?: boolean;
  toggleDisabled?: boolean;
  verified?: boolean;
}) {
  return (
    <article className={`extension-card ${enabled ? '' : 'is-off'}`.trim()}>
      <div className="extension-card-head">
        <ExtensionMark logo={logo} tint={tint} />
        <h3>{name}</h3>
        {/* Where an extension came from, beside its name rather than in the
          * card's foot -- it is part of the extension's identity, not of the
          * controls. Bundled ones carry a verified mark in the blue "checked
          * fact" tone: they ship with Scout Web and were not fetched from a store,
          * which is the one thing about a browser extension worth vouching for.
          * Everything else -- Web Store, Shared folder -- states its provenance
          * in the neutral tone and makes no claim about it. */}
        <Badge
          tone={verified ? 'info' : 'neutral'}
          icon={verified ? <BadgeCheck size={12} /> : undefined}
        >
          {badge}
        </Badge>
        {action}
      </div>
      <p>{tagline}</p>
      {note && <p className="extension-card-note">{note}</p>}
      <div className="extension-card-foot">
        {status && <span className="extension-card-status">{status}</span>}
        <label className="switch" aria-label={`${enabled ? 'Disable' : 'Enable'} ${name}`}>
          <input
            checked={enabled}
            disabled={toggleDisabled}
            onChange={(event) => onToggle(event.target.checked)}
            type="checkbox"
          />
          <span className="switch-track"><span className="switch-thumb" /></span>
        </label>
      </div>
    </article>
  );
}
