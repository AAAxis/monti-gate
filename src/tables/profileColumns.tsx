// Every column the Profiles table can show.
//
// The nine that were hard-coded in the tab, plus the proxy check split out of
// the proxy cell, plus nine more that are off until somebody asks for them. The
// added ones are all things the profile already carries and the table had no
// room to volunteer: the account it is logged into, the fingerprint it presents,
// and what happens when you press Launch.
//
// Ids are load-bearing -- they are what a saved layout stores and what an agent
// sends to POST /v1/tables/columns. The nine original ones are deliberately
// spelled the way the old useTableSort keys were spelled (`created`, not
// `dateAdded`), so nothing about sorting changed meaning when it moved here.
import {StickyNote} from 'lucide-react';
import {Assignee} from '../components/ui/Assignee';
import {CellCopy, CellLink, CellPicker, CellTags, CellTextEdit} from '../components/ui/CellControls';
import {CookieSetLabel} from '../components/ui/CookieSetLabel';
import {CopyButton} from '../components/ui/CopyButton';
import {FolderLabel} from '../components/ui/FolderLabel';
import {NotesPanel} from '../components/ui/NotesPanel';
import {Popover} from '../components/ui/Popover';
import {PlatformLabel} from '../components/ui/icons';
import {ProfileAvatar} from '../components/ui/ProfileAvatar';
import {ProxyCheckCell, storedCheckState} from '../components/ui/ProxyCheckCell';
import {StatusChip} from '../components/ui/StatusChip';
import {assigneeName} from '../lib/assignees';
import {formatProxyLink} from '../lib/proxies';
import {daysUntilPurge} from '../lib/trash';
import {formatDateShort} from '../lib/text';
import type {CellOption} from '../components/ui/CellControls';
import type {TableColumn} from './columns';
import type {TagUsage} from '../lib/tags';
import type {ScoutCookie, ScoutFolder, ScoutProfile, ScoutProxy, CloudState} from '../types';

// What the cells need that a profile does not carry.
//
// Three groups rather than one flat bag. Most of these columns can now be
// edited in place, and a flat context reached nineteen fields before the last
// of them was wired -- at which point "what does a cell get" stops being
// answerable. Reads stay at the top level; what a cell can OFFER and what a
// cell can WRITE each get a namespace, so adding a twelfth action widens
// ProfileCellActions rather than the context.
export type ProfileColumnContext = {
  // The two lookups the tab already had: a proxy is matched by host, a folder
  // by id.
  state: CloudState;
  proxyFor: (profile: ScoutProfile) => ScoutProxy | null | undefined;
  folderFor: (profile: ScoutProfile) => ScoutFolder | null | undefined;
  checkingProxyIds: ReadonlySet<string>;
  // Every tag in use across the workspace, for the Tags cell's suggestion row.
  // A read rather than an option list: TagInput takes TagUsage (tag + count),
  // not the CellOption shape the pickers speak, and it is the same array the
  // toolbar's tag filter already reads from useWorkspace().
  tagOptions: TagUsage[];
  // For "You" first in the assignee picker, and for the chip that marks it.
  userId: string;
  options: ProfileCellOptions;
  actions: ProfileCellActions;
};

// The picker rows, built once per render rather than once per cell. The
// timezone list alone is ~60 entries and a page holds 25 rows, so building them
// inside the cell would mint 1,500 objects per keystroke elsewhere on the tab.
export type ProfileCellOptions = {
  platforms: CellOption[];
  statuses: CellOption[];
  proxies: CellOption[];
  members: CellOption[];
  automations: CellOption[];
  cookieSets: CellOption[];
  timezones: CellOption[];
  languages: CellOption[];
};

// Every write a cell can perform, and every hand-off to a surface it does not
// own. Deliberately narrow signatures -- a cell names a value, never a patch --
// because two of these have rules a cell must not be able to get wrong:
//
//  - setAssignee goes through the set_assignee RPC, never through a profile
//    patch. profilePatchToRow omits assigned_to on purpose, so an update
//    carrying it is a silent no-op that looks like it worked.
//  - setFingerprint spreads the existing fingerprint. The mapper replaces the
//    whole object, so a patch of one field would blank the other twenty.
export type ProfileCellActions = {
  setName: (profile: ScoutProfile, name: string) => void;
  setStatus: (profile: ScoutProfile, status: string) => void;
  setTags: (profile: ScoutProfile, tags: string[]) => void;
  setPlatform: (profile: ScoutProfile, os: string) => void;
  setAssignee: (profile: ScoutProfile, userId: string) => void;
  setProxy: (profile: ScoutProfile, proxyId: string) => void;
  setAutomation: (profile: ScoutProfile, automationId: string) => void;
  setCookieSet: (profile: ScoutProfile, cookieId: string) => void;
  setStartUrl: (profile: ScoutProfile, url: string) => void;
  setFingerprint: (
    profile: ScoutProfile, patch: NonNullable<ScoutProfile['fingerprint']>) => void;
  recheckProxy: (proxy: ScoutProxy) => void;
  filterFolder: (folderId: string) => void;
  openFingerprint: (profile: ScoutProfile) => void;
  openCookieSet: (cookie: ScoutCookie) => void;
};

export type ProfileColumn = TableColumn<ScoutProfile, ProfileColumnContext>;

// An em dash, not an empty cell. A blank in a table of fourteen columns reads
// as a rendering fault; a dash reads as "this profile has none".
function none() {
  return <span className="cell-muted">—</span>;
}

function text(value: string | null | undefined) {
  return value ? <span className="cell-text" title={value}>{value}</span> : none();
}

// fail < unchecked < ok, so ascending opens on the broken ones -- the only
// reason anyone clicks this header. A profile with no proxy has no value at
// all and sinks in both directions, which is useTableSort's missingRank rule.
const CHECK_RANK: Record<string, number> = {fail: 0, checking: 1, unchecked: 2, ok: 3};

// A profile's note summary, or undefined when it has none. Both the cell and
// the sort go through this so they cannot disagree about which note is newest.
function noteSummary(context: ProfileColumnContext, profileId: string) {
  return context.state.note_summaries.find((summary) => summary.profile_id === profileId);
}

export const PROFILE_COLUMNS: ProfileColumn[] = [
  {
    id: 'name',
    label: 'Name',
    group: 'Identity',
    locked: true,
    cellClassName: 'name-cell',
    stopRowClick: true,
    sort: (profile) => profile.name,
    // The avatar stays outside the editor: it is set from the profile dialog's
    // picker, and a mark that opened a text field would be lying about what it
    // does. The name is capped and clipped with the whole of it in the title --
    // one long name used to set this column's width for every row.
    cell: (profile, context) => (
      <>
        <ProfileAvatar profile={profile} />
        <CellTextEdit
          allowClear={false}
          label={`Rename ${profile.name}`}
          onSave={(name) => context.actions.setName(profile, name)}
          placeholder="Profile name"
          trigger={<span className="cell-name" title={profile.name}>{profile.name}</span>}
          validate={nameProblem}
          value={profile.name}
        />
      </>
    ),
  },
  {
    id: 'platform',
    label: 'Platform',
    group: 'Identity',
    cellClassName: 'platform-cell',
    stopRowClick: true,
    description: 'The operating system this profile presents.',
    sort: (profile) => profile.fingerprint?.os,
    // The one fingerprint field that IS set from the table, because picking a
    // platform is the one fingerprint change that carries its own consistency
    // with it: setPlatform re-rolls the GPU, CPU, screen and media devices to
    // match, exactly as <PlatformPicker> does in the editor. Setting Screen or
    // Browser alone has no such guarantee, which is why those two open the
    // editor instead. See launcher/AGENTS.md.
    cell: (profile, context) => (
      <CellPicker
        label={`Change the platform for ${profile.name}`}
        onPick={(os) => context.actions.setPlatform(profile, os)}
        options={context.options.platforms}
        trigger={<PlatformLabel os={profile.fingerprint?.os} />}
        value={profile.fingerprint?.os || ''}
        width={240}
      />
    ),
  },
  {
    id: 'status',
    label: 'Status',
    group: 'Workspace',
    cellClassName: 'cell-fit',
    // The picker is a control inside a row that is itself a selection target.
    stopRowClick: true,
    sort: (profile) => profile.status || 'Ready',
    cell: (profile, context) => (
      <CellPicker
        // The chip is already a bordered pill, so it takes the hover itself
        // rather than sitting on the plate every other trigger draws.
        chip
        label={`Change status for ${profile.name}`}
        onPick={(status) => context.actions.setStatus(profile, status)}
        options={context.options.statuses}
        trigger={<StatusChip status={profile.status || 'Ready'} />}
        value={profile.status || 'Ready'}
        width={230}
      />
    ),
  },
  {
    id: 'assignee',
    label: 'Assigned',
    group: 'Workspace',
    cellClassName: 'cell-fit',
    teamOnly: true,
    stopRowClick: true,
    description: 'The teammate on the hook for this profile.',
    // Sorts by the name shown, not the uuid stored: an id sort groups a
    // person's rows together in an order nobody can read.
    sort: (profile, context) => assigneeName(profile.assigned_to, context.state.members),
    cell: (profile, context) => (
      <CellPicker
        label={`Assign ${profile.name}`}
        onPick={(userId) => context.actions.setAssignee(profile, userId)}
        options={assigneeOptions(context)}
        trigger={<Assignee userId={profile.assigned_to} />}
        value={profile.assigned_to || ''}
      />
    ),
  },
  {
    // "Date added", not "Created": the same created_at, named for what the
    // reader is scanning the column for. The id stays `created` because it
    // names the field, not the header.
    id: 'created',
    label: 'Date added',
    group: 'Workspace',
    cellClassName: 'cell-fit',
    firstDirection: 'desc',
    sort: (profile) => profile.created_at,
    cell: (profile) => formatDateShort(profile.created_at) || none(),
  },
  {
    id: 'folder',
    label: 'Folder',
    group: 'Workspace',
    cellClassName: 'cell-fit',
    stopRowClick: true,
    sort: (profile, context) => context.folderFor(profile)?.name,
    // A trashed row says how long it has left instead, and stays plain text:
    // the folder it came from is not where clicking it should take you, and
    // there is nothing to point the table at.
    cell: (profile, context) => {
      if (profile.deleted_at) {
        return `${daysUntilPurge(profile.deleted_at)}d left in Trash`;
      }
      const folder = context.folderFor(profile);
      return (
        <CellLink
          label={folder ? `Show only ${folder.name}` : 'Show all profiles'}
          onClick={() => context.actions.filterFolder(folder?.id || '')}
        >
          <FolderLabel fallback="All profiles" folder={folder} />
        </CellLink>
      );
    },
  },
  {
    // The connection, and -- next door -- its health. These were one cell for a
    // while, which put the answer to "does this profile's proxy work" in the
    // same column as "which proxy is it", sortable only by the second. Two
    // columns because they are two questions, and separable because some
    // workspaces care about neither and some care only about the check.
    id: 'proxy',
    label: 'Proxy',
    group: 'Connection',
    cellClassName: 'profile-proxy-cell cell-fit',
    stopRowClick: true,
    description: 'The proxy this profile launches through, as host:port.',
    sort: (profile, context) => {
      const assigned = context.proxyFor(profile);
      return assigned ? `${assigned.host}:${assigned.port}` : undefined;
    },
    cell: (profile, context) => {
      const proxy = context.proxyFor(profile);
      return (
        <CellPicker
          empty="No proxies saved yet"
          // The copy lives in the footer, not beside the trigger: Popover's
          // trigger is a <button>, and a button inside a button is invalid
          // markup that never receives its own clicks.
          footer={proxy ? () => (
            <>
              <CopyButton className="ghost" label="Copy address"
                value={`${proxy.host}:${proxy.port}`} />
              {/* The whole connection string, credentials included -- which is
                  what a provider's dashboard or another tool wants pasted, and
                  what the proxy editor already shows on screen. */}
              <CopyButton className="ghost" label="Copy link" value={formatProxyLink(proxy)} />
            </>
          ) : undefined}
          label={`Change the proxy for ${profile.name}`}
          noneLabel="Direct"
          onPick={(proxyId) => context.actions.setProxy(profile, proxyId)}
          options={context.options.proxies}
          searchPlaceholder="Search proxies…"
          trigger={proxy ?
            <span className="profile-proxy-host">{proxy.host}:{proxy.port}</span> :
            <span className="cell-soft-text">Direct</span>}
          value={proxy?.id || ''}
          width={300}
        />
      );
    },
  },
  {
    id: 'proxyStatus',
    label: 'Proxy check',
    group: 'Connection',
    cellClassName: 'profile-proxy-status-cell cell-fit',
    // The chip re-checks, and the failed one opens a panel.
    stopRowClick: true,
    description: 'The result of the last check on this profile\'s proxy.',
    sort: (profile, context) => {
      const proxy = context.proxyFor(profile);
      return proxy ? CHECK_RANK[storedCheckState(proxy).status] : undefined;
    },
    cell: (profile, context) => {
      const proxy = context.proxyFor(profile);
      // Nothing at all for a direct connection. An "unchecked" chip there would
      // be a lie about a connection that has nothing to check.
      if (!proxy) {
        return none();
      }
      return (
        <ProxyCheckCell
          state={context.checkingProxyIds.has(proxy.id) ?
            {status: 'checking'} :
            storedCheckState(proxy)}
          age={proxy.check_error ? undefined : proxy.checked_at}
          onRecheck={() => context.actions.recheckProxy(proxy)}
        />
      );
    },
  },
  {
    // Tags is a set, not a value -- there is no order to sort a row of chips by
    // that means anything to the person reading it, and for the same reason it
    // is a CellTags rather than one of the pickers: choosing one option and
    // closing is the one behaviour this must not have.
    id: 'tags',
    label: 'Tags',
    group: 'Workspace',
    stopRowClick: true,
    cell: (profile, context) => (
      <CellTags
        label={`Edit tags for ${profile.name}`}
        onChange={(tags) => context.actions.setTags(profile, tags)}
        options={context.tagOptions}
        tags={profile.tags || []}
      />
    ),
  },
  {
    // What this profile is FOR, which nothing else in the row says. The name is
    // a handle and the tags are a taxonomy; neither holds "client X, do not warm
    // up". Off by default like every column added after the table shipped.
    //
    // The cell reads context.state.note_summaries -- already in CloudState, one
    // row per profile that has notes -- so a page of 25 costs no queries. The
    // thread itself is fetched by the panel when it opens.
    id: 'notes',
    label: 'Notes',
    group: 'Workspace',
    hiddenByDefault: true,
    cellClassName: 'cell-wide notes-cell',
    stopRowClick: true,
    description:
      'Free-text notes on this profile, newest first, each carrying who wrote it and when. ' +
      'Read and append with the profile-notes tools; agents cannot edit or delete.',
    // By recency, not by text. A column of prose has no alphabetical order worth
    // having, and "which profiles were annotated lately" is the real question.
    sort: (profile, context) => noteSummary(context, profile.id)?.last_created_at,
    firstDirection: 'desc',
    cell: (profile, context) => {
      const summary = noteSummary(context, profile.id);
      return (
        <Popover
          label={summary ?
            `Notes for ${profile.name}, ${summary.note_count} so far` :
            `Add a note to ${profile.name}`}
          panelClassName="filter-pop notes-pop"
          triggerClassName="cell-trigger"
          width={360}
          trigger={
            <span className="cell-trigger-value">
              {summary ? (
                <>
                  <span className="note-preview" title={summary.last_body}>
                    {summary.last_body}
                  </span>
                  {/* Only once there is more than the one being previewed --
                      a "1" beside the only note is a count of nothing. */}
                  {summary.note_count > 1 && (
                    <span className="note-count">{summary.note_count}</span>
                  )}
                </>
              ) : (
                // Not the em dash the other empty cells use. Every one of those
                // is a value the profile happens to lack; this is the one cell
                // whose empty state is an invitation, and the column is useless
                // until somebody accepts it.
                <span className="note-add"><StickyNote size={13} /> Add note</span>
              )}
            </span>
          }
        >
          <NotesPanel autoFocus={!summary} profileId={profile.id} />
        </Popover>
      );
    },
  },
  {
    id: 'email',
    label: 'Login email',
    group: 'Identity',
    hiddenByDefault: true,
    cellClassName: 'cell-wide cell-copy-cell',
    description: 'The account this profile is logged into. The password is never shown in the table.',
    sort: (profile) => profile.email,
    // The address is the one thing in this row somebody retypes into a login
    // form, so it can be taken rather than only read.
    cell: (profile) => profile.email ? <CellCopy value={profile.email} /> : none(),
  },
  {
    id: 'profileId',
    label: 'Profile ID',
    group: 'Identity',
    hiddenByDefault: true,
    cellClassName: 'profile-id-cell cell-fit cell-copy-cell',
    // Not sortable: a uuid order is an order, but not one anybody reads.
    description: 'The uuid the API and MCP tools address this profile by.',
    // Eight characters is enough to tell two profiles apart by eye; the copy
    // hands over all thirty-six, which is what the API wants. No stopRowClick:
    // the button swallows its own click and the text stays part of the row.
    cell: (profile) => (
      <CellCopy
        display={<span className="profile-id">{profile.id.slice(0, 8)}</span>}
        title={profile.id}
        value={profile.id}
      />
    ),
  },
  {
    // ── The fingerprint four ────────────────────────────────────────────────
    // Two of these can be set from the table and two cannot, and the split is
    // not arbitrary. Timezone and Language are standalone fields with fixed
    // preset lists: setting one changes that one and nothing else. Browser and
    // Screen are part of a coherent device -- fingerprintPatchForOs re-rolls
    // the screen alongside the GPU, the CPU and the media-device set whenever
    // the platform changes -- so a screen chosen on its own is a claim the rest
    // of the identity contradicts. Those two open the editor at the section
    // they belong to instead. See launcher/AGENTS.md.
    id: 'fpBrowser',
    label: 'Browser',
    group: 'Fingerprint',
    hiddenByDefault: true,
    cellClassName: 'cell-soft cell-fit',
    stopRowClick: true,
    description: 'The Chrome version this profile reports.',
    sort: (profile) => profile.fingerprint?.browser_version,
    cell: (profile, context) => fingerprintLink(profile, context, profile.fingerprint?.browser_version),
  },
  {
    id: 'fpTimezone',
    label: 'Timezone',
    group: 'Fingerprint',
    hiddenByDefault: true,
    cellClassName: 'cell-soft cell-fit',
    stopRowClick: true,
    description: 'The timezone this profile presents.',
    sort: (profile) => profile.fingerprint?.timezone,
    cell: (profile, context) => (
      <CellPicker
        label={`Change the timezone for ${profile.name}`}
        onPick={(timezone) => context.actions.setFingerprint(profile, {timezone})}
        options={context.options.timezones}
        searchPlaceholder="Search timezones…"
        trigger={profile.fingerprint?.timezone || none()}
        value={profile.fingerprint?.timezone || ''}
        width={300}
      />
    ),
  },
  {
    id: 'fpLanguage',
    label: 'Language',
    group: 'Fingerprint',
    hiddenByDefault: true,
    cellClassName: 'cell-soft cell-fit',
    stopRowClick: true,
    description: 'The Accept-Language this profile presents.',
    sort: (profile) => profile.fingerprint?.language,
    cell: (profile, context) => (
      <CellPicker
        label={`Change the language for ${profile.name}`}
        onPick={(language) => context.actions.setFingerprint(profile, {language})}
        options={context.options.languages}
        trigger={profile.fingerprint?.language || none()}
        value={profile.fingerprint?.language || ''}
        width={260}
      />
    ),
  },
  {
    id: 'fpScreen',
    label: 'Screen',
    group: 'Fingerprint',
    hiddenByDefault: true,
    cellClassName: 'cell-soft cell-fit',
    stopRowClick: true,
    description: 'The screen resolution this profile presents.',
    sort: (profile) => profile.fingerprint?.screen,
    cell: (profile, context) => fingerprintLink(profile, context, profile.fingerprint?.screen),
  },
  {
    id: 'startUrl',
    label: 'Start URL',
    group: 'Launch',
    hiddenByDefault: true,
    cellClassName: 'cell-wide',
    stopRowClick: true,
    description: 'The page this profile opens on launch.',
    sort: (profile) => profile.start_url,
    cell: (profile, context) => (
      <CellTextEdit
        label={`Start URL for ${profile.name}`}
        onSave={(url) => context.actions.setStartUrl(profile, url)}
        placeholder="https://example.com"
        trigger={profile.start_url ?
          <span className="cell-text">{profile.start_url}</span> :
          none()}
        validate={startUrlProblem}
        value={profile.start_url || ''}
      />
    ),
  },
  {
    id: 'automation',
    label: 'Automation',
    group: 'Launch',
    hiddenByDefault: true,
    cellClassName: 'cell-fit',
    stopRowClick: true,
    description: 'The workflow that runs when this profile launches.',
    sort: (profile, context) => automationName(profile, context),
    cell: (profile, context) => (
      <CellPicker
        empty="No automations yet"
        label={`Change the automation for ${profile.name}`}
        noneLabel="None"
        onPick={(automationId) => context.actions.setAutomation(profile, automationId)}
        options={context.options.automations}
        searchPlaceholder="Search automations…"
        trigger={automationName(profile, context) || none()}
        value={profile.automation_id || ''}
      />
    ),
  },
  {
    id: 'cookieSet',
    label: 'Cookie set',
    group: 'Launch',
    hiddenByDefault: true,
    cellClassName: 'cell-wide',
    stopRowClick: true,
    description: 'The cookies this profile is seeded with at launch.',
    sort: (profile, context) => cookieSetName(profile, context),
    cell: (profile, context) => {
      const attached = profile.cookie_mode === 'saved' ?
        context.state.cookies.find((item) => item.id === profile.cookie_id) :
        undefined;
      return (
        <CellPicker
          empty="No cookie sets yet"
          // The set is a row in another library, so the cell offers to go and
          // look at it as well as to swap it.
          footer={attached ? (close) => (
            <button className="ghost" onClick={() => {
              close();
              context.actions.openCookieSet(attached);
            }} type="button">
              Open in Cookies
            </button>
          ) : undefined}
          label={`Change the cookies for ${profile.name}`}
          // Named for what it actually does. A profile in `paste` mode carries a
          // file of its own, and clearing has to take cookie_import_path/_url/
          // _name/_count with it -- so "None" would understate it. Absent
          // entirely when there is nothing to clear.
          noneLabel={cookieSetName(profile, context) ?
            (profile.cookie_mode === 'saved' ? 'None' : 'Remove pasted cookies') :
            undefined}
          onPick={(cookieId) => context.actions.setCookieSet(profile, cookieId)}
          options={context.options.cookieSets}
          searchPlaceholder="Search cookie sets…"
          // The set wears its mark here too, so "which cookies is this profile
          // on" is answerable by colour across a page of profiles rather than
          // by reading fifty file names. A pasted file has no mark to wear --
          // it is not a row in the library -- so it stays plain text.
          trigger={attached ?
            <CookieSetLabel cookie={attached} folders={context.state.cookie_folders} /> :
            cookieSetName(profile, context) || none()}
          value={attached?.id || ''}
          width={280}
        />
      );
    },
  },
];

// Browser and Screen are shown here and set in the editor. The value is the
// link, so the cell still reads as the fact it carries rather than as a button.
function fingerprintLink(
    profile: ScoutProfile, context: ProfileColumnContext, value: string | undefined) {
  return (
    <CellLink
      label={`Edit the fingerprint for ${profile.name}`}
      onClick={() => context.actions.openFingerprint(profile)}
    >
      {value || none()}
    </CellLink>
  );
}

// Yourself first and named "You", which is the word the Assignee chip uses --
// AssigneeSelect orders its options the same way. Built per cell rather than in
// the memoised list because "you" is a different row for each reader and the
// roster is small; a fifty-row page with a five-person team is 250 objects.
function assigneeOptions({options, userId}: ProfileColumnContext): CellOption[] {
  const mine = options.members.filter((member) => member.value === userId);
  const others = options.members.filter((member) => member.value !== userId);
  return [...mine.map((member) => ({...member, label: 'You'})), ...others];
}

// Enough of a check to stop a value the launcher cannot open. Deliberately not
// a strict URL parse: a bare "example.com" is what people type, and the browser
// resolves it, so refusing it would be this field inventing a rule the rest of
// the app does not have.
function startUrlProblem(value: string) {
  return /\s/.test(value) ? 'A start URL cannot contain spaces' : null;
}

// The same rule the profile dialog enforces, and the only one it enforces: a
// name is free text, but it cannot be nothing. CellTextEdit treats an empty
// field as "clear this", which for every other column is a real option and for
// this one is a row with no way to tell it from any other -- so Clear is off
// here and an all-space name is refused rather than silently trimmed to ''.
function nameProblem(value: string) {
  return value.trim() ? null : 'A profile needs a name';
}

function automationName(profile: ScoutProfile, {state}: ProfileColumnContext) {
  return profile.automation_id ?
    state.automations.find((item) => item.id === profile.automation_id)?.name :
    undefined;
}

// Two ways a profile can carry cookies: a set from the shared library, or a
// file pasted into the profile itself. The column answers "what is this
// launched with", so it reports either.
function cookieSetName(profile: ScoutProfile, {state}: ProfileColumnContext) {
  if (profile.cookie_mode === 'saved') {
    return state.cookies.find((item) => item.id === profile.cookie_id)?.name;
  }
  return profile.cookie_import_name || undefined;
}
