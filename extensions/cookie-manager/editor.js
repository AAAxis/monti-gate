// Full-page live cookie editor. Extension pages can call chrome.cookies
// directly -- no background round trip needed, unlike the popup which is
// too small to host this UI.
const $ = (selector) => document.querySelector(selector);
const format = ScoutCookieFormat;

let all = [];          // chrome.cookies.Cookie[]
let filtered = [];
let page = 0;
let pageSize = 50;
const selected = new Set();  // keys of selected rows
let editing = null;          // the cookie being edited, or null for Add
let lastFocused = null;      // element to refocus once the dialog closes
let profileMetaName = '';    // for the save-as dialog's default name

// chrome.cookies.Cookie -> the CookieEntry shape cookie-format understands.
function toEntry(cookie) {
  return format.normalizeCookie({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expirationDate,
  });
}

// (domain, path, name) is Chrome's real identity for a cookie; storeId is
// appended so cookies from different partitions/containers never collide.
function keyOf(cookie) {
  return `${cookie.storeId || ''}|${cookie.domain}|${cookie.path}|${cookie.name}`;
}

function cookieUrl(cookie) {
  const domain = String(cookie.domain || '').replace(/^\./, '');
  return `${cookie.secure ? 'https' : 'http'}://${domain}${cookie.path || '/'}`;
}

function setStatus(text, isError) {
  $('#status').textContent = text || '';
  $('#status').className = isError ? 'status error' : 'status';
}

async function reload() {
  all = await chrome.cookies.getAll({});
  const domains = format.cookieDomains(all);
  const current = $('#domain-filter').value;
  const select = $('#domain-filter');
  select.replaceChildren();
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = 'All domains';
  select.append(allOption, ...domains.map((domain) => {
    const option = document.createElement('option');
    option.textContent = domain;
    return option;
  }));
  if (domains.includes(current)) select.value = current;
  render();
}

// Builds flag chips as real nodes rather than an HTML string -- sameSite is
// a closed enum from the chrome.cookies API so this is not attacker-reachable
// today, but a string-concatenation helper is exactly the kind of code that
// grows an unsafe interpolation later without anyone noticing.
function flagNode(text, className) {
  const span = document.createElement('span');
  span.className = `flag ${className}`;
  span.textContent = text;
  return span;
}

function appendFlags(cell, cookie) {
  if (cookie.secure) cell.append(flagNode('Secure', 'flag-secure'));
  if (cookie.httpOnly) cell.append(flagNode('HttpOnly', 'flag-httponly'));
  const sameSite = cookie.sameSite || 'lax';
  // "None" is the flag worth calling out -- it is the one third-party
  // tracking/embedding depends on and the one Chrome is tightening around.
  cell.append(sameSite === 'no_restriction' ?
    flagNode('None', 'flag-samesite-none') : flagNode(sameSite, 'flag-samesite'));
}

function render() {
  const query = $('#search').value.trim().toLowerCase();
  const domain = $('#domain-filter').value;
  filtered = all.filter((cookie) => {
    if (domain && cookie.domain !== domain) return false;
    if (!query) return true;
    return cookie.name.toLowerCase().includes(query) ||
      cookie.value.toLowerCase().includes(query) ||
      cookie.domain.toLowerCase().includes(query);
  });
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  page = Math.min(page, pages - 1);
  const slice = filtered.slice(page * pageSize, (page + 1) * pageSize);

  $('#summary').textContent = `${all.length} cookies · ${format.cookieDomains(all).length} domains`;
  $('#empty').hidden = filtered.length > 0;
  $('#page-info').textContent =
      `${filtered.length ? page * pageSize + 1 : 0}–${page * pageSize + slice.length} of ${filtered.length}`;
  $('#prev').disabled = page === 0;
  $('#next').disabled = page >= pages - 1;

  const rows = $('#rows');
  rows.innerHTML = '';
  for (const cookie of slice) {
    const key = keyOf(cookie);
    const entry = toEntry(cookie);
    const row = document.createElement('tr');
    if (entry && format.cookieExpiryLabel(entry) === 'Expired') row.className = 'expired';
    // A cookie's name/value/domain/path are set by whatever website wrote
    // them -- never trusted as markup. The row skeleton is static HTML with
    // no interpolation; every per-cookie value is assigned via textContent
    // or setAttribute below, neither of which parses its input as HTML.
    row.innerHTML = `
      <td class="check"><input type="checkbox"></td>
      <td class="name"></td>
      <td class="value"></td>
      <td class="domain"></td>
      <td class="path"></td>
      <td class="expiry"></td>
      <td class="flags-cell"></td>
      <td class="actions">
        <span class="row-actions">
          <button class="edit" type="button" title="Edit">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          <button class="remove" type="button" title="Delete">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M19 6l-.867 12.142A2 2 0 0 1 16.138 20H7.862a2 2 0 0 1-1.995-1.858L5 6"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              <path d="M10 11v6M14 11v6" stroke="currentColor" stroke-width="2"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </span>
      </td>`;
    const checkbox = row.querySelector('input[type="checkbox"]');
    checkbox.dataset.key = key;
    checkbox.checked = selected.has(key);
    checkbox.setAttribute('aria-label', `Select ${cookie.name}`);
    const nameCell = row.querySelector('.name');
    const valueCell = row.querySelector('.value');
    const domainCell = row.querySelector('.domain');
    const pathCell = row.querySelector('.path');
    nameCell.textContent = cookie.name;
    nameCell.title = cookie.name;
    valueCell.textContent = cookie.value;
    valueCell.title = cookie.value;
    domainCell.textContent = cookie.domain;
    domainCell.title = cookie.domain;
    pathCell.textContent = cookie.path;
    pathCell.title = cookie.path;
    row.querySelector('.expiry').textContent = entry ? format.cookieExpiryLabel(entry) : 'Session';
    appendFlags(row.querySelector('.flags-cell'), cookie);
    const editButton = row.querySelector('.edit');
    const removeButton = row.querySelector('.remove');
    editButton.setAttribute('aria-label', `Edit ${cookie.name}`);
    removeButton.setAttribute('aria-label', `Delete ${cookie.name}`);
    editButton.addEventListener('click', () => openDialog(cookie));
    removeButton.addEventListener('click', () => {
      if (confirm(`Delete cookie "${cookie.name}" (${cookie.domain})?`)) void removeCookies([cookie]);
    });
    checkbox.addEventListener('change', (event) => {
      if (event.target.checked) selected.add(key); else selected.delete(key);
      $('#delete-selected').disabled = selected.size === 0;
    });
    rows.append(row);
  }
  $('#delete-selected').disabled = selected.size === 0;
  $('#select-all').checked = slice.length > 0 && slice.every((cookie) => selected.has(keyOf(cookie)));
}

// Every remove is individually try/caught -- one cookie Chrome won't let go
// of (odd domain, partitioned store) must not stop the rest, and the
// failure count is never allowed to just vanish into the console.
async function removeCookies(cookies) {
  let removed = 0;
  let failed = 0;
  for (const cookie of cookies) {
    try {
      const result = await chrome.cookies.remove({
        url: cookieUrl(cookie), name: cookie.name, storeId: cookie.storeId,
      });
      if (result) removed++; else failed++;
    } catch (error) {
      failed++;
    }
  }
  selected.clear();
  const summary = `Deleted ${removed} cookie${removed === 1 ? '' : 's'}` +
    (failed ? ` — ${failed} failed to delete` : '');
  setStatus(summary, failed > 0);
  await reload();
}

// ---- edit / add dialog -----------------------------------------------------
function openDialog(cookie) {
  editing = cookie || null;
  lastFocused = document.activeElement;
  const form = $('#edit-form');
  $('#edit-title').textContent = cookie ? 'Edit cookie' : 'Add cookie';
  form.elements.name.value = cookie ? cookie.name : '';
  form.elements.value.value = cookie ? cookie.value : '';
  form.elements.domain.value = cookie ? cookie.domain : '';
  form.elements.path.value = cookie ? cookie.path : '/';
  form.elements.secure.checked = cookie ? cookie.secure : false;
  form.elements.httpOnly.checked = cookie ? cookie.httpOnly : false;
  form.elements.sameSite.value = cookie ? (cookie.sameSite || 'lax') : 'lax';
  form.elements.expires.value = cookie && cookie.expirationDate ?
    new Date(cookie.expirationDate * 1000).toISOString().slice(0, 16) : '';
  $('#edit-dialog').showModal();
  form.elements.name.focus();
  form.elements.name.select();
}

$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close('cancel'));

$('#edit-dialog').addEventListener('close', async () => {
  try {
    if ($('#edit-dialog').returnValue !== 'save') return;
    const form = $('#edit-form');
    const next = {
      name: form.elements.name.value.trim(),
      value: form.elements.value.value,
      domain: form.elements.domain.value.trim(),
      path: form.elements.path.value.trim() || '/',
      secure: form.elements.secure.checked,
      httpOnly: form.elements.httpOnly.checked,
      sameSite: form.elements.sameSite.value,
    };
    if (!next.name || !next.domain) {
      setStatus('A cookie needs at least a name and a domain', true);
      return;
    }
    if (form.elements.expires.value) {
      next.expirationDate = Math.floor(new Date(form.elements.expires.value).getTime() / 1000);
    }
    try {
      let staleRemovalFailed = false;
      // (name, domain, path) is the identity: Chrome has no rename, so
      // editing any of them means the old cookie must go first or it
      // survives alongside the new one as a duplicate.
      if (editing && (editing.name !== next.name || editing.domain !== next.domain ||
          editing.path !== next.path)) {
        try {
          const removedOk = await chrome.cookies.remove({
            url: cookieUrl(editing), name: editing.name, storeId: editing.storeId,
          });
          staleRemovalFailed = !removedOk;
        } catch (error) {
          staleRemovalFailed = true;
        }
      }
      const result = await chrome.cookies.set({
        url: cookieUrl(next), name: next.name, value: next.value, domain: next.domain,
        path: next.path, secure: next.secure, httpOnly: next.httpOnly,
        sameSite: next.sameSite,
        ...(next.expirationDate ? {expirationDate: next.expirationDate} : {}),
      });
      if (!result) {
        throw new Error('Chrome rejected the cookie -- check Secure/SameSite=None and domain');
      }
      const suffix = staleRemovalFailed ?
        ' (could not remove the cookie under its old name/domain/path -- it may now be duplicated)' : '';
      setStatus((editing ? 'Cookie updated' : 'Cookie added') + suffix, staleRemovalFailed);
      await reload();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  } finally {
    editing = null;
    if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    lastFocused = null;
  }
});

// ---- toolbar ---------------------------------------------------------------
$('#search').addEventListener('input', () => { page = 0; render(); });
$('#domain-filter').addEventListener('change', () => { page = 0; render(); });
$('#add').addEventListener('click', () => openDialog(null));
$('#prev').addEventListener('click', () => { page--; render(); });
$('#next').addEventListener('click', () => { page++; render(); });
$('#page-size').addEventListener('change', (event) => {
  pageSize = Number(event.target.value); page = 0; render();
});
$('#select-all').addEventListener('change', (event) => {
  const slice = filtered.slice(page * pageSize, (page + 1) * pageSize);
  for (const cookie of slice) {
    if (event.target.checked) selected.add(keyOf(cookie));
    else selected.delete(keyOf(cookie));
  }
  render();
});
$('#delete-selected').addEventListener('click', () => {
  const chosen = all.filter((cookie) => selected.has(keyOf(cookie)));
  if (chosen.length && confirm(`Delete ${chosen.length} selected cookie(s)?`)) {
    void removeCookies(chosen);
  }
});

$('#export-menu-button').addEventListener('click', () => {
  const willOpen = $('#export-menu').hidden;
  $('#export-menu').hidden = !willOpen;
  $('#export-menu-button').setAttribute('aria-expanded', String(willOpen));
});
$('#export-menu').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-format]');
  if (!button) return;
  $('#export-menu').hidden = true;
  $('#export-menu-button').setAttribute('aria-expanded', 'false');
  // Selection wins over the filter, and the filter wins over "everything" --
  // exporting the rows in front of the user, not a set they can't see.
  const chosen = selected.size ?
    all.filter((cookie) => selected.has(keyOf(cookie))) : filtered;
  const entries = chosen.map(toEntry).filter(Boolean);
  if (!entries.length) { setStatus('Nothing to export'); return; }
  if (button.dataset.format === 'clipboard') {
    try {
      await navigator.clipboard.writeText(format.toCookieJson(entries));
      setStatus(`Copied ${entries.length} cookies to the clipboard`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
    return;
  }
  const isJson = button.dataset.format === 'json';
  const text = isJson ? format.toCookieJson(entries) : format.toNetscapeCookies(entries);
  const blob = new Blob([text], {type: isJson ? 'application/json' : 'text/plain'});
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `scout-cookies.${isJson ? 'json' : 'txt'}`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`Exported ${entries.length} cookies`);
});

$('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  try {
    const cookies = format.parseCookieContent(await file.text());
    if (!cookies.length) throw new Error('No cookies found in that file');
    let imported = 0;
    for (const cookie of cookies) {
      try {
        const result = await chrome.cookies.set({
          url: cookie.url, name: cookie.name, value: cookie.value,
          ...(cookie.domain ? {domain: cookie.domain} : {}),
          path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
          ...(cookie.expirationDate ? {expirationDate: cookie.expirationDate} : {}),
        });
        if (result) imported++;
      } catch { /* one bad row must not sink the file -- counted below instead */ }
    }
    const skipped = cookies.length - imported;
    setStatus(`Imported ${imported} of ${cookies.length} cookies` + (skipped ? ` — ${skipped} skipped` : ''),
        skipped > 0 && imported === 0);
    await reload();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    event.target.value = '';
  }
});

$('#clear-menu-button').addEventListener('click', () => {
  const willOpen = $('#clear-menu').hidden;
  $('#clear-menu').hidden = !willOpen;
  $('#clear-menu-button').setAttribute('aria-expanded', String(willOpen));
});
$('#clear-menu').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-scope]');
  if (!button) return;
  $('#clear-menu').hidden = true;
  $('#clear-menu-button').setAttribute('aria-expanded', 'false');
  if (button.dataset.scope === 'domain') {
    const domain = $('#domain-filter').value;
    if (!domain) { setStatus('Pick a domain in the filter first', true); return; }
    const victims = all.filter((cookie) => cookie.domain === domain);
    if (prompt(`Type the domain (${domain}) to delete its ${victims.length} cookies:`) === domain) {
      await removeCookies(victims);
    }
    return;
  }
  if (prompt(`Type DELETE to remove all ${all.length} cookies in this profile:`) === 'DELETE') {
    await removeCookies(all);
  }
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('.menu-wrap')) {
    $('#export-menu').hidden = true;
    $('#export-menu-button').setAttribute('aria-expanded', 'false');
    $('#clear-menu').hidden = true;
    $('#clear-menu-button').setAttribute('aria-expanded', 'false');
  }
});

// "/" focuses search from anywhere on the page, like GitHub/Gmail -- unless
// the user is already typing somewhere, in which case a literal "/" should
// just be a literal "/". The edit dialog's own Escape-to-close is native
// <dialog> behavior and needs no code here; this only extends Escape to the
// two dropdown menus, which are plain divs with none of that for free.
document.addEventListener('keydown', (event) => {
  if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey) {
    const target = event.target;
    const typing = target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
       target.tagName === 'SELECT' || target.isContentEditable);
    if (!typing) {
      event.preventDefault();
      $('#search').focus();
    }
    return;
  }
  if (event.key === 'Escape' && (!$('#export-menu').hidden || !$('#clear-menu').hidden)) {
    $('#export-menu').hidden = true;
    $('#export-menu-button').setAttribute('aria-expanded', 'false');
    $('#clear-menu').hidden = true;
    $('#clear-menu-button').setAttribute('aria-expanded', 'false');
  }
});

// Live updates while sites write cookies -- debounced so a login storm does
// not re-render per cookie.
let reloadTimer = 0;
chrome.cookies.onChanged.addListener(() => {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { reloadTimer = 0; void reload(); }, 500);
});

// Profile chip, same source as the popup's.
fetch(chrome.runtime.getURL('profile-meta.json'))
    .then((response) => response.ok ? response.json() : null)
    .then((meta) => {
      if (meta && meta.name) {
        profileMetaName = meta.name;
        $('#profile-chip').textContent = meta.name;
        $('#profile-chip').hidden = false;
      }
    })
    .catch(() => {});

// ---- save-as: name + scope dialog -------------------------------------------
function defaultSaveAsName() {
  const date = new Date().toISOString().slice(0, 10);
  return profileMetaName ? `${profileMetaName} ${date}` : `Cookies ${date}`;
}

// Picks which of the three scopes this cookie set will be built from.
// Priority (also the default selection below): a live selection is the most
// specific thing the user could mean, then the filter they've typed/picked,
// then everything -- each one only usable when it actually has rows in it.
function scopeCookies(scope) {
  if (scope === 'selected') return all.filter((cookie) => selected.has(keyOf(cookie)));
  if (scope === 'filtered') return filtered;
  return all;
}

function openSaveAsDialog() {
  const form = $('#save-as-form');
  const counts = {selected: selected.size, filtered: filtered.length, all: all.length};
  $('#scope-selected-label').textContent = `Selected (${counts.selected})`;
  $('#scope-filtered-label').textContent = `Current filter (${counts.filtered})`;
  $('#scope-all-label').textContent = `All cookies (${counts.all})`;
  for (const scope of ['selected', 'filtered', 'all']) {
    form.querySelector(`input[name="scope"][value="${scope}"]`).disabled = counts[scope] === 0;
  }
  const defaultScope = counts.selected > 0 ? 'selected' : (counts.filtered > 0 ? 'filtered' : 'all');
  form.querySelector(`input[name="scope"][value="${defaultScope}"]`).checked = true;
  form.elements.name.value = defaultSaveAsName();
  $('#save-as-dialog').showModal();
  form.elements.name.focus();
  form.elements.name.select();
}

$('#save-as-set-button').addEventListener('click', openSaveAsDialog);
$('#save-as-cancel').addEventListener('click', () => $('#save-as-dialog').close('cancel'));

$('#save-as-dialog').addEventListener('close', async () => {
  // Same convention as #edit-dialog: only 'save' (the submit button's value)
  // proceeds. Escape's native <dialog> cancel, and the Cancel button above,
  // both leave returnValue as anything else.
  if ($('#save-as-dialog').returnValue !== 'save') return;
  const form = $('#save-as-form');
  const name = form.elements.name.value.trim();
  if (!name) {
    setStatus('Enter a name for this cookie set', true);
    return;
  }
  const scope = form.elements.scope.value;
  const cookies = scopeCookies(scope);
  if (!cookies.length) {
    // Can happen if the chosen scope emptied out between opening the dialog
    // and submitting (e.g. a live site cleared its own cookies while the
    // dialog was open) -- the disabled-radio guard above only reflects
    // counts as of open time.
    setStatus('Nothing to save in that scope', true);
    return;
  }
  setStatus('Saving to Cookies tab…');
  try {
    const result = await chrome.runtime.sendMessage({type: 'save-as-set', name, cookies});
    if (result && result.ok) {
      setStatus(`Saved ${result.saved} cookies to "${result.set}"`);
    } else {
      setStatus((result && result.error) || 'Could not save to the Cookies tab', true);
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
});

void reload();
