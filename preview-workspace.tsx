// SCRATCH — not part of the app. Aliased over src/workspace/WorkspaceProvider
// by vite.preview.config.ts so preview-automations.tsx can mount the real
// AutomationsTab without a Supabase session. Delete with the other preview-*
// files.
import {createContext, useContext, useState} from 'react';
import type {ReactNode} from 'react';
import {defaultCloudState} from './src/data/statuses';
import {previewCsvImport} from './src/workspace/csvImport';
import type {
  ScoutAutomation, ScoutFolder, ScoutNotification, ScoutProfile, CloudState, OrgMember,
} from './src/types';

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const MEMBERS: OrgMember[] = [
  {user_id: 'u', email: 'dpodretskiy@gmail.com', display_name: 'Roman',
    role: 'owner', avatar_url: null, created_at: iso(600000)} as OrgMember,
  {user_id: 'v', email: 'vlad@simnetiq.com', display_name: 'Vlad',
    role: 'member', avatar_url: null, created_at: iso(500000)} as OrgMember,
];

// For the profile-editor harness: a marked set and an unmarked one, so the
// colour fallback (set colour, else its folder's) is visible both ways.
const COOKIE_FOLDERS = [
  {id: 'cf-1', name: 'Rental portals', kind: 'cookie', color: 'violet', icon: 'folder'},
] as unknown as ScoutFolder[];

const COOKIES = [
  {id: 'c1', name: 'is24-session.json', url: '', count: 42, color: 'green', folder_id: 'cf-1'},
  {id: 'c2', name: 'cookies.txt', url: '', count: 17, folder_id: 'cf-1'},
  {id: 'c3', name: 'unfiled.json', url: '', count: 3, folder_id: null},
] as unknown as CloudState['cookies'];

// For the import harnesses (preview-imports.tsx): a small proxy library, so
// the review tables have something to call a duplicate and the destination step
// has a folder to offer.
const PROXY_FOLDERS = [
  {id: 'pf-1', name: 'Residential EU', kind: 'proxy', color: 'blue', icon: 'globe'},
] as unknown as ScoutFolder[];

const PROXIES = [
  {id: 'x1', name: '198.51.100.10:1080', type: 'socks5', host: '198.51.100.10', port: 1080,
    username: 'proxy-user', password: 'proxy-pass', folder_id: 'pf-1',
    country: 'Germany', country_code: 'DE', ping_ms: 118},
  {id: 'x2', name: '203.0.113.20:8080', type: 'http', host: '203.0.113.20', port: 8080,
    username: '', folder_id: null},
] as unknown as CloudState['proxies'];

const PROFILE_FOLDERS = [
  {id: 'f-social', name: 'Social', kind: 'profile', icon: 'users', color: 'violet'},
] as unknown as ScoutFolder[];

const PROFILES = [
  {id: 'p1', name: 'Renter DE-1', deleted_at: null, automation_id: 'a2',
    proxy_mode: 'direct',
    automation_vars: {a1: {city_name: 'Dortmund', number_of_rooms: '2'}}},
  {id: 'p2', name: 'Renter DE-2', deleted_at: null, automation_id: null,
    proxy_mode: 'direct',
    automation_vars: {a1: {city_name: 'Essen', number_of_rooms: '3'}}},
  // No values at all: the row that cannot run until its required city is
  // answered, which is what the Run dialog's block has to look like.
  {id: 'p3', name: 'Renter DE-3', deleted_at: null, automation_id: null,
    proxy_mode: 'direct'},
] as unknown as ScoutProfile[];

const AUTOMATIONS: ScoutAutomation[] = [
  {
    id: 'a1', name: 'FB group lead capture',
    description: 'Reads new posts in the target groups, extracts author and intent.',
    steps: [{id: 's1', type: 'goto', url: 'https://facebook.com'}] as ScoutAutomation['steps'],
    tags: ['facebook'], pinned: true,
    parameters: [
      {name: 'city_name', label: 'City', kind: 'text', required: true,
        hint: 'Which city to search.', placeholder: 'Dortmund'},
      {name: 'number_of_rooms', label: 'Rooms', kind: 'number', default: '2'},
      {name: 'listing_type', label: 'Listing', kind: 'select',
        options: ['Rent', 'Buy'], default: 'Rent'},
      {name: 'portal_token', label: 'Portal token', kind: 'secret'},
      {name: 'districts', label: 'Districts', kind: 'list',
        hint: 'One per line. A Loop step runs over them.'},
    ] as ScoutAutomation['parameters'],
    icon: 'brand:facebook', color: 'blue', folder_id: 'f-social',
    last_run_at: iso(42), last_run_status: 'ok',
    created_by: 'u', created_via: 'user', created_at: iso(60 * 24 * 6),
    schedule: {enabled: true, kind: 'interval', everyMinutes: 30, profileIds: ['p1', 'p2']},
  },
  {
    id: 'a2', name: 'WhatsApp warm-up',
    description: 'Opens chats and scrolls, twice a day.',
    steps: [
      {id: 's1', type: 'goto', url: 'https://web.whatsapp.com'},
      {id: 's2', type: 'callAutomation', automationId: 'a1'},
    ] as ScoutAutomation['steps'],
    tags: ['whatsapp'],
    icon: 'brand:whatsapp', color: 'green', folder_id: 'f-social',
    last_run_at: iso(60 * 26), last_run_status: 'failed',
    created_by: 'v', created_via: 'user', created_at: iso(60 * 24 * 3),
    schedule: {enabled: true, kind: 'daily', at: '09:00', profileIds: ['p1']},
  },
  {
    id: 'a3', name: 'Engage with commenters',
    description: 'Built by the agent during the lead-gen session.',
    steps: [{id: 's1', type: 'goto', url: 'https://facebook.com'}] as ScoutAutomation['steps'],
    icon: 'brand:instagram', color: 'violet',
    last_run_at: iso(60 * 5), last_run_status: 'partial',
    created_by: 'u', created_via: 'mcp', created_by_label: 'Claude',
    created_at: iso(0.05),
  },
  {
    id: 'a4', name: 'Proxy sanity sweep',
    description: '',
    steps: [{id: 's1', type: 'goto', url: 'https://example.com'}] as ScoutAutomation['steps'],
    created_by: 'v', created_via: 'user', created_at: iso(60 * 24 * 40),
  },
  // In Trash, so the rail's Trash card has a count and its view has a card to
  // draw. Deleted four days ago, which is inside the 30-day window -- the card
  // shows what is left of it.
  {
    id: 'a5', name: 'Old signup flow',
    description: 'Superseded by the warm-up. Kept until the quarter closes.',
    steps: [{id: 's1', type: 'goto', url: 'https://example.com/signup'}] as
      ScoutAutomation['steps'],
    icon: 'brand:x', color: 'red', folder_id: 'f-social',
    created_by: 'v', created_via: 'user', created_at: iso(60 * 24 * 90),
    deleted_at: iso(60 * 24 * 4),
  },
];

// Two folders and one empty one: the empty one is the only way to see the
// "Move automations here" dialog, which is this grid's substitute for the
// selection model the table tabs have.
const AUTOMATION_FOLDERS: ScoutFolder[] = [
  {id: 'f-social', name: 'Social', icon: 'users', color: 'violet'},
  {id: 'f-scraping', name: 'Scraping', icon: 'folder', color: 'amber'},
];

// The bell's two kinds. One handoff, and four notifications covering every
// state the card has: unread, read, each status tone, a title long enough to
// wrap and squeeze the clear button, and one with no automation_id -- the row
// that must NOT become a clickable card because it has nowhere to go.
const NOTIFICATIONS: (ScoutNotification & {read: boolean})[] = [
  {
    id: 'n1', kind: 'automation_run', title: 'FB group lead capture finished',
    body: '12 of 12 profiles done, 41 leads captured.', status: 'ok',
    automation_id: 'a1', run_id: 'r1', created_by: 'u', created_at: iso(4), read: false,
  },
  {
    id: 'n2', kind: 'automation_run',
    title: 'Engage with commenters on the Dortmund listings finished with warnings',
    body: '3 of 8 profiles could not reach the group.', status: 'partial',
    automation_id: 'a3', run_id: 'r2', created_by: 'v', created_at: iso(52), read: false,
  },
  {
    id: 'n3', kind: 'automation_run', title: 'WhatsApp warm-up failed',
    body: 'Step 2 timed out waiting for the chat list.', status: 'failed',
    automation_id: 'a2', run_id: 'r3', created_by: 'u', created_at: iso(60 * 27), read: true,
  },
  {
    id: 'n4', kind: 'automation_run', title: 'Proxy sanity sweep cancelled',
    body: 'Stopped by Vlad after 2 of 30 profiles.', status: 'cancelled',
    automation_id: null, run_id: 'r4', created_by: 'v', created_at: iso(60 * 30), read: true,
  },
];

const PENDING = [{
  id: 'h1', kind: 'profile' as const, item_name: 'Renter DE-1', to_user: 'u', from_user: 'v',
  note: 'Taking two weeks off -- this one is warmed up and needs its daily run.',
}];

type Ctx = {
  data: {
    state: CloudState;
    patch: {notifications: (fn: (list: CloudState['notifications']) =>
      CloudState['notifications']) => void};
  };
  shared: {
    setAssignee: (...args: unknown[]) => Promise<boolean>;
    pending: typeof PENDING;
    accept: (...args: unknown[]) => Promise<boolean>;
    decline: (...args: unknown[]) => Promise<void>;
  };
  reload: () => Promise<void>;
  // RefreshButton sits beside the bell in the inbox harness and reads this.
  refresh: () => Promise<void>;
  automations: {
    runs: Record<string, never>;
    setStarred: (id: string, starred: boolean) => void;
    setTelegramPref: () => void;
    linkTelegram: () => Promise<void>;
    unlinkTelegram: () => Promise<void>;
    testTelegram: () => Promise<string | null>;
    runMany: (...args: unknown[]) => Promise<void>;
    // Trash and filing. Stateful, like the stars above and for the same
    // reason: Restore and Move are the two things worth clicking in the
    // folder rail, and frozen fixtures would make both look broken.
    restore: (ids: string[]) => Promise<boolean>;
    purge: (ids: string[]) => Promise<boolean>;
    purgeAll: () => Promise<boolean>;
    assignToFolder: (ids: string[], folderId: string | null) => Promise<boolean>;
  };
  // The folder rail's Delete button. Nothing behind it here -- the dialog that
  // creates and renames folders is mounted from App, which this harness is not.
  library: {
    removeFolder: (folderId: string) => Promise<boolean>;
    createFolder: (fields: {name: string; kind: string}) => Promise<ScoutFolder | null>;
  };
  // Enough of the two action bundles for RunAutomationModal, which reads
  // profiles.update (the "save these values" checkbox) and proxies.checkMany
  // (its opening sweep). Both are no-ops here -- this harness renders, it does
  // not run anything.
  profiles: {
    update: (...args: unknown[]) => Promise<boolean>;
    uploadAvatar: (...args: unknown[]) => Promise<string>;
    // The profile importer's two engine calls. Both are the real pure
    // functions -- previewCsvImport mints no ids and planCsvImport is only
    // reached through importFromCsv, which this fixture stubs.
    previewImport: (parsed: never[]) => unknown;
    importFromCsv: (...args: unknown[]) => Promise<unknown>;
  };
  proxies: {
    checkMany: (...args: unknown[]) => Promise<void>;
    importList: (entries: unknown[]) => Promise<{created: number; failed: never[]}>;
    testConnection: (...args: unknown[]) => Promise<unknown>;
    testConnectionAndRecord: (...args: unknown[]) => Promise<unknown>;
    update: (...args: unknown[]) => Promise<boolean>;
  };
  cookies: {
    addCookieSet: (...args: unknown[]) => Promise<unknown>;
  };
  cookieTagOptions: never[];
  selectedProfileId: string | null;
  checkingProxyIds: Set<string>;
  toast: {
    setMessage: (text: string) => void;
    notify: (text: string) => void;
    fail: (title: string, detail: string) => void;
  };
  tagOptions: never[];
  // Added for the profile-editor harness (preview-profile.tsx). Additive: the
  // automations harness reads the same fixture and must keep working.
  statusOptions: string[];
  profileNotes: {list: (...args: unknown[]) => Promise<never[]>};
};

const WorkspaceContext = createContext<Ctx | null>(null);

export function useWorkspace(): Ctx {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error('preview workspace missing');
  }
  return value;
}

export function WorkspaceProvider({children}: {children: ReactNode}) {
  const [stars, setStars] = useState<string[]>(['a1']);
  // Stateful, unlike the rest of this fixture: the bell marks everything read
  // on open and clears a row on the X, and both are optimistic patches. Frozen
  // fixtures would make the panel look correct and behave like nothing.
  const [notifications, setNotifications] = useState(NOTIFICATIONS);
  const [pending, setPending] = useState(PENDING);
  // Same reasoning as `notifications`: Restore, Delete permanently, Empty
  // Trash and Move are all optimistic patches in the real app, and a frozen
  // list would leave every one of them looking like a dead button.
  const [automations, setAutomations] = useState(AUTOMATIONS);
  const [automationFolders, setAutomationFolders] = useState(AUTOMATION_FOLDERS);
  const state: CloudState = {
    ...defaultCloudState,
    automations,
    automation_folders: automationFolders,
    profiles: PROFILES,
    folders: PROFILE_FOLDERS,
    cookies: COOKIES,
    cookie_folders: COOKIE_FOLDERS,
    proxies: PROXIES,
    proxy_folders: PROXY_FOLDERS,
    members: MEMBERS,
    notifications,
    automation_stars: stars,
    telegram_link: {chat_id: '42', telegram_username: 'roman_p', linked_at: iso(60 * 24 * 2)},
  };
  const value: Ctx = {
    data: {state, patch: {notifications: (fn) => setNotifications(fn)}},
    shared: {
      setAssignee: async () => true,
      pending,
      accept: async (id) => {
        setPending((list) => list.filter((item) => item.id !== id));
        return true;
      },
      decline: async (id) => setPending((list) => list.filter((item) => item.id !== id)),
    },
    reload: async () => {},
    refresh: async () => {
      await new Promise((resolve) => setTimeout(resolve, 900));
    },
    automations: {
      runs: {},
      setStarred: (id, starred) => setStars((current) =>
        starred ? [...current, id] : current.filter((item) => item !== id)),
      setTelegramPref: () => {},
      linkTelegram: async () => {},
      unlinkTelegram: async () => {},
      testTelegram: async () => null,
      runMany: async () => {},
      restore: async (ids) => {
        setAutomations((list) => list.map((item) =>
          ids.includes(item.id) ? {...item, deleted_at: null} : item));
        return true;
      },
      purge: async (ids) => {
        setAutomations((list) => list.filter((item) => !ids.includes(item.id)));
        return true;
      },
      purgeAll: async () => {
        setAutomations((list) => list.filter((item) => !item.deleted_at));
        return true;
      },
      assignToFolder: async (ids, folderId) => {
        setAutomations((list) => list.map((item) =>
          ids.includes(item.id) ? {...item, folder_id: folderId} : item));
        return true;
      },
    },
    library: {
      createFolder: async (fields) => ({id: 'f-new', name: fields.name} as ScoutFolder),
      removeFolder: async (folderId) => {
        setAutomationFolders((list) => list.filter((item) => item.id !== folderId));
        // Mirrors the FK's ON DELETE SET NULL, which is what the real
        // useLibraryActions does locally for the same reason.
        setAutomations((list) => list.map((item) =>
          item.folder_id === folderId ? {...item, folder_id: null} : item));
        return true;
      },
    },
    profiles: {
      update: async () => true,
      uploadAvatar: async () => '',
      // The real pure preview, so the harness's review table is the one the
      // app draws rather than a hand-built lookalike.
      previewImport: (parsed) => previewCsvImport(parsed, {
        profiles: PROFILES, proxies: PROXIES, folders: PROFILE_FOLDERS,
      }),
      importFromCsv: async () => ({
        created: 4, updated: 1, proxiesCreated: 3, proxiesReused: 1, foldersCreated: 1,
        proxiesUpdated: 0, tagsTrimmed: 0, skipped: [], createdIds: [], partial: false,
      }),
    },
    proxies: {
      checkMany: async () => {},
      importList: async (entries) => ({created: entries.length, failed: []}),
      testConnection: async () => ({ok: true, pingMs: 118, country: 'Germany',
        countryCode: 'DE'}),
      testConnectionAndRecord: async () => ({ok: true, pingMs: 118, country: 'Germany',
        countryCode: 'DE'}),
      update: async () => true,
    },
    cookies: {addCookieSet: async () => ({id: 'new', name: 'imported'})},
    cookieTagOptions: [],
    selectedProfileId: 'p1',
    checkingProxyIds: new Set<string>(),
    toast: {setMessage: () => {}, notify: () => {}, fail: () => {}},
    tagOptions: [],
    statusOptions: ['Ready', 'Active', 'Warmup', 'Banned', 'Review'],
    profileNotes: {list: async () => []},
  };
  return (
    <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>
  );
}
