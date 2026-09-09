// What the Profiles table's cells can write, and what they can offer.
//
// The cells themselves are in tables/profileColumns.tsx and are pure functions
// of a row and a context -- they hold no hooks and reach for no store. This is
// where the context's two halves are built, and it is the only place the rules
// that a cell must not be able to get wrong are written down:
//
//  - assigned_to goes through the set_assignee RPC, never a profile patch.
//  - a fingerprint patch spreads the existing fingerprint before it is sent.
//
// Deliberately NOT memoised. Every handler closes over `state`, which changes
// on every write, and a stable identity here would be a stale closure that
// looks correct for as long as nobody edits two fields in a row. The tab
// already rebuilds its column context each render for the same reason. The
// option lists ARE memoised, because they are pure derivations of arrays that
// only change when the data does.
import {useMemo} from 'react';
import {CookieSetLabel} from '../components/ui/CookieSetLabel';
import {PlatformIcon} from '../components/ui/icons';
import {statusOptionRows} from '../components/ui/StatusChip';
import {
  fingerprintPatchForOs, languagePresets, osPresets, timezoneGroups,
} from '../lib/fingerprintPresets';
import {proxyOptionLabel, proxySearchText} from '../lib/proxies';
import {normalizeTags} from '../lib/tags';
import {useOrg} from '../org';
import {useWorkspace} from '../workspace/WorkspaceProvider';
import type {CellOption} from '../components/ui/CellControls';
import type {ProfileCellActions, ProfileCellOptions} from './profileColumns';
import type {ScoutCookie, ScoutProfile, CloudState} from '../types';

// Static: neither list depends on the workspace, so neither is rebuilt.
const TIMEZONE_OPTIONS: CellOption[] = timezoneGroups.flatMap((group) =>
  group.zones.map((zone) => ({
    value: zone.name,
    label: zone.label,
    // The IANA name is what somebody who knows what they want types --
    // "Berlin" finds it by label, "Europe/" finds it by name.
    searchText: `${zone.label} ${zone.name} ${group.region}`.toLowerCase(),
    hint: group.region,
  })));

const LANGUAGE_OPTIONS: CellOption[] = languagePresets.map((preset) => ({
  value: preset,
  label: preset,
}));

// The six platforms, each with its own mark, so the picker and the cell speak
// the same language. Android and iOS carry a warning the platform picker in the
// editor also carries: only windows/macos/linux are implemented browser-side,
// so those two get a user-agent string but no UA-Client-Hints override and
// still report a desktop platform.
const PLATFORM_OPTIONS: CellOption[] = osPresets.map((os) => ({
  value: os,
  label: os,
  // PlatformIcon, not PlatformLabel: the row spells the platform out, so the
  // label's version suffix would read "11 Windows 11". The mark is what makes
  // the list scannable; the words are what make it unambiguous.
  render: (
    <>
      <PlatformIcon os={os} size={16} />
      <span className="filter-pop-name">{os}</span>
    </>
  ),
  hint: os === 'Android' || os === 'iOS' ? 'desktop hints' : undefined,
}));

export function useProfileCellOptions(
    state: CloudState, statusOptions: string[]): ProfileCellOptions {
  const statuses = useMemo(() => statusOptionRows(statusOptions), [statusOptions]);

  const proxies = useMemo<CellOption[]>(() => state.proxies.map((proxy) => ({
    value: proxy.id,
    label: proxyOptionLabel(proxy),
    searchText: proxySearchText(proxy),
  })), [state.proxies]);

  // Yourself first and named "You", the same word the Assignee chip uses --
  // AssigneeSelect orders its <option>s the same way for the same reason.
  const members = useMemo<CellOption[]>(() => state.members.map((member) => ({
    value: member.user_id,
    label: member.display_name || member.email.split('@')[0] || member.email,
    searchText: `${member.display_name || ''} ${member.email}`.toLowerCase(),
  })), [state.members]);

  // Trashed workflows stay in state so Trash can be a view of it; a picker
  // that offered one would attach a profile to something that will not run.
  const automations = useMemo<CellOption[]>(() => state.automations
      .filter((automation) => !automation.deleted_at)
      .map((automation) => ({value: automation.id, label: automation.name})),
  [state.automations]);

  // Drawn with the set's own mark, the same one the Cookies table gives it and
  // the same one the cell's trigger now shows -- so picking a set from this
  // list and reading it back afterwards are the same act of recognition.
  const cookieSets = useMemo<CellOption[]>(() => state.cookies
      .filter((cookie) => !cookie.deleted_at)
      .map((cookie) => ({
        value: cookie.id,
        label: cookie.name,
        render: <CookieSetLabel cookie={cookie} folders={state.cookie_folders} />,
      })), [state.cookies, state.cookie_folders]);

  return {
    platforms: PLATFORM_OPTIONS,
    statuses,
    proxies,
    members,
    automations,
    cookieSets,
    timezones: TIMEZONE_OPTIONS,
    languages: LANGUAGE_OPTIONS,
  };
}

// The hardware a platform preset actually names.
//
// Both shapes fingerprintPatchForOs can return -- a RealisticFingerprintPattern
// for Windows, an osFingerprintDefaults entry for everything else -- write only
// these, and the pair of them is what makes an identity coherent: an Apple GPU
// belongs with an Apple CPU and a Retina resolution, and a Windows box does not
// have either. Listed explicitly rather than run through
// fingerprintFromDraftPatch, which fills the WHOLE fingerprint shape: spread
// over an existing one it would blank every field the preset is silent about,
// and quietly reset do_not_track and rotate_on_launch to false along the way.
const PLATFORM_FIELDS = [
  ['fingerprint_user_agent', 'user_agent'],
  ['fingerprint_browser_version', 'browser_version'],
  ['fingerprint_webgl_vendor', 'webgl_vendor'],
  ['fingerprint_webgl_renderer', 'webgl_renderer'],
  ['fingerprint_screen', 'screen'],
  ['fingerprint_cpu_model', 'cpu_model'],
  ['fingerprint_media_devices', 'media_devices'],
] as const;

// cpu_cores and memory_gb are numbers on the profile and strings on the draft,
// so they are converted rather than copied.
const PLATFORM_NUMBERS = [
  ['fingerprint_cpu_cores', 'cpu_cores'],
  ['fingerprint_memory_gb', 'memory_gb'],
] as const;

type Fingerprint = NonNullable<ScoutProfile['fingerprint']>;

// Everything a platform change should write, and nothing else.
export function platformFingerprintPatch(os: string): Fingerprint {
  const preset = fingerprintPatchForOs(os) as Record<string, string | undefined>;
  const patch: Fingerprint = {os};
  for (const [from, to] of PLATFORM_FIELDS) {
    const value = preset[from];
    if (value !== undefined) {
      Object.assign(patch, {[to]: value});
    }
  }
  for (const [from, to] of PLATFORM_NUMBERS) {
    const value = preset[from];
    if (value !== undefined && value !== '') {
      Object.assign(patch, {[to]: Number(value)});
    }
  }
  return patch;
}

// The three jumps a cell cannot perform itself: two belong to App (which tab is
// showing, which dialog is open) and one to the tab (which folder it is
// filtered to).
export type ProfileCellJumps = {
  filterFolder: (folderId: string) => void;
  openFingerprint: (profile: ScoutProfile) => void;
  openCookieSet: (cookie: ScoutCookie) => void;
};

export function useProfileCellActions(jumps: ProfileCellJumps): ProfileCellActions {
  const {profiles, proxies, shared, reload} = useWorkspace();
  const org = useOrg();

  return {
    setName: (profile, name) => void profiles.update(profile, {name}),

    setStatus: (profile, status) => void profiles.update(profile, {status}),

    // Through normalizeTags, like the editor, the CSV importer and the
    // automation bridge. TagInput already refuses a duplicate and stops at the
    // cap, so this is belt and braces -- but it is the fourth write path into
    // profiles.tags, and the rule in lib/tags.ts is that all of them go through
    // the one enforcement point. A cell that skipped it could leave a row the
    // dialog would then refuse to save.
    setTags: (profile, tags) => void profiles.update(profile, {tags: normalizeTags(tags)}),

    // Not a relabel. Picking a platform re-rolls the GPU, CPU, screen and
    // media-device set with it, the same way <PlatformPicker> does in the
    // editor -- an Apple GPU on a profile reporting Windows is a contradiction
    // any checker reads straight off the page.
    setPlatform: (profile, os) => void profiles.update(profile, {
      fingerprint: {...profile.fingerprint, ...platformFingerprintPatch(os)},
    }),

    // Not profiles.update. profilePatchToRow omits assigned_to on purpose --
    // an ordinary save from a session that had not seen a reassignment would
    // otherwise carry its stale value back and silently unassign the row -- so
    // a patch carrying it is dropped and the write looks like it worked.
    // ProfileModal takes the same second-call route after its save.
    setAssignee: (profile, userId) => {
      if (!org.orgId) {
        return;
      }
      void shared.setAssignee(org.orgId, 'profile', profile.id, userId || null, reload);
    },

    // proxy_mode is the field that decides whether a proxy is required at all,
    // so it moves with proxy_id rather than being left behind: clearing the id
    // while the mode still says `assigned` is a profile that refuses to launch.
    setProxy: (profile, proxyId) => void profiles.update(profile, proxyId ?
      {proxy_id: proxyId, proxy_mode: 'assigned'} :
      {proxy_id: null, proxy_mode: 'direct'}),

    setAutomation: (profile, automationId) =>
      void profiles.update(profile, {automation_id: automationId || null}),

    // Clearing means all five fields, not just the FK. Nulling cookie_id alone
    // leaves cookie_import_path/_url/_name/_count live, and buildLaunchPayload
    // and migrateLegacyCookieImports both read those -- so the set would look
    // unassigned in every screen while the next launch signed straight back in.
    setCookieSet: (profile, cookieId) => void profiles.update(profile, cookieId ?
      {cookie_mode: 'saved', cookie_id: cookieId} :
      {
        cookie_mode: 'paste',
        cookie_id: null,
        cookie_import_path: null,
        cookie_import_url: null,
        cookie_import_name: null,
        cookie_import_count: null,
      }),

    setStartUrl: (profile, url) => void profiles.update(profile, {start_url: url || null}),

    // The spread is the whole point of this function existing. profilePatchToRow
    // replaces the fingerprint object wholesale, so a patch of one field sent
    // straight through would blank the other twenty.
    setFingerprint: (profile, patch) =>
      void profiles.update(profile, {fingerprint: {...profile.fingerprint, ...patch}}),

    recheckProxy: (proxy) => void proxies.checkOnce(proxy),

    ...jumps,
  };
}
