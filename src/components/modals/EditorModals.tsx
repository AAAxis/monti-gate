// The small record editors: proxy, bookmark, folder and custom status. Each is
// a handful of fields over the shared Modal shell.
import {useEffect, useRef, useState} from 'react';
import {
  AlertCircle, Folder as FolderIcon, LayoutGrid, Palette, PlugZap, RefreshCw, Trash2,
} from 'lucide-react';
import {Modal} from '../ui/Modal';
import {BusyButton} from '../ui/BusyButton';
import {CopyButton} from '../ui/CopyButton';
import {ColorPicker} from '../ui/ColorPicker';
import {Field} from '../ui/Field';
import {IconPicker} from '../ui/IconPicker';
import {TagChip} from '../ui/TagChip';
import {FlagIcon} from '../ui/icons';
import {normalizeBookmarkUrl} from '../../lib/bookmarks';
import {defaultProxyName, splitPastedConnection} from '../../lib/proxies';
import {tagKey, tagLabel} from '../../lib/tags';
import {
  countryName, DEFAULT_FOLDER_ICON, flagCodeFromIcon, flagIconKey,
} from '../../data/folderIcons';
import {tagFolderColor} from '../../data/tagPresets';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ClipboardEvent} from 'react';
import type {BookmarkDraft, FolderDraft, ProxyDraft, StatusDraft} from '../../drafts';
import type {TagUsage} from '../../lib/tags';
import type {ProxyCheckResult} from '../../native';
import type {FolderKind} from '../../workspace/useLibraryActions';
import type {MontiFolder, MontiProxy, CloudState, SharedBookmark} from '../../types';

export function ProxyModal({draft, source, onChange, onClose, onSaved, onRequestDelete}: {
  draft: ProxyDraft;
  // 'profile' when the dialog was opened from the profile editor's "create new
  // proxy" field, which changes the wording and assigns the result back.
  source: 'profile' | null;
  onChange: (draft: ProxyDraft) => void;
  onClose: () => void;
  onSaved: (proxyId: string, fromProfile: boolean) => void;
  onRequestDelete: (proxyIds: string[], label: string) => void;
}) {
  const {toast, proxies} = useWorkspace();
  const [testResult, setTestResult] = useState<ProxyCheckResult | null>(null);
  const [testing, setTesting] = useState(false);
  // Everything that can stop a save, rendered inside the dialog. It used to be
  // a toast, which the modal backdrop covered -- so "Add proxy" on an invalid
  // host looked like a button that did nothing at all.
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Bumped whenever the connection details change or the dialog unmounts, so a
  // check still running against the old details cannot overwrite the panel with
  // a result for a host the user has since retyped.
  const testRun = useRef(0);

  useEffect(() => () => { testRun.current++; }, []);

  // A result describes the connection details it was run against, so any edit
  // to those invalidates it -- otherwise a green "United States · 84ms" would
  // sit above a host the user has since retyped. Name is not a connection
  // detail, so renaming leaves the result standing.
  const set = (patch: Partial<ProxyDraft>) => {
    const connectionChanged = ['type', 'host', 'port', 'username', 'password']
        .some((key) => key in patch);
    if (connectionChanged) {
      testRun.current++;
      setTestResult(null);
      setTesting(false);
    }
    setError(null);
    onChange({...draft, ...patch});
  };

  // Vendors hand out proxies as one "host:port:username:password" string, and
  // pasting that into Host is the obvious thing to do -- it used to be stored
  // verbatim as the hostname, which curl then rejected outright ("Unsupported
  // proxy syntax"). Anything splitPastedConnection recognises is spread across
  // the fields it belongs in; anything else is left alone as a literal hostname.
  //
  // The parse underneath locates the port rather than trusting its position, so
  // "user:pass@host:port" and "user:pass:host:port" land in the same fields as
  // the usual order. `strict` is set everywhere except Host -- see
  // splitPastedConnection for why Password needs it.
  function applyPastedConnection(raw: string, strict = false) {
    const parsed = splitPastedConnection(raw, {strict});
    if (!parsed) {
      return false;
    }
    testRun.current++;
    setTestResult(null);
    setTesting(false);
    setError(null);
    onChange({
      ...draft,
      // A bare host:port:user:pass carries no scheme, and the parse defaults
      // those to socks5; keep whatever the user already picked instead of
      // silently switching the type under them.
      type: parsed.explicitType ? parsed.type || draft.type : draft.type,
      // The line the user pasted is usually all they have: there is no name in
      // it, and an unnamed proxy is saved as host:port anyway. Filling it now
      // means the field they pasted into does not sit empty while the fields
      // below it fill -- and anything they have already typed is left alone.
      name: draft.name.trim() || defaultProxyName(parsed.host, parsed.port),
      host: parsed.host,
      port: String(parsed.port),
      username: parsed.username || '',
      password: parsed.password || '',
    });
    return true;
  }

  // Every connection field takes a whole line, not just Host. This dialog opens
  // with Name focused, so the first Cmd-V of a vendor's
  // "206.251.200.232:43645:user:pass" went into the name box and left the four
  // fields under it empty -- the paste has to be caught wherever it lands.
  function onConnectionPaste(event: ClipboardEvent<HTMLInputElement>) {
    if (applyPastedConnection(event.clipboardData.getData('text'), true)) {
      event.preventDefault();
    }
  }

  // Host plus a port in range is all either action needs; save() and
  // testConnection() share it so they can never disagree about what is valid.
  function connection() {
    const host = draft.host.trim();
    const port = Number(draft.port);
    if (!host) {
      setError('Enter the proxy host, or paste the full host:port:username:password line.');
      return null;
    }
    // The single most common way to get here: the whole connection string went
    // into Host and the port never got filled in. Say so, instead of the old
    // generic "host and valid port are required".
    if (host.includes(':')) {
      setError('That looks like a full connection string. Paste it again and it will be split into the fields below.');
      return null;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setError('Enter a port between 1 and 65535.');
      return null;
    }
    return {host, port, type: draft.type, username: draft.username.trim(), password: draft.password};
  }

  // Fire-and-forget: the dialog stays fully interactive while this runs, and
  // the result is recorded against the saved row by the workspace action, so
  // closing the editor mid-check still updates the card behind it.
  function test() {
    const config = connection();
    if (!config) {
      return;
    }
    const run = ++testRun.current;
    setTesting(true);
    setTestResult(null);
    void proxies.testConnectionAndRecord(config, draft.id).then((result) => {
      if (testRun.current !== run) {
        return;
      }
      setTesting(false);
      setTestResult(result);
    });
  }

  async function save() {
    const config = connection();
    if (!config) {
      return;
    }
    setSaving(true);
    const result = await proxies.save({
      id: draft.id,
      name: draft.name.trim(),
      ...config,
    });
    setSaving(false);
    const saved = result.proxy;
    if (!saved) {
      setError(result.error || 'Could not save this proxy.');
      return;
    }
    const fromProfile = !draft.id && source === 'profile';
    onSaved(saved.id, fromProfile);
    toast.setMessage(fromProfile ? `${saved.name} proxy created and assigned` : `${saved.name} saved`);
  }

  return (
    <Modal
      className="small-modal proxy-modal"
      onClose={onClose}
      title={draft.id ? 'Edit proxy' : source === 'profile' ? 'Name your proxy' : 'Add proxy'}
      subtitle={source === 'profile' ?
        'Create a proxy and assign it to this profile.' :
        'Proxy settings are stored in EasyDeck and assigned to profiles on launch.'}
      footer={
        <>
          {draft.id && (
            <button
              className="danger ghost"
              onClick={() => onRequestDelete([draft.id as string], draft.name || draft.host)}
            >
              <Trash2 size={16} /> Delete
            </button>
          )}
          {/* Deliberately not a BusyButton: the check runs in the background,
            * so neither this nor Save is disabled while it is in flight. Click
            * it again and the newer run wins. */}
          <button className="ghost" onClick={test}>
            <PlugZap size={16} /> {testing ? 'Test again' : 'Test connection'}
          </button>
          <BusyButton busy={saving} busyLabel="Saving…" onClick={() => void save()}>
            {draft.id ? 'Save changes' : source === 'profile' ? 'Create and assign' : 'Add proxy'}
          </BusyButton>
        </>
      }
    >
      <div className="profile-form">
        <label className="field">
          <span>Type</span>
          <select
            value={draft.type}
            onChange={(event) => set({type: event.target.value as ProxyDraft['type']})}
          >
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP</option>
          </select>
        </label>
        <label className="field">
          <span>Name</span>
          <input
            autoFocus
            type="text"
            placeholder="US socks proxy"
            value={draft.name}
            onPaste={onConnectionPaste}
            onChange={(event) => set({name: event.target.value})}
          />
        </label>
        <label className="field">
          <span>Host</span>
          <input
            type="text"
            placeholder="1.2.3.4 or host:port:user:pass"
            value={draft.host}
            // Handled on paste rather than on every keystroke: splitting as the
            // user types would rewrite the fields the moment they got as far as
            // "1.2.3.4:8", while they were still typing the port. Not strict --
            // whatever is pasted here was meant to be a host, dotted or not.
            onPaste={(event) => {
              if (applyPastedConnection(event.clipboardData.getData('text'))) {
                event.preventDefault();
              }
            }}
            onChange={(event) => set({host: event.target.value})}
            // Catches the paths onPaste misses -- drag-and-drop, and a string
            // typed out by hand -- once the user has moved on from the field.
            onBlur={(event) => applyPastedConnection(event.target.value)}
          />
        </label>
        <label className="field">
          <span>Port</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="1080"
            value={draft.port}
            onPaste={onConnectionPaste}
            onChange={(event) => set({port: event.target.value.replace(/[^\d]/g, '')})}
          />
        </label>
        <label className="field">
          <span>Username</span>
          <input
            type="text"
            placeholder="Optional"
            value={draft.username}
            onPaste={onConnectionPaste}
            onChange={(event) => set({username: event.target.value})}
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            placeholder="Optional"
            type="password"
            value={draft.password}
            onPaste={onConnectionPaste}
            onChange={(event) => set({password: event.target.value})}
          />
        </label>
        {error && (
          <p className="proxy-test-result failed">
            <AlertCircle size={16} />
            <span>{error}</span>
          </p>
        )}
        {testing && (
          <p className="proxy-test-result pending">
            <RefreshCw size={16} className="btn-spin" />
            <span>Testing in the background — you can keep editing or close this.</span>
          </p>
        )}
        {!testing && testResult && <ProxyTestResult result={testResult} />}
      </div>
    </Modal>
  );
}

// The outcome of "Test connection", inline under the fields rather than in a
// toast: the user is usually still editing the credentials that produced it,
// and a failure they have to re-read is worth more than one that times out.
function ProxyTestResult({result}: {result: ProxyCheckResult}) {
  if (!result.ok) {
    const error = result.error || 'Proxy check failed';
    return (
      // The failure is the one result worth taking somewhere else -- a provider's
      // support chat usually wants the message verbatim -- so it is copyable
      // here rather than something to retype off the screen.
      <p className="proxy-test-result failed">
        <AlertCircle size={16} />
        <span>{error}</span>
        <CopyButton className="link-button proxy-test-copy" value={error} label="Copy" />
      </p>
    );
  }
  const where = result.country || result.countryCode || 'Unknown location';
  return (
    <p className="proxy-test-result ok">
      <span className="proxy-flag"><FlagIcon countryCode={result.countryCode} /></span>
      <span>Connected · {where} · {result.ip || 'No IP'} · {result.pingMs || 0}ms</span>
    </p>
  );
}

export function BookmarkModal({draft, onChange, onClose}: {
  draft: BookmarkDraft;
  onChange: (draft: BookmarkDraft) => void;
  onClose: () => void;
}) {
  const {toast, library} = useWorkspace();
  const set = (patch: Partial<BookmarkDraft>) => onChange({...draft, ...patch});

  async function save() {
    const url = normalizeBookmarkUrl(draft.url);
    if (!url) {
      toast.setMessage('Bookmark URL is required');
      return;
    }
    const bookmark: SharedBookmark = {
      title: draft.title.trim() || url,
      url,
      icon: draft.icon.trim() || undefined,
    };
    if (!await library.saveBookmark(bookmark, draft.originalUrl)) {
      return;
    }
    onClose();
    toast.setMessage(`${bookmark.title} saved`);
  }

  async function remove() {
    if (!draft.originalUrl) {
      onClose();
      return;
    }
    if (!await library.removeBookmark(draft.originalUrl)) {
      return;
    }
    onClose();
    toast.setMessage('Bookmark deleted');
  }

  return (
    <Modal
      // Three stacked fields do not need the profile editor's 1380px. Without
      // this the dialog was as wide as the window for one column of inputs.
      className="small-modal"
      onClose={onClose}
      title={draft.originalUrl ? 'Edit bookmark' : 'Add bookmark'}
      subtitle="Shared bookmarks are injected into each anonymous browser home page."
      footer={
        <>
          {draft.originalUrl && (
            <button className="danger ghost" onClick={() => void remove()}>
              <Trash2 size={16} /> Delete
            </button>
          )}
          <button onClick={() => void save()}>
            {draft.originalUrl ? 'Save changes' : 'Add bookmark'}
          </button>
        </>
      }
    >
      <div className="profile-form">
        <label className="field wide">
          <span>Name</span>
          <input
            type="text"
            autoFocus
            placeholder="Facebook"
            value={draft.title}
            onChange={(event) => set({title: event.target.value})}
          />
        </label>
        <label className="field wide">
          <span>URL</span>
          <input
            type="text"
            placeholder="https://www.facebook.com/"
            value={draft.url}
            onChange={(event) => set({url: event.target.value})}
          />
        </label>
        <label className="field wide">
          <span>Icon URL</span>
          <input
            type="text"
            placeholder="Optional favicon URL"
            value={draft.icon}
            onChange={(event) => set({icon: event.target.value})}
          />
        </label>
      </div>
    </Modal>
  );
}

// Everything the folder dialog says that depends on which library it belongs
// to, in one place.
//
// This was five separate nested ternaries reading `isProxy ? … : isCookie ? …
// : …`, which is a shape that only holds for three kinds -- a fourth turns
// each of them into a four-deep chain, and forgetting one is invisible because
// the profile branch is the fall-through and reads as plausible copy for
// anything. A record keyed by FolderKind cannot be under-filled: leave a kind
// out and typecheck fails.
const FOLDER_COPY: Record<FolderKind, {
  subtitle: string;
  // Used in the delete confirmation, which has to name where the contents go.
  consequence: string;
  namePlaceholder: string;
  iconHint: string;
  colourHint: string;
}> = {
  profile: {
    subtitle: 'Folders organize launcher profiles only. Browser sessions stay separate.',
    consequence: 'Profiles will move to All profiles.',
    namePlaceholder: 'Warmup',
    iconHint: 'Shown next to the folder in the profiles list.',
    colourHint: "Tints the folder's icon in the folder row and in the profiles table.",
  },
  proxy: {
    subtitle:
      'Folders group proxies in your library. Which profile a proxy is assigned to is separate.',
    consequence: 'Proxies will move to All proxies.',
    namePlaceholder: 'United States',
    iconHint: 'A glyph or a country flag, shown next to the folder in the proxies list.',
    colourHint: "Tints the folder's icon in the folder row and in the proxies table.",
  },
  cookie: {
    subtitle: 'Folders group cookie-sets in your library. ' +
      'Which profiles a set is assigned to is separate.',
    consequence: 'Cookie-sets will move to All cookie-sets.',
    namePlaceholder: 'Instagram',
    iconHint: 'Shown next to the folder in the cookie-sets list.',
    colourHint: "Tints the folder's icon in the folder row and in the cookie-sets table.",
  },
  automation: {
    // Says what a folder is NOT, because this is the one library where the
    // obvious wrong guess -- that filing changes what runs -- is a guess
    // somebody will act on.
    subtitle: 'Folders group automations in your library. Schedules, start-page pins ' +
      'and what each one runs against are all separate.',
    consequence: 'Automations will move to All automations.',
    namePlaceholder: 'Warmup',
    iconHint: 'Shown next to the folder in the automations list.',
    colourHint: "Tints the folder's icon in the folder row above the automation grid.",
  },
};

// The state list a folder of this kind lives in.
function foldersOfKind(state: CloudState, kind: FolderKind): MontiFolder[] {
  switch (kind) {
    case 'proxy':
      return state.proxy_folders;
    case 'cookie':
      return state.cookie_folders;
    case 'automation':
      return state.automation_folders;
    default:
      return state.folders;
  }
}

export function FolderModal({draft, onChange, onClose, onCreated}: {
  draft: FolderDraft;
  onChange: (draft: FolderDraft) => void;
  onClose: () => void;
  // The second argument is what the folder was suggested from, when it was: a
  // tag for a profile folder, an ISO country code for a proxy one. The caller
  // uses it to offer the fill; nothing is moved here.
  onCreated: (folderId: string, seed?: string) => void;
}) {
  const {data, toast, library, tagOptions} = useWorkspace();
  const state = data.state;
  const isProxy = draft.kind === 'proxy';
  const isCookie = draft.kind === 'cookie';
  const copy = FOLDER_COPY[draft.kind];
  // Only on create. Re-offering suggestions while editing would invite
  // overwriting a folder someone has already named and filled.
  //
  // Cookie folders get no suggestions in this version: both inputs to
  // folderSuggestions are profile-scoped (the profiles' tags, and the existing
  // profile folders), so offering them here would suggest grouping cookie-sets
  // by what the profiles happen to be tagged. A cookie-side engine is worth
  // adding once there is something to base it on -- the domains in each set.
  const tagIdeas = draft.id || isProxy || isCookie ?
    [] :
    folderSuggestions(tagOptions, state.folders);
  const countryIdeas = draft.id || !isProxy ?
    [] :
    countrySuggestions(state.proxies, state.proxy_folders);
  // Countries this workspace's proxies actually checked into, most-used first,
  // so the flag picker opens on the ones worth filing by.
  const proxyCountries = isProxy ? countriesInUse(state.proxies).map((entry) => entry.code) : [];

  async function save() {
    const name = draft.name.trim();
    if (!name) {
      toast.setMessage('Folder name is required');
      return;
    }
    const fields = {kind: draft.kind, name, icon: draft.icon, color: draft.color};
    if (draft.id) {
      if (!await library.saveFolder(draft.id, fields)) {
        return;
      }
      onClose();
      toast.setMessage(`${name} folder saved`);
      return;
    }
    const folder = await library.createFolder(fields);
    if (!folder) {
      return;
    }
    onCreated(folder.id, seedFor(draft, name));
    onClose();
    toast.setMessage(`${folder.name} folder created`);
  }

  async function remove() {
    const folder = foldersOfKind(state, draft.kind).find((item) => item.id === draft.id);
    onClose();
    if (!folder) {
      return;
    }
    if (!window.confirm(`Delete folder ${folder.name}? ${copy.consequence}`)) {
      return;
    }
    if (await library.removeFolder(folder.id)) {
      toast.setMessage(`${folder.name} folder deleted`);
    }
  }

  return (
    <Modal
      className="small-modal"
      onClose={onClose}
      title={draft.id ? 'Edit folder' : 'Create folder'}
      subtitle={copy.subtitle}
      footer={
        <>
          {draft.id && (
            <button className="danger ghost" onClick={() => void remove()}>
              <Trash2 size={16} /> Delete
            </button>
          )}
          <button onClick={() => void save()}>
            {draft.id ? 'Save changes' : 'Create folder'}
          </button>
        </>
      }
    >
      <div className="profile-form">
        {/* The tags this workspace already runs on, offered as folders. A tag
          * used on several profiles is a grouping the user has been keeping by
          * hand; this is the one place it can become the real thing. */}
        {tagIdeas.length > 0 && (
          <Field
            label="Suggested from your tags"
            icon={<LayoutGrid size={14} />}
            hint="Fills the name, icon and colour. Everything stays editable."
            wide
            group
          >
            <div className="folder-suggestions">
              {tagIdeas.map((suggestion) => (
                <button
                  className="folder-suggestion"
                  key={suggestion.tag}
                  onClick={() => onChange({
                    ...draft,
                    name: tagLabel(suggestion.tag),
                    icon: suggestion.preset?.folderIcon || DEFAULT_FOLDER_ICON,
                    color: suggestion.preset ? tagFolderColor(suggestion.preset) : draft.color,
                    fromTag: suggestion.tag,
                  })}
                  type="button"
                >
                  <TagChip count={suggestion.count} tag={suggestion.tag} />
                </button>
              ))}
            </div>
          </Field>
        )}
        {/* The proxy-side twin: the countries this workspace's proxies have
          * actually checked into. The same grouping the user would make by
          * hand, one click, already wearing the right flag. */}
        {countryIdeas.length > 0 && (
          <Field
            label="Suggested from your proxies"
            icon={<LayoutGrid size={14} />}
            hint="Fills the name and the flag. Everything stays editable."
            wide
            group
          >
            <div className="folder-suggestions">
              {countryIdeas.map((suggestion) => (
                <button
                  className="folder-suggestion"
                  key={suggestion.code}
                  onClick={() => onChange({
                    ...draft,
                    name: suggestion.name,
                    icon: flagIconKey(suggestion.code),
                    fromCountry: suggestion.code,
                  })}
                  type="button"
                >
                  <span className="country-suggestion">
                    <FlagIcon countryCode={suggestion.code} />
                    {suggestion.name}
                    <span className="country-suggestion-count">{suggestion.count}</span>
                  </span>
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="Name" icon={<FolderIcon size={14} />} wide>
          <input
            type="text"
            autoFocus
            placeholder={copy.namePlaceholder}
            value={draft.name}
            onChange={(event) => onChange({...draft, name: event.target.value})}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void save();
              }
            }}
          />
        </Field>
        <Field
          label="Icon"
          icon={<LayoutGrid size={14} />}
          hint={copy.iconHint}
          wide
          group
        >
          <IconPicker
            value={draft.icon}
            onChange={(icon) => onChange({...draft, icon})}
            preferredCountries={isProxy ? proxyCountries : undefined}
          />
        </Field>
        {/* Hidden once a flag is picked: FolderGlyph ignores the colour there,
          * so leaving the swatches on screen would be six controls that do
          * nothing. Switching back to a glyph brings them straight back, and
          * the draft's colour is untouched in the meantime. */}
        {!flagCodeFromIcon(draft.icon) && (
          <Field
            label="Colour"
            icon={<Palette size={14} />}
            hint={copy.colourHint}
            wide
            group
          >
            <ColorPicker value={draft.color} onChange={(color) => onChange({...draft, color})} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// What a just-created folder was suggested from, if the name still says so.
//
// Editing "Instagram" into "IG burners", or "United States" into "Client A",
// and then being offered twelve Instagram profiles or eighteen US proxies would
// be the dialog second-guessing what was just typed. Compared on tagKey, which
// strips case and punctuation, so "united states" still counts.
function seedFor(draft: FolderDraft, name: string): string | undefined {
  if (draft.kind === 'proxy') {
    return draft.fromCountry && tagKey(countryName(draft.fromCountry)) === tagKey(name) ?
      draft.fromCountry :
      undefined;
  }
  // Cookie folders are never suggested from anything, so there is nothing to
  // seed the move dialog with.
  if (draft.kind === 'cookie') {
    return undefined;
  }
  return draft.fromTag && tagKey(tagLabel(draft.fromTag)) === tagKey(name) ?
    draft.fromTag :
    undefined;
}

// Tags worth turning into a folder: on more than one profile, and not already
// a folder by that name. One profile is not a grouping, and re-offering a
// folder that exists is how a workspace ends up with two Instagrams.
const SUGGESTION_MIN_PROFILES = 2;
const SUGGESTION_LIMIT = 6;

function folderSuggestions(tagOptions: TagUsage[], folders: MontiFolder[]): TagUsage[] {
  const taken = new Set(folders.map((folder) => tagKey(folder.name)));
  return tagOptions
      .filter((option) => option.count >= SUGGESTION_MIN_PROFILES &&
        !taken.has(tagKey(tagLabel(option.tag))))
      .sort((a, b) => b.count - a.count)
      .slice(0, SUGGESTION_LIMIT);
}

// The countries this workspace's proxies checked into, most-used first. Only
// checked proxies have one -- an unchecked or failing proxy has no country to
// file it by, and the background sweep will give it one soon enough.
function countriesInUse(proxies: MontiProxy[]) {
  const counts = new Map<string, number>();
  for (const proxy of proxies) {
    const code = proxy.country_code?.trim().toUpperCase();
    if (code && /^[A-Z]{2}$/.test(code)) {
      counts.set(code, (counts.get(code) || 0) + 1);
    }
  }
  return [...counts.entries()]
      .map(([code, count]) => ({code, name: countryName(code), count}))
      .sort((a, b) => b.count - a.count);
}

// The proxy-side folderSuggestions, deliberately the same shape and the same
// two thresholds. A country is skipped when a folder already carries its flag
// or its name -- otherwise "United States" gets offered forever, next to the
// United States folder the user made from it last week.
function countrySuggestions(proxies: MontiProxy[], folders: MontiFolder[]) {
  const takenNames = new Set(folders.map((folder) => tagKey(folder.name)));
  const takenFlags = new Set(folders
      .map((folder) => flagCodeFromIcon(folder.icon))
      .filter((code): code is string => Boolean(code)));
  return countriesInUse(proxies)
      .filter((entry) => entry.count >= SUGGESTION_MIN_PROFILES &&
        !takenFlags.has(entry.code) && !takenNames.has(tagKey(entry.name)))
      .slice(0, SUGGESTION_LIMIT);
}

export function StatusModal({draft, onChange, onClose}: {
  draft: StatusDraft;
  onChange: (draft: StatusDraft) => void;
  onClose: () => void;
}) {
  const {toast, library} = useWorkspace();

  async function save() {
    const name = draft.name.trim();
    if (!name) {
      toast.setMessage('Status name is required');
      return;
    }
    if (!await library.createStatus(name)) {
      return;
    }
    onClose();
    toast.setMessage(`${name} status created`);
  }

  return (
    <Modal
      className="small-modal"
      onClose={onClose}
      title="Create status"
      subtitle="Custom statuses become available in every profile dropdown."
      footer={<button onClick={() => void save()}>Create status</button>}
    >
      <div className="profile-form">
        <label className="field wide">
          <span>Name</span>
          <input
            type="text"
            autoFocus
            placeholder="Paused"
            value={draft.name}
            onChange={(event) => onChange({name: event.target.value})}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void save();
              }
            }}
          />
        </label>
      </div>
    </Modal>
  );
}
