// Form state for the editor dialogs, and the conversions between it and the
// domain rows in types.ts. A draft is deliberately all-strings: it is what a
// controlled <input> holds, so "" and "8" are the right representations of an
// unset and a set number, not null and 8.
import {
  AUTO_FROM_PROXY,
  defaultWindowsFingerprintPattern,
  fingerprintPatchForOs,
  mediaDevicePresets,
  normalizeOsPreset,
} from './lib/fingerprintPresets';
import {DEFAULT_PROFILE_COLOR, normalizeProfileColor, randomProfileColor} from './lib/profileColors';
import {newRowId} from './lib/random';
import {normalizeTags} from './lib/tags';
import {valuesToStrings} from './automations/parameters';
import {numberOrNull} from './lib/text';
import type {ScoutProfile, ScoutProxy, ProxyMode, SharedBookmark} from './types';
import type {FolderKind} from './workspace/useLibraryActions';

export type ProfileDraft = {
  // Minted when the draft is created, not when it is first written. A profile's
  // id is also its directory name under the browser's profile root, so it is
  // worth showing in the Summary before the save rather than after -- the panel
  // used to print "New profile" there, which is not an id anyone can use.
  id: string;
  // Whether this draft corresponds to a row that already exists. It used to be
  // inferred from `id` being set, which stopped working once every draft has
  // one.
  saved: boolean;
  name: string;
  status: string;
  color: string;
  // `brand:<slug>`, an https URL, or '' for the initials plate. See
  // ScoutProfile.avatar; parsed in src/lib/profileAvatar.ts.
  avatar: string;
  folder_id: string;
  // The teammate on the hook for this profile, as an auth user id, or '' for
  // unassigned.
  //
  // Unlike every other field here it does NOT travel through profileFromDraft
  // into ScoutProfile: profileToRow deliberately omits assigned_to so an
  // ordinary edit cannot carry a stale value back over an assignment made in
  // another session. It rides in the draft only so the picker has somewhere to
  // hold the choice until Save, which then applies it through set_assignee.
  assigned_to: string;
  // Login credentials for whatever account this profile is signed into --
  // stored plaintext the same way proxy_search/proxy credentials already
  // are (see ScoutProfile.email/password in types.ts). Not used by Anty
  // itself for anything; exposed so MCP-driven agents (get_profile/
  // update_profile) can read/fill a login form without the user re-typing
  // credentials into the agent's own prompt each time.
  email: string;
  password: string;
  // Where the pair above signs in. Reference only, exactly like them -- see
  // ScoutProfile.login_url. Also reaches automations as {{profile.login_url}}.
  login_url: string;
  proxy_id: string;
  proxy_mode: ProxyMode;
  proxy_search: string;
  proxy_link: string;
  tags: string;
  start_url: string;
  // Which automation runs when this profile launches, or '' for none.
  automation_id: string;
  // This profile's answers to each automation's declared parameters, keyed by
  // automation id. The one field that is not a flat string, because it is not
  // one control -- it is a form per automation, and which automations appear is
  // the user's choice. The LEAVES are still strings, which is what keeps the
  // all-strings rule above meaningful: coercion to the declared type happens
  // once, at run time, in resolveRunVars.
  automation_vars: Record<string, Record<string, string>>;
  cookie_import_path: string;
  cookie_import_url: string;
  cookie_import_name: string;
  cookie_import_count: number;
  // 'saved' picks a shared cookie-set (Cookies tab) by cookie_id; 'paste'
  // keeps the existing free-text/uploaded-file flow via cookie_import_*.
  cookie_mode: 'paste' | 'saved';
  cookie_id: string;
  cookie_search: string;
  command_line_switches: string;
  fingerprint_os: string;
  fingerprint_browser_version: string;
  fingerprint_user_agent: string;
  fingerprint_language: string;
  fingerprint_timezone: string;
  fingerprint_geolocation: string;
  fingerprint_webrtc: string;
  fingerprint_canvas: string;
  fingerprint_webgl: string;
  fingerprint_webgpu: string;
  fingerprint_client_rects: string;
  fingerprint_audio: string;
  fingerprint_webgl_vendor: string;
  fingerprint_webgl_renderer: string;
  fingerprint_screen: string;
  fingerprint_cpu_model: string;
  fingerprint_cpu_cores: string;
  fingerprint_memory_gb: string;
  fingerprint_media_devices: string;
  fingerprint_do_not_track: boolean;
  fingerprint_rotate: boolean;
};

export type ProxyDraft = {
  id?: string;
  name: string;
  type: 'http' | 'socks5';
  host: string;
  port: string;
  username: string;
  password: string;
};

export type BookmarkDraft = {
  originalUrl?: string;
  title: string;
  url: string;
  icon: string;
};

export type FolderDraft = {
  id?: string;
  // Which library this folder belongs to. Decides which suggestions the dialog
  // offers, which tab it lands in, and what the delete warning says. Not
  // editable once the folder exists -- moving a folder between libraries would
  // orphan everything filed in it.
  kind: FolderKind;
  name: string;
  // A FOLDER_ICONS key. Always set in the draft even though ScoutFolder.icon is
  // optional -- the picker is a radiogroup and needs something selected.
  icon: string;
  // A PROFILE_COLORS key or a custom hex, same as ProfileDraft.color. Always
  // set, for the same radiogroup reason as icon.
  color: string;
  // Set when the draft was started from a tag suggestion, so the dialog can
  // offer to move that tag's profiles in once the folder exists. Not persisted
  // -- it describes where this dialog came from, not what a folder is.
  fromTag?: string;
  // The proxy-side twin of fromTag: an ISO country code the folder was
  // suggested from, so the proxies checked into that country arrive pre-ticked
  // in the move dialog. Equally not persisted.
  fromCountry?: string;
};

export type StatusDraft = {
  name: string;
};

// `selfId` seeds the assignee so the picker opens on "You", which is what the
// profiles.assigned_to column default (auth.uid()) is about to do anyway --
// showing "Unassigned" there would be the editor contradicting the row it is
// about to write. Optional because csvImport calls this purely for the
// fingerprint and colour defaults and has no user id to hand.
export function newProfileDraft(selfId = ''): ProfileDraft {
  return {
    id: newRowId(),
    saved: false,
    name: `Profile ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}`,
    status: 'Ready',
    // Random, not the default: this is a profile being created, and the colour
    // decides which tile its browser window gets in the Dock.
    color: randomProfileColor(),
    avatar: '',
    folder_id: '',
    assigned_to: selfId,
    email: '',
    password: '',
    login_url: '',
    proxy_id: '',
    proxy_mode: 'assigned',
    proxy_search: '',
    proxy_link: '',
    tags: '',
    start_url: '',
    automation_id: '',
    automation_vars: {},
    cookie_import_path: '',
    cookie_import_url: '',
    cookie_import_name: '',
    cookie_import_count: 0,
    cookie_mode: 'paste',
    cookie_id: '',
    cookie_search: '',
    command_line_switches: '',
    fingerprint_os: 'Windows 11',
    fingerprint_browser_version: 'Auto',
    fingerprint_user_agent: '',
    fingerprint_language: AUTO_FROM_PROXY,
    fingerprint_timezone: AUTO_FROM_PROXY,
    fingerprint_geolocation: AUTO_FROM_PROXY,
    fingerprint_webrtc: 'Proxy only',
    fingerprint_canvas: 'Noise',
    fingerprint_webgl: 'Noise',
    fingerprint_webgpu: 'Real',
    fingerprint_client_rects: 'Noise',
    fingerprint_audio: 'Noise',
    fingerprint_webgl_vendor: defaultWindowsFingerprintPattern.fingerprint_webgl_vendor,
    fingerprint_webgl_renderer: defaultWindowsFingerprintPattern.fingerprint_webgl_renderer,
    fingerprint_screen: defaultWindowsFingerprintPattern.fingerprint_screen,
    fingerprint_cpu_model: defaultWindowsFingerprintPattern.fingerprint_cpu_model,
    fingerprint_cpu_cores: defaultWindowsFingerprintPattern.fingerprint_cpu_cores,
    fingerprint_memory_gb: defaultWindowsFingerprintPattern.fingerprint_memory_gb,
    fingerprint_media_devices: mediaDevicePresets[0],
    fingerprint_do_not_track: false,
    // Off by default. Rotating the seed re-rolls canvas, WebGL, audio and client
    // rects on every launch, so a profile carrying a logged-in session presents a
    // different device each time it opens -- which is precisely the shape of a
    // stolen cookie, and gets the session challenged rather than protected. A
    // stable per-profile seed is the safer default; rotation stays available for
    // profiles that are not holding a session.
    fingerprint_rotate: false,
  };
}

export function draftFromProfile(profile: ScoutProfile): ProfileDraft {
  const fingerprint = profile.fingerprint || {};
  return {
    id: profile.id,
    saved: true,
    name: profile.name,
    status: profile.status || 'Ready',
    // Normalized on read, so a profile saved with one of the six old hexes
    // opens on the matching preset key instead of showing a seventh, custom
    // swatch that happens to be the same colour.
    color: normalizeProfileColor(profile.color),
    avatar: profile.avatar || '',
    folder_id: profile.folder_id || '',
    assigned_to: profile.assigned_to || '',
    email: profile.email || '',
    password: profile.password || '',
    login_url: profile.login_url || '',
    proxy_id: profile.proxy_id || '',
    proxy_mode: profile.proxy_mode || 'assigned',
    proxy_search: '',
    proxy_link: '',
    tags: profile.tags?.join(', ') || '',
    start_url: profile.start_url || '',
    automation_id: profile.automation_id || '',
    automation_vars: profileVarsToDraft(profile.automation_vars),
    cookie_import_path: profile.cookie_import_path || '',
    cookie_import_url: profile.cookie_import_url || '',
    cookie_import_name: profile.cookie_import_name || '',
    cookie_import_count: profile.cookie_import_count || 0,
    cookie_mode: profile.cookie_id ? 'saved' : 'paste',
    cookie_id: profile.cookie_id || '',
    cookie_search: '',
    command_line_switches: profile.command_line_switches || '',
    fingerprint_os: normalizeOsPreset(fingerprint.os),
    fingerprint_browser_version: fingerprint.browser_version || 'Auto',
    fingerprint_user_agent: fingerprint.user_agent || '',
    fingerprint_language: fingerprint.language || AUTO_FROM_PROXY,
    fingerprint_timezone: fingerprint.timezone || AUTO_FROM_PROXY,
    fingerprint_geolocation: fingerprint.geolocation || AUTO_FROM_PROXY,
    fingerprint_webrtc: fingerprint.webrtc || 'Proxy only',
    fingerprint_canvas: fingerprint.canvas || 'Noise',
    fingerprint_webgl: fingerprint.webgl || 'Noise',
    fingerprint_webgpu: fingerprint.webgpu || 'Real',
    fingerprint_client_rects: fingerprint.client_rects || 'Noise',
    fingerprint_audio: fingerprint.audio || 'Noise',
    fingerprint_webgl_vendor: fingerprint.webgl_vendor || '',
    fingerprint_webgl_renderer: fingerprint.webgl_renderer || '',
    fingerprint_screen: fingerprint.screen || 'Auto',
    fingerprint_cpu_model: fingerprint.cpu_model || '',
    fingerprint_cpu_cores: fingerprint.cpu_cores ? String(fingerprint.cpu_cores) : '8',
    fingerprint_memory_gb: fingerprint.memory_gb ? String(fingerprint.memory_gb) : '8',
    fingerprint_media_devices: fingerprint.media_devices || mediaDevicePresets[0],
    fingerprint_do_not_track: Boolean(fingerprint.do_not_track),
    fingerprint_rotate: Boolean(fingerprint.rotate_on_launch),
  };
}

// Stored parameter values to form state, one automation at a time. Every leaf
// becomes a string through valuesToStrings, which the Run dialog also uses --
// the two surfaces show the same boxes and must fill them the same way.
function profileVarsToDraft(
    stored: ScoutProfile['automation_vars']): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [automationId, values] of Object.entries(stored || {})) {
    out[automationId] = valuesToStrings(values);
  }
  return out;
}

// ...and back. Blank leaves are dropped rather than written: an empty string
// already means "not set" to resolveRunVars, so storing one is noise that also
// hides which values the user actually chose. The automation's own key SURVIVES
// an all-blank entry -- adding the block is itself a choice, and dropping it
// would make the section vanish the next time the profile is opened.
function draftVarsToProfile(
    draft: Record<string, Record<string, string>>): ScoutProfile['automation_vars'] {
  const out: NonNullable<ScoutProfile['automation_vars']> = {};
  for (const [automationId, values] of Object.entries(draft || {})) {
    const entry: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values || {})) {
      if (value.trim() !== '') {
        entry[name] = value;
      }
    }
    out[automationId] = entry;
  }
  return out;
}

export function tagsFromDraft(value: string) {
  return value.split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
}

export function withFingerprintOs(draft: ProfileDraft, os: string): ProfileDraft {
  return {
    ...draft,
    fingerprint_os: os,
    ...fingerprintPatchForOs(os),
  };
}

// The fingerprint half of a draft, in the shape ScoutProfile stores it. Used
// both when saving the editor and when a launch rotates the fingerprint.
export function fingerprintFromDraftPatch(
    patch: Partial<ProfileDraft>): NonNullable<ScoutProfile['fingerprint']> {
  return {
    os: patch.fingerprint_os,
    browser_version: patch.fingerprint_browser_version,
    user_agent: patch.fingerprint_user_agent,
    language: patch.fingerprint_language,
    timezone: patch.fingerprint_timezone,
    geolocation: patch.fingerprint_geolocation,
    webrtc: patch.fingerprint_webrtc,
    canvas: patch.fingerprint_canvas,
    webgl: patch.fingerprint_webgl,
    webgpu: patch.fingerprint_webgpu,
    client_rects: patch.fingerprint_client_rects,
    audio: patch.fingerprint_audio,
    webgl_vendor: patch.fingerprint_webgl_vendor,
    webgl_renderer: patch.fingerprint_webgl_renderer,
    screen: patch.fingerprint_screen,
    cpu_model: patch.fingerprint_cpu_model,
    cpu_cores: numberOrNull(patch.fingerprint_cpu_cores || ''),
    memory_gb: numberOrNull(patch.fingerprint_memory_gb || ''),
    media_devices: patch.fingerprint_media_devices,
    do_not_track: Boolean(patch.fingerprint_do_not_track),
    rotate_on_launch: Boolean(patch.fingerprint_rotate),
  };
}

// The saved row a profile draft describes. `createdAt` is threaded in by the
// caller because only it knows whether this is an edit (keep the original) or
// a create (stamp now).
export function profileFromDraft(draft: ProfileDraft, createdAt?: string): ScoutProfile {
  return {
    id: draft.id,
    name: draft.name.trim(),
    status: draft.status.trim() || 'Ready',
    color: draft.color || DEFAULT_PROFILE_COLOR,
    avatar: draft.avatar.trim() || undefined,
    folder_id: draft.folder_id.trim() || null,
    email: draft.email.trim() || undefined,
    password: draft.password || undefined,
    login_url: draft.login_url.trim() || undefined,
    proxy_id: draft.proxy_mode === 'assigned' ? (draft.proxy_id || null) : null,
    proxy_mode: draft.proxy_mode,
    // Normalized rather than merely split: a draft loaded from a row that an
    // import or the API had already over-filled would otherwise carry its
    // extra tags straight back to the database on the next save.
    tags: normalizeTags(tagsFromDraft(draft.tags)),
    start_url: draft.start_url.trim() || null,
    automation_id: draft.automation_id || null,
    automation_vars: draftVarsToProfile(draft.automation_vars),
    cookie_import_path: draft.cookie_import_path.trim() || null,
    cookie_import_url: draft.cookie_import_url.trim() || null,
    cookie_import_name: draft.cookie_import_name.trim() || null,
    cookie_import_count: draft.cookie_import_path.trim() || draft.cookie_import_url.trim() ?
      draft.cookie_import_count || null :
      null,
    cookie_mode: draft.cookie_mode,
    cookie_id: draft.cookie_mode === 'saved' ? (draft.cookie_id || null) : null,
    command_line_switches: draft.command_line_switches.trim() || null,
    fingerprint: {
      ...fingerprintFromDraftPatch(draft),
      user_agent: draft.fingerprint_user_agent.trim(),
      webgl_vendor: draft.fingerprint_webgl_vendor.trim(),
      webgl_renderer: draft.fingerprint_webgl_renderer.trim(),
    },
    created_at: createdAt,
  };
}

export function newProxyDraft(): ProxyDraft {
  return {
    name: '',
    type: 'socks5',
    host: '',
    port: '',
    username: '',
    password: '',
  };
}

export function draftFromProxy(proxy: ScoutProxy): ProxyDraft {
  return {
    id: proxy.id,
    name: proxy.name || '',
    type: proxy.type || 'http',
    host: proxy.host,
    port: String(proxy.port || ''),
    username: proxy.username || '',
    password: proxy.password || '',
  };
}

export function newBookmarkDraft(): BookmarkDraft {
  return {
    title: '',
    url: '',
    icon: '',
  };
}

export function draftFromBookmark(bookmark: SharedBookmark): BookmarkDraft {
  return {
    originalUrl: bookmark.url,
    title: bookmark.title || '',
    url: bookmark.url || '',
    icon: bookmark.icon || '',
  };
}
