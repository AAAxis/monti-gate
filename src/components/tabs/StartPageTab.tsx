// The Start page: a search box over the shared bookmarks and the automations
// pinned to start pages, laid out the way the injected browser home page lays
// them out. It used to be BookmarksTab in SimpleTabs.tsx -- a plain management
// card grid -- and moved out here for the same reason Cookies did, once it
// stopped being a list and nothing else.
//
// It is deliberately a preview of the generated page (src/lib/homePage.ts) and
// the place you decide what goes on it, in that order: same 640px column, same
// five-tile grid, same two sections. What you can do here that you cannot do
// there is choose -- pin a workflow, add a bookmark. Running is the browser's
// job, because a run needs a profile and a session, and this tab has neither.
//
// The bookmarks and the automations are org-shared Supabase rows; only the
// search engine choice is per-machine (see lib/searchEngines.ts).
import {useState} from 'react';
import {
  Bookmark, ChevronDown, Cookie, ExternalLink, Globe, Info, Monitor, Pencil, Play, Plus,
  RefreshCw, Search, Shield, Workflow, X,
} from 'lucide-react';
import type {LucideIcon} from 'lucide-react';
import {BookmarkFavicon} from '../ui/BookmarkFavicon';
import {Popover} from '../ui/Popover';
import {StatusChip} from '../ui/StatusChip';
import {normalizeBookmarkUrl} from '../../lib/bookmarks';
import {
  SEARCH_ENGINES,
  readSearchEngine,
  resolveQuery,
  writeSearchEngine,
} from '../../lib/searchEngines';
import {startPageAutomations} from '../../lib/startPageAutomations';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {SearchEngine} from '../../lib/searchEngines';
import type {MontiAutomation, SharedBookmark} from '../../types';

export function StartPageTab({onEditBookmark, onAddBookmark}: {
  onEditBookmark: (bookmark: SharedBookmark) => void;
  onAddBookmark: () => void;
}) {
  const {data} = useWorkspace();
  const bookmarks = data.state.shared_bookmarks;

  return (
    <section className="start-page">
      {/* The mark, above the search box on both surfaces. The generated browser
          page opens on an anonymous session with nothing on it that says who
          made it; this tab is the preview of that page, so it carries the same
          thing in the same place or the two stop matching.
          A masked span rather than an <img>: the art is black line work and
          would disappear against the dark theme. Same construction as the
          sidebar's .brand-mark. */}
      <p className="start-brand">
        <span aria-hidden="true" className="start-brand-mark" />
        <span className="visually-hidden">Scout Web</span>
      </p>
      <SearchBox />
      {/* The same note block the Integrations and Extensions tabs use, above the
          grid rather than under it. This was a bare grey sentence below the
          tiles, which put the one line explaining what the tab is for after the
          thing it explains -- and left the Add tile looking like the whole
          answer to an empty page. Only shown while the grid is empty: on a tab
          you aim at rather than read, a standing paragraph is in the way. */}
      {bookmarks.length === 0 && (
        <section className="api-note">
          <Bookmark size={18} />
          <span>
            No shared bookmarks yet. Add one and it appears here and on every
            profile's browser start page.
          </span>
        </section>
      )}
      <section className="start-section">
        <SectionLabel
          mark={Bookmark}
          note="Shared across the workspace. Added here, and they appear on every profile's start page."
          title="Bookmarks"
        />
        <div className="start-grid">
          {bookmarks.map((bookmark) => (
            <BookmarkTile
              bookmark={bookmark}
              key={`${bookmark.title}-${bookmark.url}`}
              onEdit={() => onEditBookmark(bookmark)}
            />
          ))}
          <button className="start-tile start-tile-add" onClick={onAddBookmark}>
            <span className="start-tile-icon"><Plus size={20} /></span>
            <span className="start-tile-label">Add</span>
          </button>
        </div>
      </section>
      <AutomationSection />
      <SessionPreview />
    </section>
  );
}

// A section's heading, its optional mark, and the rounded (i) carrying its one
// explanatory sentence.
//
// The sentence used to be a standing paragraph under the Automations heading.
// It explains a thing you learn once and then never need again, so on a tab you
// aim at rather than read it was permanently in the way -- and the generated
// browser page had no room for it at all, which is the second reason it moved:
// the two surfaces can now carry the same heading and the same sentence.
//
// The sentence used to sit in title= and be drawn by the browser, which on the
// generated page never drew it at all -- the cursor turned to help and nothing
// followed. Both surfaces now draw their own bubble off data-tip (.start-label-info
// here, .label-info in lib/homePage.ts), which is a rule this app can be held to
// rather than a courtesy it has to hope for. A <button> rather than a <span> so
// it is reachable without a mouse.
//
// Every heading carries a mark, so the three blocks are told apart by shape
// before they are read. Only Automations used to have one and it was the Scout Web
// mark -- the brand mark from the top of this tab repeating itself about the
// wrong noun. They are lucide's Bookmark, Workflow and Shield now: Workflow is
// what the sidebar rail gives the Automations tab (data/tabs.ts), Shield is
// what the browser side panel wears in its header, and the same three are
// inlined in lib/homePage.ts so both surfaces label a section identically.
function SectionLabel({title, note, mark: Mark}: {
  title: string;
  note: string;
  mark: LucideIcon;
}) {
  return (
    <h2 className="start-section-label">
      <Mark aria-hidden="true" size={16} />
      {title}
      <button aria-label={note} className="start-label-info" data-tip={note} type="button">
        <Info size={14} />
      </button>
    </h2>
  );
}

// The session card, as it appears on a profile's browser start page.
//
// A preview with fixed sample values, and it says so: this tab has no profile
// and no session, so every number here would otherwise be phantom data. It is
// here because this tab is where you decide what the start page carries, and
// deciding that without being able to see the block that takes up its bottom
// third is deciding blind.
//
// Two layers, and the split is the point: the gray shell carries the session's
// CONTROLS -- what it is, how to take a fresh reading, where to check it against
// someone else's opinion -- and the card inside carries the READING. The three
// rows, their icons and their order are the same three homePage.ts emits, and
// so is that split. Changing one means changing both.
function SessionPreview() {
  return (
    <section className="start-section">
      <SectionLabel
        mark={Shield}
        note="Every profile's start page shows its own live session here: the proxy it is coming out of, the profile's status and platform, and the cookie set it launched with."
        title="Session"
      />
      <div className="start-session-shell">
        <div className="start-session-head">
          <StatusChip status="Ban" />
          <span className="start-session-tag">Preview</span>
          {/* Both drawn, neither pressable -- same argument as the automation
              card's missing Run button: there is no session here to re-check
              and no window to send to ip.me. */}
          <span className="start-session-actions">
            <span className="pill-static"><RefreshCw size={13} />Re-check</span>
            <span className="icon-static"><ExternalLink size={14} /></span>
          </span>
        </div>
        <div className="start-session-card">
          <dl className="start-session-fields">
            <div className="start-field wide">
              <dt><Globe size={15} />Proxy</dt>
              <dd>142.252.99.144:64455 · Los Angeles, California, US · 1126 ms</dd>
            </div>
            <div className="start-field">
              <dt><Monitor size={15} />Platform</dt>
              <dd>Windows 11</dd>
            </div>
            <div className="start-field wide">
              <dt><Cookie size={15} />Cookies</dt>
              <dd>Lisa Martinez (live).json</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

// What the browser's start page will offer as run tiles, and the one place to
// change it.
//
// `pinned` was already a field, but the only way to set it was a checkbox in
// the automation editor's sidebar -- so the page that shows the tiles had no
// say in which tiles it showed, and nothing in the app connected "pin this
// workflow" to "a button appears inside the browser". Pinning here also has a
// consequence worth being able to see: a launch only opens a debugging port
// when it has tiles to run (see useProfileActions.launch), so this list is what
// decides that.
function AutomationSection() {
  const {data, automations: automationActions} = useWorkspace();
  // Trashed workflows are still in state -- Trash is a view of this list, not
  // a second read -- so every surface that offers one has to say so.
  const all = data.state.automations.filter((item) => !item.deleted_at);
  const pinned = startPageAutomations(all);
  const unpinned = all.filter((item) => !item.pinned);

  // Nothing to pin and nothing pinned: a section header over an Add tile that
  // opens an empty menu is worse than no section. The Automations tab is where
  // a workflow gets made, and it says so there.
  if (all.length === 0) {
    return null;
  }

  return (
    <section className="start-section">
      <SectionLabel
        mark={Workflow}
        note={"Pinned workflows appear on every profile's browser start page " +
          "and run from there in that profile's session."}
        title="Automations"
      />
      <div className="start-card-grid">
        {pinned.map((automation) => (
          <AutomationCard
            automation={automation}
            key={automation.id}
            onUnpin={() => void automationActions.setPinned(automation, false)}
          />
        ))}
        {/* Disabled rather than hidden once everything is pinned: the tile is
          * how you learn this row is something you control, and a control that
          * vanishes when it has nothing left to offer teaches nothing. */}
        <Popover
          disabled={unpinned.length === 0}
          label="Pin an automation"
          panelClassName="engine-menu"
          trigger={
            <>
              <span className="start-card-icon"><Plus size={17} /></span>
              <span className="start-card-text"><strong>Pin</strong></span>
            </>
          }
          triggerClassName="start-card start-card-add"
          width={220}
        >
          {(close) => unpinned.map((automation) => (
            <button
              className="engine-option"
              key={automation.id}
              onClick={() => {
                void automationActions.setPinned(automation, true);
                close();
              }}
            >
              {automation.name}
            </button>
          ))}
        </Popover>
      </div>
    </section>
  );
}

// A card, matching the generated page's automation cards rather than the
// bookmark tiles beside them: a shortcut takes you somewhere and a workflow
// does something to a profile, and at tile size there was no room to say which
// workflow this is or what it costs to press.
//
// It carries the card's shape and none of its controls. The browser's card has
// a Run button and an open-in-launcher button; neither has any meaning here --
// a run needs a profile and a session, which this tab has neither of, and the
// launcher is already open. The X is the only thing on it you can press, and
// that one is a real button.
function AutomationCard({automation, onUnpin}: {
  automation: MontiAutomation;
  onUnpin: () => void;
}) {
  const label = automation.name || 'Automation';
  // The description if there is one, else the length -- the same fallback the
  // generated page uses, so a workflow with no description reads identically on
  // both surfaces.
  const steps = automation.steps?.length || 0;
  const sub = automation.description?.trim() || `${steps} step${steps === 1 ? '' : 's'}`;
  return (
    <div className="start-card">
      <span className="start-card-icon"><Play size={17} /></span>
      <div className="start-card-text">
        <strong title={label}>{label}</strong>
        <small title={sub}>{sub}</small>
      </div>
      {/* The card's third slot. On the browser's card this holds Run and
        * open-in-launcher; here it holds the one control that has any meaning,
        * and only while the card is hovered or focused. */}
      <div className="start-card-actions">
        <button
          aria-label={`Remove ${label} from start pages`}
          className="icon-button start-card-unpin"
          onClick={onUnpin}
          title="Remove from start pages"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}

function SearchBox() {
  // Read once on mount rather than on every render: localStorage is the source
  // of truth across restarts, this state is the source of truth within a session.
  const [engine, setEngine] = useState<SearchEngine>(readSearchEngine);
  const [query, setQuery] = useState('');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const url = resolveQuery(query, engine);
    if (!url) {
      return;
    }
    window.open(url, '_blank');
    setQuery('');
  }

  function pick(next: SearchEngine) {
    writeSearchEngine(next.id);
    setEngine(next);
  }

  return (
    <form className="start-search" onSubmit={submit}>
      <Search className="start-search-icon" size={17} />
      <input
        aria-label="Search or enter address"
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search ${engine.name} or enter address`}
        type="text"
        value={query}
      />
      <Popover
        label="Search engine"
        panelClassName="engine-menu"
        trigger={<>{engine.name}<ChevronDown size={14} /></>}
        triggerClassName="start-engine"
        width={180}
      >
        {(close) => SEARCH_ENGINES.map((option) => (
          <button
            className={option.id === engine.id ? 'engine-option active' : 'engine-option'}
            key={option.id}
            onClick={() => {
              pick(option);
              close();
            }}
          >
            {option.name}
          </button>
        ))}
      </Popover>
    </form>
  );
}

function BookmarkTile({bookmark, onEdit}: {
  bookmark: SharedBookmark;
  onEdit: () => void;
}) {
  const url = normalizeBookmarkUrl(bookmark.url);
  const label = bookmark.title || url;
  return (
    <div className="start-tile">
      {/* The whole tile opens the site; Edit sits on top of it, so it has to be
        * a sibling rather than a child -- a button inside an anchor is invalid
        * and clicking it would navigate as well as open the dialog. */}
      <a className="start-tile-open" href={url} onClick={(event) => {
        event.preventDefault();
        window.open(url, '_blank');
      }} title={url}>
        <span className="start-tile-icon"><BookmarkFavicon bookmark={bookmark} /></span>
        <span className="start-tile-label">{label}</span>
      </a>
      <button
        aria-label={`Edit ${label}`}
        className="icon-button start-tile-edit"
        onClick={onEdit}
        title="Edit"
      >
        <Pencil size={13} />
      </button>
    </div>
  );
}
