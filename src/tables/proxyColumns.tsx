// Every column the Proxies table can show.
//
// The same eight it has always shown, plus Login and Password -- and most of
// them are now edited where they are read, through the same CellControls the
// Profiles table uses. Country and Used by stay read-only: both are derived,
// one from the last check and one from the profiles that point here.
//
// Ids are the old useTableSort keys, unchanged, so a sort means what it did.
import {AssignedCell} from '../components/ui/AssignedCell';
import {Assignee} from '../components/ui/Assignee';
import {CellPicker, CellTextEdit} from '../components/ui/CellControls';
import {FolderLabel} from '../components/ui/FolderLabel';
import {FlagIcon} from '../components/ui/icons';
import {ProxyCheckCell, storedCheckState} from '../components/ui/ProxyCheckCell';
import {StatusChip} from '../components/ui/StatusChip';
import {defaultProxyStatus} from '../data/statuses';
import {assigneeName} from '../lib/assignees';
import {profilesUsingProxy, proxyCountryLabel, splitPastedConnection} from '../lib/proxies';
import type {CellOption} from '../components/ui/CellControls';
import type {TableColumn} from './columns';
import type {ScoutProfile, ScoutProxy, CloudState} from '../types';

export type ProxyColumnContext = {
  state: CloudState;
  checkingProxyIds: ReadonlySet<string>;
  // For "You" first in the assignee picker.
  userId: string;
  options: ProxyCellOptions;
  actions: ProxyCellActions;
};

// The picker rows, built once per render rather than once per cell -- the same
// argument profileColumns makes, at smaller scale.
export type ProxyCellOptions = {
  types: CellOption[];
  folders: CellOption[];
  members: CellOption[];
  statuses: CellOption[];
};

// Every write a cell can perform. Narrow signatures, built in
// tables/proxyCellActions.tsx, where the two rules a cell must not be able to
// get wrong are enforced: assignment goes through the set_assignee RPC, and
// every connection edit clears the stored check.
export type ProxyCellActions = {
  setName: (proxy: ScoutProxy, name: string) => void;
  setStatus: (proxy: ScoutProxy, status: string) => void;
  setType: (proxy: ScoutProxy, type: 'http' | 'socks5') => void;
  setEndpoint: (proxy: ScoutProxy, endpoint: ProxyEndpoint) => void;
  setUsername: (proxy: ScoutProxy, username: string) => void;
  setPassword: (proxy: ScoutProxy, password: string) => void;
  setFolder: (proxy: ScoutProxy, folderId: string) => void;
  setAssignee: (proxy: ScoutProxy, userId: string) => void;
  recheckProxy: (proxy: ScoutProxy) => void;
};

// What a save of the Host cell carries. Host and port always; the rest only
// when the text pasted into the cell was a full connection line that named
// them.
export type ProxyEndpoint = {
  host: string;
  port: number;
  type?: 'http' | 'socks5';
  username?: string;
  password?: string;
};

export type ProxyColumn = TableColumn<ScoutProxy, ProxyColumnContext>;

// A proxy's line in a sentence like "Rename …": the name if it has one, else
// the host the cell falls back to.
function proxyLabel(proxy: ScoutProxy) {
  return proxy.name || proxy.host;
}

function folderFor(proxy: ScoutProxy, {state}: ProxyColumnContext) {
  return state.proxy_folders.find((item) => item.id === proxy.folder_id);
}

function holders(proxy: ScoutProxy, {state}: ProxyColumnContext): ScoutProfile[] {
  return profilesUsingProxy(proxy, state.profiles);
}

// Yourself first and named "You" -- the copy of profileColumns' helper this
// table needs because "you" is a different row for each reader.
function assigneeOptions({options, userId}: ProxyColumnContext): CellOption[] {
  const mine = options.members.filter((member) => member.value === userId);
  const others = options.members.filter((member) => member.value !== userId);
  return [...mine.map((member) => ({...member, label: 'You'})), ...others];
}

// The Host cell's parser. splitPastedConnection rather than a bare host:port
// split, so the cell accepts everything the proxy editor's paste accepts --
// "1.2.3.4:8080", "socks5://user:pass@host:port", the four-part vendor line --
// and a line that carries credentials sets them in the same write. The type
// only rides along when the text named one; parseProxyLink defaults it
// otherwise, and "1.2.3.4:8080" is not an opinion about protocol.
function parseEndpoint(raw: string): ProxyEndpoint | null {
  const parsed = splitPastedConnection(raw);
  if (!parsed) {
    return null;
  }
  return {
    host: parsed.host,
    port: parsed.port,
    type: parsed.explicitType ? parsed.type : undefined,
    username: parsed.username,
    password: parsed.password,
  };
}

function endpointProblem(draft: string) {
  return parseEndpoint(draft) ? null : 'Use host:port, e.g. 1.2.3.4:8080';
}

export const PROXY_COLUMNS: ProxyColumn[] = [
  {
    id: 'name',
    label: 'Name',
    locked: true,
    cellClassName: 'name-cell',
    stopRowClick: true,
    // Falls back to the host the same way the cell does, so sorting by Name
    // never strands the unnamed rows.
    sort: (proxy) => proxy.name || proxy.host,
    // The flag stays outside the editor: it is the last check's verdict, and a
    // mark that opened a text field would be lying about what it does. Clear
    // is allowed, unlike a profile's name -- rename() falls back to host:port,
    // so clearing means "call it what it is" rather than a nameless row.
    cell: (proxy, context) => (
      <>
        <span className="proxy-flag" title={proxyCountryLabel(proxy) || 'Country not checked'}>
          <FlagIcon countryCode={proxy.country_code} />
        </span>
        <CellTextEdit
          label={`Rename ${proxyLabel(proxy)}`}
          onSave={(name) => context.actions.setName(proxy, name)}
          placeholder="Proxy name"
          trigger={<span className="cell-name" title={proxyLabel(proxy)}>{proxyLabel(proxy)}</span>}
          value={proxy.name || ''}
        />
      </>
    ),
  },
  {
    // Visible by default, for the reason Login and Password below are: this is
    // the column the feature exists to add, and one you have to find in the
    // picker first has not been added.
    //
    // Not to be confused with the Check column further down. That one is the
    // machine's answer -- did the last check reach the exit -- and is written
    // only by the checker. This is the user's own mark, and nothing writes it
    // but the user.
    id: 'status',
    label: 'Status',
    description: 'A label you mark the proxy with. Not the check result.',
    cellClassName: 'cell-fit',
    stopRowClick: true,
    sort: (proxy) => proxy.status || defaultProxyStatus,
    cell: (proxy, context) => (
      <CellPicker
        // The chip is already a bordered pill, so it takes the hover itself --
        // the same argument the Profiles status cell makes.
        chip
        label={`Change status for ${proxyLabel(proxy)}`}
        onPick={(status) => context.actions.setStatus(proxy, status)}
        options={context.options.statuses}
        trigger={<StatusChip status={proxy.status || defaultProxyStatus} />}
        value={proxy.status || defaultProxyStatus}
        width={230}
      />
    ),
  },
  {
    id: 'type',
    label: 'Type',
    description: 'http or socks5. Editable in place; changing it clears the stored check.',
    stopRowClick: true,
    sort: (proxy) => (proxy.type || 'http').toUpperCase(),
    cell: (proxy, context) => (
      <CellPicker
        label={`Change the type of ${proxyLabel(proxy)}`}
        onPick={(type) => context.actions.setType(proxy, type as 'http' | 'socks5')}
        options={context.options.types}
        trigger={(proxy.type || 'http').toUpperCase()}
        value={proxy.type || 'http'}
        width={180}
      />
    ),
  },
  {
    id: 'host',
    label: 'Host',
    cellClassName: 'proxy-host-cell',
    description: 'The connection, as host:port. Editable in place; accepts a full ' +
      'connection line with credentials, and any change clears the stored check.',
    stopRowClick: true,
    sort: (proxy) => `${proxy.host}:${proxy.port}`,
    cell: (proxy, context) => (
      <CellTextEdit
        allowClear={false}
        label={`Edit the connection for ${proxyLabel(proxy)}`}
        onSave={(raw) => {
          const endpoint = parseEndpoint(raw);
          if (endpoint) {
            context.actions.setEndpoint(proxy, endpoint);
          }
        }}
        placeholder="1.2.3.4:8080"
        trigger={`${proxy.host}:${proxy.port}`}
        validate={endpointProblem}
        value={`${proxy.host}:${proxy.port}`}
      />
    ),
  },
  {
    // Visible by default, unlike the convention for columns added after a table
    // ships (columns.ts): these two exist because credentials are edited from
    // the table now, and a column you must first discover in the picker is not
    // "edited from the table". Deliberate, per Roman.
    id: 'username',
    label: 'Login',
    cellClassName: 'cell-fit',
    description: 'The username this proxy authenticates with, if any. Editable in ' +
      'place; changing it clears the stored check.',
    stopRowClick: true,
    sort: (proxy) => proxy.username,
    cell: (proxy, context) => (
      <CellTextEdit
        label={`Edit the login for ${proxyLabel(proxy)}`}
        onSave={(username) => context.actions.setUsername(proxy, username)}
        placeholder="username"
        trigger={proxy.username ?
          <span className="cell-text" title={proxy.username}>{proxy.username}</span> :
          undefined}
        value={proxy.username || ''}
      />
    ),
  },
  {
    id: 'password',
    label: 'Password',
    cellClassName: 'cell-fit',
    description: 'Masked in the table. Opening the cell shows the real value, ' +
      'editable and copyable; changing it clears the stored check.',
    stopRowClick: true,
    // No sort: an order over secrets means nothing to the person reading it.
    //
    // The mask is a fixed six dots whatever the password's length -- a mask
    // that tracked the length would be the one fact about the secret the table
    // leaked to anyone standing behind the screen.
    cell: (proxy, context) => (
      <CellTextEdit
        label={`Edit the password for ${proxyLabel(proxy)}`}
        onSave={(password) => context.actions.setPassword(proxy, password)}
        trigger={proxy.password ? <span className="cell-muted">••••••</span> : undefined}
        value={proxy.password || ''}
      />
    ),
  },
  {
    id: 'country',
    label: 'Country',
    description: 'Where the last check saw this proxy exit.',
    sort: (proxy) => proxy.country || proxy.country_code,
    cell: (proxy) => proxyCountryLabel(proxy) || '-',
  },
  {
    // Sorts on the timestamp behind "3h ago". A proxy that has never been
    // checked has no timestamp, so it sinks in both directions rather than
    // heading a descending sort -- which is the whole point of asking for it.
    id: 'checked',
    label: 'Last check',
    cellClassName: 'proxy-check-cell',
    firstDirection: 'desc',
    stopRowClick: true,
    sort: (proxy) => proxy.checked_at,
    cell: (proxy, context) => (
      <ProxyCheckCell
        onRecheck={() => context.actions.recheckProxy(proxy)}
        state={context.checkingProxyIds.has(proxy.id) ?
          {status: 'checking'} :
          storedCheckState(proxy)}
        age={proxy.check_error ? undefined : proxy.checked_at}
      />
    ),
  },
  {
    id: 'folder',
    label: 'Folder',
    stopRowClick: true,
    sort: (proxy, context) => folderFor(proxy, context)?.name,
    cell: (proxy, context) => (
      <CellPicker
        label={`File ${proxyLabel(proxy)} under a folder`}
        noneLabel="All proxies"
        onPick={(folderId) => context.actions.setFolder(proxy, folderId)}
        options={context.options.folders}
        trigger={<FolderLabel fallback="All proxies" folder={folderFor(proxy, context)} />}
        value={proxy.folder_id || ''}
      />
    ),
  },
  {
    // "Used by", not "Assigned to": it lists the PROFILES holding this proxy,
    // the identical thing the Cookies tab calls "Used by", and the old label
    // collided with the Assigned column beside it, which names a person.
    id: 'assigned',
    label: 'Used by',
    firstDirection: 'desc',
    description: 'How many profiles launch through this proxy.',
    sort: (proxy, context) => holders(proxy, context).length || undefined,
    cell: (proxy, context) => <AssignedCell holders={holders(proxy, context)} />,
  },
  {
    id: 'assignee',
    label: 'Assigned',
    teamOnly: true,
    stopRowClick: true,
    description: 'The teammate on the hook for this proxy.',
    sort: (proxy, context) => assigneeName(proxy.assigned_to, context.state.members),
    cell: (proxy, context) => (
      <CellPicker
        label={`Assign ${proxyLabel(proxy)}`}
        noneLabel="Unassigned"
        onPick={(userId) => context.actions.setAssignee(proxy, userId)}
        options={assigneeOptions(context)}
        trigger={<Assignee userId={proxy.assigned_to} />}
        value={proxy.assigned_to || ''}
      />
    ),
  },
];
