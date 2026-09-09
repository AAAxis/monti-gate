// The shared per-org collections that are not profiles or proxies: folders,
// custom statuses, the cookie-set library, shared bookmarks and shared
// extensions. Small CRUD, grouped because each one is a handful of lines and
// they all follow the same write-then-patch shape.
import * as db from '../db';
import {describeDbError} from '../db/errors';
import {baseProfileStatuses} from '../data/statuses';
import {statusList} from '../lib/text';
import {native} from '../native';
import {supabase} from '../supabase';
import {newId} from './core';
import type {WorkspaceCore} from './core';
import type {
  ScoutFolder, BuiltInExtensionToggles, SharedBookmark, SharedExtension,
} from '../types';

export type LibraryActions = ReturnType<typeof useLibraryActions>;

// What the folder dialog can set. Create and save take the same shape so a
// field added to one cannot be forgotten in the other.
//
// `kind` is required rather than defaulted: which library a folder belongs to
// is not something a call site should be able to leave to chance, and a proxy
// folder that quietly became a profile folder would vanish from the tab that
// created it.
export type FolderKind = 'profile' | 'proxy' | 'cookie' | 'automation';

export type FolderFields = {
  kind: FolderKind;
  name: string;
  icon?: string;
  color?: string;
};

export function useLibraryActions({data, toast}: WorkspaceCore) {
  const {state, setState, withDb, patch} = data;

  // ---- Folders ---------------------------------------------------------

  // Takes the fields as one object rather than positionally: it was
  // createFolder(name, icon) and a third `color` argument is where a call site
  // stops saying which value is which.
  // Every library's folders live in one table, so every local patch has to go
  // to the list for this folder's kind. Reading the kind off the stored folder
  // rather than asking the caller for it keeps delete callers at one argument
  // and makes the paths structurally unable to disagree.
  const folderList = (kind: FolderKind) => {
    switch (kind) {
      case 'proxy':
        return patch.proxyFolders;
      case 'cookie':
        return patch.cookieFolders;
      case 'automation':
        return patch.automationFolders;
      default:
        return patch.folders;
    }
  };

  function kindOfFolder(folderId: string): FolderKind | null {
    if (state.folders.some((folder) => folder.id === folderId)) {
      return 'profile';
    }
    if (state.proxy_folders.some((folder) => folder.id === folderId)) {
      return 'proxy';
    }
    if (state.cookie_folders.some((folder) => folder.id === folderId)) {
      return 'cookie';
    }
    return state.automation_folders.some((folder) => folder.id === folderId) ?
      'automation' : null;
  }

  async function createFolder(
      fields: FolderFields): Promise<ScoutFolder | null> {
    const folder: ScoutFolder = {id: newId(), ...fields, created_at: new Date().toISOString()};
    if (!await withDb((activeOrgId) => db.folders.create(activeOrgId, folder))) {
      return null;
    }
    folderList(fields.kind)((list) => [...list, folder]);
    return folder;
  }

  async function saveFolder(folderId: string, fields: FolderFields): Promise<boolean> {
    const next = {name: fields.name, icon: fields.icon ?? null, color: fields.color ?? null};
    if (!await withDb((activeOrgId) => db.folders.update(activeOrgId, folderId, next))) {
      return false;
    }
    // The kind is not editable, so it is not in the update -- a folder cannot
    // be moved from one library to the other, only made again in the other.
    folderList(fields.kind)((list) => list.map((item) => item.id === folderId ?
      {...item, name: fields.name, icon: fields.icon, color: fields.color} :
      item));
    return true;
  }

  // profiles.folder_id / proxies.folder_id / cookie_sets.folder_id /
  // automations.folder_id are all nulled server-side by the FK's ON DELETE SET
  // NULL, so this is genuinely one statement; the local lists just mirror it.
  async function removeFolder(folderId: string): Promise<boolean> {
    const kind = kindOfFolder(folderId);
    if (!await withDb((activeOrgId) => db.folders.remove(activeOrgId, folderId))) {
      return false;
    }
    if (kind === 'automation') {
      patch.automationFolders((list) => list.filter((item) => item.id !== folderId));
      patch.automations((list) => list.map((automation) =>
        automation.folder_id === folderId ? {...automation, folder_id: null} : automation));
      return true;
    }
    if (kind === 'proxy') {
      patch.proxyFolders((list) => list.filter((item) => item.id !== folderId));
      patch.proxies((list) => list.map((proxy) =>
        proxy.folder_id === folderId ? {...proxy, folder_id: null} : proxy));
      return true;
    }
    if (kind === 'cookie') {
      patch.cookieFolders((list) => list.filter((item) => item.id !== folderId));
      patch.cookies((list) => list.map((cookie) =>
        cookie.folder_id === folderId ? {...cookie, folder_id: null} : cookie));
      return true;
    }
    patch.folders((list) => list.filter((item) => item.id !== folderId));
    patch.profiles((list) => list.map((profile) =>
      profile.folder_id === folderId ? {...profile, folder_id: null} : profile));
    return true;
  }

  // ---- Statuses --------------------------------------------------------

  async function createStatus(name: string): Promise<boolean> {
    // A built-in status needs no row; statusList still dedupes the local list.
    const isNew = !baseProfileStatuses.includes(name) && !state.custom_statuses.includes(name);
    if (isNew && !await withDb((activeOrgId) => db.statuses.create(activeOrgId, name))) {
      return false;
    }
    const statuses = statusList(
        state.custom_statuses,
        baseProfileStatuses.includes(name) ? [] : [name]);
    setState((current) => ({...current, custom_statuses: statuses}));
    return true;
  }

  // The cookie-set library lives in useCookieActions -- it outgrew this hook's
  // "each one is a handful of lines" premise once the Cookies tab gained
  // folders, tags, a Trash and an editable payload.

  // ---- Bookmarks -------------------------------------------------------

  // Bookmarks are addressed by url, the way the edit dialog already thinks of
  // them: originalUrl identifies the row when the url itself is being changed.
  async function saveBookmark(
      bookmark: SharedBookmark, originalUrl?: string): Promise<boolean> {
    const existing = state.shared_bookmarks.find((item) =>
      item.url === (originalUrl || bookmark.url));
    const saved: SharedBookmark = {
      ...bookmark,
      position: existing?.position ?? state.shared_bookmarks.length,
    };
    const ok = await withDb(async (activeOrgId) => {
      if (existing) {
        await db.bookmarks.updateByUrl(activeOrgId, existing.url, saved);
      } else {
        await db.bookmarks.create(activeOrgId, saved);
      }
    });
    if (!ok) {
      return false;
    }
    patch.bookmarks((list) => [
      ...list.filter((item) => item.url !== (originalUrl || bookmark.url)),
      saved,
    ]);
    return true;
  }

  // Bulk-adds bookmarks from another browser's exported file. Positions carry
  // on from the end of the current list, so an import lands after what is
  // already there rather than interleaving with it.
  async function importBookmarks(entries: SharedBookmark[]): Promise<number> {
    if (!entries.length) {
      return 0;
    }
    const base = state.shared_bookmarks.length;
    const saved = entries.map((entry, index) => ({...entry, position: base + index}));
    let created: SharedBookmark[] = [];
    const ok = await withDb(async (activeOrgId) => {
      created = await db.bookmarks.createMany(activeOrgId, saved);
    });
    if (!ok) {
      return 0;
    }
    // The rows returned by the insert, not the ones sent: they carry the uuid
    // the column default generated.
    patch.bookmarks((list) => [...list, ...created]);
    return created.length;
  }

  async function removeBookmark(url: string): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.bookmarks.removeByUrl(activeOrgId, url))) {
      return false;
    }
    patch.bookmarks((list) => list.filter((bookmark) => bookmark.url !== url));
    return true;
  }

  // ---- Shared extensions ----------------------------------------------

  // Uploads the zipped folder to Supabase Storage so every team member can
  // materialize their own local copy later (see main.cjs's
  // materializeSharedExtension) -- cloud state only ever holds this public
  // URL, never the extension's files directly.
  async function addExtensionFromFolder(): Promise<boolean> {
    if (!native?.selectExtensionFolder || !native?.zipExtensionFolder) {
      toast.setMessage('Native folder picker is not available. Restart Scout Web and try again.');
      return false;
    }
    const folderPath = await native.selectExtensionFolder();
    if (!folderPath?.trim()) {
      return false;
    }
    if (!supabase) {
      toast.setMessage('Cloud sync is not configured, so this extension can only be shared with your team once it is.');
      return false;
    }
    toast.setMessage('Uploading extension for your team…');
    const zipped = await native.zipExtensionFolder(folderPath);
    if (!zipped.ok || !zipped.base64) {
      toast.setMessage(zipped.error || 'Failed to zip that extension folder.');
      return false;
    }
    const id = newId();
    const name = folderPath.trim().split('/').filter(Boolean).at(-1) || 'Extension';
    let uploaded: {url: string; inline: boolean};
    try {
      uploaded = await db.extensions.uploadPackage(id, zipped.base64);
    } catch (error) {
      toast.setMessage(describeDbError(error, 'Upload failed.'));
      return false;
    }
    const extension: SharedExtension = {id, name, source: 'local', storageUrl: uploaded.url};
    const ok = await withDb((activeOrgId) =>
      db.extensions.upsert(activeOrgId, extension,
          uploaded.inline ? null : `shared-extensions/${id}.zip`));
    if (!ok) {
      return false;
    }
    patch.extensions((list) => [...list, extension]);
    toast.setMessage(uploaded.inline ?
      `${name} shared inline. Check the ${db.STORAGE_BUCKET} storage bucket for large extensions.` :
      `${name} shared with your team`);
    return true;
  }

  // Web Store extensions need no upload at all -- every team member
  // downloads/unpacks the same published CRX directly from Google's own CDN
  // the first time they launch a profile that uses it.
  async function addExtensionFromWebStore(webstoreId: string, displayName: string): Promise<boolean> {
    if (state.shared_extensions.some((extension) => extension.webstoreId === webstoreId)) {
      toast.setMessage('That extension is already shared');
      return false;
    }
    const extension: SharedExtension = {
      id: webstoreId,
      name: displayName.trim() || webstoreId,
      source: 'webstore',
      webstoreId,
    };
    if (!await withDb((activeOrgId) => db.extensions.upsert(activeOrgId, extension))) {
      return false;
    }
    patch.extensions((list) => [...list, extension]);
    toast.setMessage('Extension shared with your team');
    return true;
  }

  async function removeExtension(id: string): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.extensions.remove(activeOrgId, id))) {
      return false;
    }
    patch.extensions((list) => list.filter((extension) => extension.id !== id));
    return true;
  }

  // The shared-extension counterpart of setBuiltInExtensionEnabled below.
  // Written through the same upsert an edit uses rather than a narrow UPDATE:
  // the row's other columns are already in hand, and upsert is the one path
  // that knows (org_id, id) is the composite key.
  async function setExtensionEnabled(id: string, enabled: boolean): Promise<boolean> {
    const current = state.shared_extensions.find((extension) => extension.id === id);
    if (!current) {
      return false;
    }
    const next: SharedExtension = {...current, enabled};
    if (!await withDb((activeOrgId) => db.extensions.upsert(activeOrgId, next))) {
      return false;
    }
    patch.extensions((list) =>
      list.map((extension) => (extension.id === id ? next : extension)));
    return true;
  }

  // These toggles live on the organization, not on the individual user: flipping
  // one changes what every colleague's profiles launch with. Any member may do
  // it -- organizations_update is is_org_member -- which is why the Extensions
  // tab states the blast radius rather than disabling the switches.
  async function setBuiltInExtensionEnabled(
      key: keyof BuiltInExtensionToggles, enabled: boolean): Promise<boolean> {
    const next = {...state.built_in_extensions, [key]: enabled};
    if (!await withDb((activeOrgId) => db.orgs.updateBuiltInExtensions(activeOrgId, next))) {
      return false;
    }
    setState((current) => ({...current, built_in_extensions: next}));
    return true;
  }

  return {
    createFolder,
    saveFolder,
    removeFolder,
    createStatus,
    saveBookmark,
    importBookmarks,
    removeBookmark,
    addExtensionFromFolder,
    addExtensionFromWebStore,
    removeExtension,
    setExtensionEnabled,
    setBuiltInExtensionEnabled,
  };
}
