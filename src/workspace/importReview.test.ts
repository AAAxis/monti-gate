import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {parseCsv} from '../lib/csv';
import {parseProxyLink} from '../lib/proxies';
import {planCsvImport, previewCsvImport} from './csvImport';
import {
  applyFolderMapping,
  distributeProxies,
  importableCount,
  missingCredentials,
  planCredentialFix,
  proxyBadge,
  proxyCheckTarget,
  proxyTextFromFields,
  proxyTextWithCredentials,
  reviewRows,
  reviseReviewRow,
  rowsToImport,
  savedCredentialsFor,
  setDuplicateAction,
} from './importReview';
import type {ImportLibrary} from './csvImport';
import type {ReviewRow} from './importReview';
import type {MontiProfile, MontiProxy} from '../types';

const empty: ImportLibrary = {profiles: [], proxies: [], folders: []};

function library(patch: Partial<ImportLibrary>): ImportLibrary {
  return {...empty, ...patch};
}

function proxy(patch: Partial<MontiProxy> & Pick<MontiProxy, 'id' | 'host' | 'port'>): MontiProxy {
  return {name: `${patch.host}:${patch.port}`, type: 'socks5', ...patch};
}

function profile(patch: Partial<MontiProfile> & Pick<MontiProfile, 'id' | 'name'>): MontiProfile {
  return patch;
}

function review(csv: string, lib: ImportLibrary = empty) {
  return reviewRows(previewCsvImport(parseCsv(csv), lib).rows, lib);
}

function one(csv: string, lib: ImportLibrary = empty) {
  return review(csv, lib)[0];
}

// The file the user actually hit this with: an EasyDeck export, whose proxies
// carry no credentials at all.
const legacyCsv = readFileSync(
    join(__dirname, '__fixtures__', 'legacy-profiles-export.csv'), 'utf8');

describe('credential-less proxies', () => {
  const bare = 'name,proxy_name\nShop,socks5://198.51.100.10:1080\n';

  it('reuses a saved proxy that has credentials for the same host and port', () => {
    const saved = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      username: 'shop-eu', password: 's3cret'});
    const reviewed = one(bare, library({proxies: [saved]}));

    expect(reviewed.row.matchedProxyId).toBe('p1');
    expect(reviewed.borrowedProxyId).toBe('p1');
    expect(proxyBadge(reviewed, library({proxies: [saved]}))).toBe('saved-credentials');
  });

  it('checks the saved credentials, not the credential-less text from the file', () => {
    const saved = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      username: 'shop-eu', password: 's3cret'});
    const lib = library({proxies: [saved]});

    expect(proxyCheckTarget(one(bare, lib), lib)).toMatchObject({
      id: 'p1', host: '198.51.100.10', port: 1080, username: 'shop-eu', password: 's3cret',
    });
  });

  it('imports no second copy of a proxy it borrowed credentials from', () => {
    const saved = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      username: 'shop-eu', password: 's3cret'});
    const lib = library({proxies: [saved]});
    const plan = planCsvImport(rowsToImport(review(bare, lib)), {kind: 'unfiled'}, lib);

    expect(plan.result.proxiesCreated).toBe(0);
    expect(plan.result.proxiesReused).toBe(1);
    expect(plan.touchedProfiles[0].profile.proxy_id).toBe('p1');
  });

  // The password in the file is a statement; the absence of one is not.
  it('does not overwrite the saved password with an empty one', () => {
    const saved = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      username: 'shop-eu', password: 's3cret'});
    const lib = library({proxies: [saved]});
    const plan = planCsvImport(rowsToImport(review(bare, lib)), {kind: 'unfiled'}, lib);

    expect(plan.result.proxiesUpdated).toBe(0);
    expect(plan.proxies.find((item) => item.id === 'p1')?.password).toBe('s3cret');
  });

  // A username in the file is a different account, not the same one missing.
  it('leaves a line that carries its own credentials alone', () => {
    const saved = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      username: 'shop-eu', password: 's3cret'});
    const reviewed = one(
        'name,proxy_name\nShop,socks5://198.51.100.10:1080:other-user:other-pass\n',
        library({proxies: [saved]}));

    expect(reviewed.borrowedProxyId).toBeNull();
    expect(savedCredentialsFor(reviewed.row, library({proxies: [saved]}))).toBeNull();
  });

  it('flags a credential-less proxy that matches nothing saved', () => {
    const reviewed = one(bare);
    expect(missingCredentials(reviewed.row, empty)).toBe(true);
    expect(proxyBadge(reviewed, empty)).toBe('no-credentials');
    // A warning, not a refusal.
    expect(reviewed.row.blocked).toBe(false);
  });

  it('flags every proxy in the real export as credential-less', () => {
    const reviewed = review(legacyCsv);
    expect(reviewed).toHaveLength(10);
    expect(reviewed.every((item) => proxyBadge(item, empty) === 'no-credentials')).toBe(true);
    expect(reviewed.some((item) => item.row.blocked)).toBe(false);
  });

  it('picks up saved credentials again after the host is corrected', () => {
    const saved = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      username: 'shop-eu', password: 's3cret'});
    const lib = library({proxies: [saved]});
    const typo = one('name,proxy_name\nShop,socks5://198.51.100.99:1080\n', lib);
    expect(typo.borrowedProxyId).toBeNull();

    const fixed = reviseReviewRow(typo, {proxyText: 'socks5://198.51.100.10:1080'}, lib);
    expect(fixed.borrowedProxyId).toBe('p1');
    expect(proxyBadge(fixed, lib)).toBe('saved-credentials');
  });

  it('lets a hand-picked proxy override one whose credentials were borrowed', () => {
    const saved = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      username: 'shop-eu', password: 's3cret'});
    // Given its own login, so this test is about the override and not about the
    // credential warning -- which the block below covers on its own.
    const other = proxy({id: 'p2', host: '203.0.113.7', port: 8080,
      username: 'other-user', password: 'other-pass'});
    const lib = library({proxies: [saved, other]});

    const picked = reviseReviewRow(one(bare, lib), {proxyId: 'p2'}, lib);
    expect(picked.row.matchedProxyId).toBe('p2');
    expect(picked.borrowedProxyId).toBeNull();
    expect(proxyBadge(picked, lib)).toBe('reused');
  });
});

// Re-importing the same credential-less file is what the user actually did after
// the first import failed: delete the profiles, import again. The proxies the
// first import created are still there, still without credentials, and the row
// matches them -- so it used to come back badged "Reused", which reads as
// reassuring while the launch was still going to be blocked.
describe('a matched proxy that is itself credential-less', () => {
  const bare = 'name,proxy_name\nShop,socks5://198.51.100.10:1080\n';

  it('is flagged rather than reported as reused', () => {
    const stored = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      check_error: 'Proxy needs a username and password (407 Proxy Authentication Required)'});
    const lib = library({proxies: [stored]});
    const reviewed = one(bare, lib);

    expect(reviewed.row.matchedProxyId).toBe('p1');
    expect(missingCredentials(reviewed.row, lib)).toBe(true);
    expect(proxyBadge(reviewed, lib)).toBe('no-credentials');
  });

  it('is still flagged when it has never been checked', () => {
    const lib = library({proxies: [proxy({id: 'p1', host: '198.51.100.10', port: 1080})]});
    expect(proxyBadge(one(bare, lib), lib)).toBe('no-credentials');
  });

  // The false positive worth avoiding: plenty of proxies need no login at all,
  // and one that has passed a check has proved it is one of them.
  it('is reused, not flagged, once it has passed a check without credentials', () => {
    const stored = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      checked_at: '2026-08-04T12:00:00.000Z', country_code: 'US', ping_ms: 685});
    const lib = library({proxies: [stored]});

    expect(missingCredentials(one(bare, lib).row, lib)).toBe(false);
    expect(proxyBadge(one(bare, lib), lib)).toBe('reused');
  });
});

describe('applying one login to a whole import', () => {
  it('rewrites unsaved rows and updates saved proxies, and never both', () => {
    // Line 2 matches a saved credential-less proxy; line 3 is new to the library.
    const stored = proxy({id: 'p1', host: '198.51.100.10', port: 1080,
      check_error: 'Proxy needs a username and password'});
    const lib = library({proxies: [stored]});
    const reviewed = review(
        'name,proxy_name\n' +
        'Shop,socks5://198.51.100.10:1080\n' +
        'Other,socks5://203.0.113.7:8080\n', lib);

    const fix = planCredentialFix(reviewed, lib);
    expect(fix.storedProxyIds).toEqual(['p1']);
    expect(fix.lines).toEqual([reviewed[1].row.line]);
    expect(fix.proxyCount).toBe(2);
  });

  // The count the banner shows is proxies, not rows. Two profiles behind one
  // credential-less endpoint are two rows and one proxy, and the import dedupes
  // them into one -- so "2 proxies have no login" would be wrong.
  it('counts one proxy when two unsaved rows share an endpoint', () => {
    const reviewed = review(
        'name,proxy_name\n' +
        'A,socks5://198.51.100.10:1080\n' +
        'B,socks5://198.51.100.10:1080\n');
    const fix = planCredentialFix(reviewed, empty);

    expect(fix.lines).toHaveLength(2);
    expect(fix.proxyCount).toBe(1);
  });

  it('lists a shared proxy once, however many rows use it', () => {
    const stored = proxy({id: 'p1', host: '198.51.100.10', port: 1080});
    const lib = library({proxies: [stored]});
    const reviewed = review(
        'name,proxy_name\n' +
        'A,socks5://198.51.100.10:1080\n' +
        'B,socks5://198.51.100.10:1080\n', lib);

    const fix = planCredentialFix(reviewed, lib);
    expect(fix.storedProxyIds).toEqual(['p1']);
    expect(fix.proxyCount).toBe(1);
  });

  it('has nothing to do once every proxy carries a login', () => {
    const reviewed = review('name,proxy_name\nA,socks5://198.51.100.10:1080:u:p\n');
    expect(planCredentialFix(reviewed, empty))
        .toEqual({lines: [], storedProxyIds: [], proxyCount: 0});
  });

  // The whole point: the rewritten text has to parse back to the same proxy plus
  // the login, including the punctuation providers put in passwords.
  it('round-trips a password full of @ and : back through the parser', () => {
    const reviewed = one('name,proxy_name\nA,socks5://198.51.100.10:1080\n');
    const text = proxyTextWithCredentials(reviewed.row, 'user@corp', 'p@ss:word');
    expect(text).toBeTruthy();

    expect(parseProxyLink(text as string)).toEqual({
      type: 'socks5',
      host: '198.51.100.10',
      port: 1080,
      username: 'user@corp',
      password: 'p@ss:word',
    });
  });

  it('applies to the real export the user hit this with', () => {
    const reviewed = review(legacyCsv);
    const fix = planCredentialFix(reviewed, empty);
    expect(fix.lines).toHaveLength(10);
    expect(fix.storedProxyIds).toEqual([]);
    // Ten rows, ten distinct endpoints -- so here rows and proxies do agree.
    expect(fix.proxyCount).toBe(10);

    // Every row re-badges as an ordinary new proxy once the login is applied.
    const fixed = reviewed.map((item) => reviseReviewRow(
        item, {proxyText: proxyTextWithCredentials(item.row, 'u', 'p') as string}, empty));
    expect(fixed.every((item) => proxyBadge(item, empty) === 'new')).toBe(true);
  });
});

describe('duplicate names', () => {
  const csv = 'name,proxy_mode\nLisa Martinez,direct\n';
  const existing = library({profiles: [profile({id: 'kept-id', name: 'Lisa Martinez'})]});

  it('defaults to updating the profile that already has the name', () => {
    const reviewed = one(csv, existing);
    expect(reviewed.nameMatch).toMatchObject({id: 'kept-id'});
    expect(reviewed.duplicateAction).toBe('update');
    expect(reviewed.row.updatesProfileId).toBe('kept-id');
  });

  // The whole point of updating rather than duplicating: the id is the on-disk
  // browser directory, so reusing it keeps the logged-in session.
  it('writes back to the existing id when updating', () => {
    const plan = planCsvImport(rowsToImport(review(csv, existing)), {kind: 'unfiled'}, existing);
    expect(plan.result.created).toBe(0);
    expect(plan.result.updated).toBe(1);
    expect(plan.touchedProfiles[0].profile.id).toBe('kept-id');
    expect(plan.touchedProfiles[0].exists).toBe(true);
  });

  it('mints a new profile when told to import as new', () => {
    const reviewed = setDuplicateAction(one(csv, existing), 'new', existing);
    expect(reviewed.row.updatesProfileId).toBeNull();

    const plan = planCsvImport([reviewed.row], {kind: 'unfiled'}, existing);
    expect(plan.result.created).toBe(1);
    expect(plan.touchedProfiles[0].profile.id).not.toBe('kept-id');
  });

  it('leaves a skipped row out of the commit entirely', () => {
    const reviewed = [setDuplicateAction(one(csv, existing), 'skip', existing)];
    expect(rowsToImport(reviewed)).toEqual([]);

    const plan = planCsvImport(rowsToImport(reviewed), {kind: 'unfiled'}, existing);
    expect(plan.result.created).toBe(0);
    expect(plan.result.updated).toBe(0);
    // Not reported as skipped: nothing about it went wrong.
    expect(plan.result.skipped).toEqual([]);
  });

  it('ignores a name match when the file gave an explicit id', () => {
    const reviewed = one('name,profile_id,proxy_mode\nLisa Martinez,other-id,direct\n', existing);
    expect(reviewed.nameMatch).toBeNull();
    expect(reviewed.duplicateAction).toBe('new');
  });

  it('does not match a profile that is in the trash', () => {
    const trashed = library({
      profiles: [profile({id: 'gone', name: 'Lisa Martinez', deleted_at: '2026-01-01T00:00:00Z'})],
    });
    expect(one(csv, trashed).nameMatch).toBeNull();
  });

  it('clears the collision when the row is renamed', () => {
    const asNew = setDuplicateAction(one(csv, existing), 'new', existing);
    const renamed = reviseReviewRow(asNew, {name: 'Lisa Martinez 2'}, existing);
    expect(renamed.nameMatch).toBeNull();
    expect(renamed.duplicateAction).toBe('new');
  });

  it('counts a skipped row out of the importable total', () => {
    const reviewed = review(csv, existing);
    expect(importableCount(reviewed)).toBe(1);
    expect(importableCount([setDuplicateAction(reviewed[0], 'skip', existing)])).toBe(0);
  });
});

describe('filling empty proxies from the library', () => {
  const csv = 'name,proxy_name\nA,\nB,\nC,\n';

  it('hands each row a different proxy', () => {
    const lib = library({
      proxies: [proxy({id: 'p1', host: '1.1.1.1', port: 1}),
        proxy({id: 'p2', host: '2.2.2.2', port: 2}),
        proxy({id: 'p3', host: '3.3.3.3', port: 3})],
    });
    const assignments = distributeProxies(review(csv, lib), lib);
    expect([...assignments.values()]).toEqual(['p1', 'p2', 'p3']);
    expect(new Set(assignments.values()).size).toBe(3);
  });

  it('prefers proxies no existing profile is using', () => {
    const lib = library({
      proxies: [proxy({id: 'busy', host: '1.1.1.1', port: 1}),
        proxy({id: 'free', host: '2.2.2.2', port: 2})],
      profiles: [profile({id: 'x', name: 'X', proxy_id: 'busy'})],
    });
    const assignments = distributeProxies(review('name,proxy_name\nA,\n', lib), lib);
    expect([...assignments.values()]).toEqual(['free']);
  });

  it('stops when it runs out rather than doubling one up', () => {
    const lib = library({proxies: [proxy({id: 'p1', host: '1.1.1.1', port: 1})]});
    expect(distributeProxies(review(csv, lib), lib).size).toBe(1);
  });

  it('skips rows that already have a proxy, and rows that want none', () => {
    const lib = library({proxies: [proxy({id: 'p1', host: '1.1.1.1', port: 1})]});
    const reviewed = review(
        'name,proxy_name,proxy_mode\nA,socks5://9.9.9.9:9,\nB,,direct\n', lib);
    expect(distributeProxies(reviewed, lib).size).toBe(0);
  });

  it('does not hand out a proxy another row already matched', () => {
    const shared = proxy({id: 'p1', host: '1.1.1.1', port: 1});
    const lib = library({proxies: [shared]});
    const reviewed = review('name,proxy_name\nA,socks5://1.1.1.1:1\nB,\n', lib);
    expect(distributeProxies(reviewed, lib).size).toBe(0);
  });
});

describe('proxy badges', () => {
  it('tells a deliberate direct row from one whose proxy went missing', () => {
    expect(proxyBadge(one('name,proxy_mode\nA,direct\n'), empty)).toBe('direct');
    expect(proxyBadge(one('name,proxy_name\nA,\n'), empty)).toBe('missing');
    expect(proxyBadge(one('name,proxy_name\nA,not a proxy\n'), empty)).toBe('unreadable');
  });

  it('calls a fully-specified new proxy new', () => {
    expect(proxyBadge(one('name,proxy_name\nA,socks5://1.1.1.1:1:u:p\n'), empty)).toBe('new');
  });
});

describe('folder remapping', () => {
  const csv = 'name,folder,proxy_mode\nA,5 July,direct\nB,5 July,direct\nC,8 July,direct\n';

  it('renames a CSV folder value to whatever the destination step chose', () => {
    const mapped = applyFolderMapping(review(csv), new Map([['5 july', 'July batch']]), empty);
    expect(mapped.map((item) => item.row.folder)).toEqual(['July batch', 'July batch', '8 July']);
  });

  it('creates the renamed folder and never an "Imported" one', () => {
    const mapped = applyFolderMapping(review(csv), new Map([['5 july', 'July batch']]), empty);
    const plan = planCsvImport(rowsToImport(mapped), {kind: 'per-row'}, empty);

    expect(plan.newFolders.map((folder) => folder.name).sort()).toEqual(['8 July', 'July batch']);
    expect(plan.newFolders.some((folder) => folder.name.startsWith('Imported'))).toBe(false);
  });

  it('drops a value mapped to nothing', () => {
    const mapped = applyFolderMapping(review(csv), new Map([['5 july', '']]), empty);
    const plan = planCsvImport(rowsToImport(mapped), {kind: 'per-row'}, empty);

    expect(plan.newFolders.map((folder) => folder.name)).toEqual(['8 July']);
    expect(plan.touchedProfiles[0].profile.folder_id).toBeNull();
  });

  it('reuses an existing folder rather than making a second of the same name', () => {
    const lib = library({
      folders: [{id: 'f1', name: 'July batch', kind: 'profile'}],
    });
    const mapped = applyFolderMapping(review(csv, lib), new Map([['5 july', 'July batch']]), lib);
    const plan = planCsvImport(rowsToImport(mapped), {kind: 'per-row'}, lib);

    expect(plan.newFolders.map((folder) => folder.name)).toEqual(['8 July']);
    expect(plan.touchedProfiles[0].profile.folder_id).toBe('f1');
  });

  it('leaves the file alone when nothing was remapped', () => {
    const reviewed: ReviewRow[] = review(csv);
    expect(applyFolderMapping(reviewed, new Map(), empty)).toEqual(reviewed);
  });
});

describe('the real export, end to end', () => {
  it('imports ten profiles into the two folders the file names', () => {
    const reviewed = review(legacyCsv);
    expect(importableCount(reviewed)).toBe(10);

    const plan = planCsvImport(rowsToImport(reviewed), {kind: 'per-row'}, empty);
    expect(plan.result.created).toBe(10);
    expect(plan.newFolders.map((folder) => folder.name).sort()).toEqual(['5 July', '8 July']);
  });

  it('re-importing it updates rather than duplicating', () => {
    const first = planCsvImport(rowsToImport(review(legacyCsv)), {kind: 'per-row'}, empty);
    const after = library({
      profiles: first.profiles, proxies: first.proxies, folders: first.folders,
    });

    const second = planCsvImport(rowsToImport(review(legacyCsv, after)), {kind: 'per-row'}, after);
    expect(second.result.created).toBe(0);
    expect(second.result.updated).toBe(10);
    expect(second.profiles).toHaveLength(10);
    expect(second.newFolders).toEqual([]);
  });
});

// The per-row proxy popover: four fields in, one connection string out.
describe('proxyTextFromFields', () => {
  it('composes an address and a login', () => {
    expect(proxyTextFromFields('198.51.100.10:1080', 'socks5', 'user', 'pass'))
        .toBe('socks5://user:pass@198.51.100.10:1080');
  });

  it('leaves out the userinfo when there is no login', () => {
    expect(proxyTextFromFields('198.51.100.10:1080', 'socks5', '', ''))
        .toBe('socks5://198.51.100.10:1080');
  });

  // The regression the type selector exists to prevent: a bare host:port parses
  // as socks5, so five of the ten rows in the legacy export would silently
  // change protocol if the selector did not carry the scheme.
  it('keeps http as http when only the selector says so', () => {
    expect(proxyTextFromFields('77.47.243.119:48549', 'http', '', ''))
        .toBe('http://77.47.243.119:48549');
  });

  it('lets a scheme typed into the address outrank the selector', () => {
    expect(proxyTextFromFields('http://198.51.100.10:1080', 'socks5', '', ''))
        .toBe('http://198.51.100.10:1080');
  });

  // Enter commits without blurring, so a whole vendor line can still be sitting
  // in the address when this runs. Dropping the login it carried would be worse
  // than useless -- it is the one thing the row was missing.
  it('keeps a login left in the address', () => {
    expect(proxyTextFromFields('1.2.3.4:1080:user:pass', 'socks5', '', ''))
        .toBe('socks5://user:pass@1.2.3.4:1080');
  });

  it('lets the fields override a login left in the address', () => {
    expect(proxyTextFromFields('1.2.3.4:1080:old:oldpass', 'socks5', 'new', 'newpass'))
        .toBe('socks5://new:newpass@1.2.3.4:1080');
  });

  it('round-trips a password full of URL syntax', () => {
    const text = proxyTextFromFields('1.2.3.4:1080', 'socks5', 'user@corp', 'p@ss:word/1');
    expect(parseProxyLink(text)).toEqual({
      type: 'socks5', host: '1.2.3.4', port: 1080,
      username: 'user@corp', password: 'p@ss:word/1',
    });
  });

  // Passed through rather than repaired, so resolveRow still reports it.
  it('hands an unreadable address back untouched', () => {
    expect(proxyTextFromFields('  nonsense  ', 'socks5', '', '')).toBe('nonsense');
  });
});

describe('the popover over the legacy export', () => {
  const rows = review(legacyCsv);

  it('seeds each row with the type the file named', () => {
    const types = rows.map((r) => r.row.proxy?.type);
    expect(types).toEqual(['socks5', 'socks5', 'socks5', 'socks5', 'socks5',
      'http', 'http', 'http', 'http', 'http']);
  });

  it('clears the no-credentials badge once a login is applied', () => {
    const target = rows.find((r) => r.row.proxy?.host === '206.251.200.171') as ReviewRow;
    expect(proxyBadge(target, empty)).toBe('no-credentials');
    const proxyText = proxyTextFromFields(
        '206.251.200.171:47450', 'http', 'Z44tcAIxnefUmXP', 'f44XusFmtomKAQs');
    const next = reviseReviewRow(target, {proxyText}, empty);
    expect(next.row.proxy).toEqual({
      type: 'http', host: '206.251.200.171', port: 47450,
      username: 'Z44tcAIxnefUmXP', password: 'f44XusFmtomKAQs',
    });
    expect(proxyBadge(next, empty)).toBe('new');
  });

  // Clearing the credential fields is how the user says "I have no login for
  // this" -- and a saved one for the same endpoint should come back rather than
  // the row importing a second, unusable copy.
  it('re-borrows a saved login when the credential fields are emptied', () => {
    const saved = proxy({id: 'p1', host: '204.252.87.159', port: 47403,
      username: 'u', password: 'p'});
    const lib = library({proxies: [saved]});
    const seeded = review(legacyCsv, lib);
    expect(proxyBadge(seeded[0], lib)).toBe('saved-credentials');
    const cleared = reviseReviewRow(seeded[0],
        {proxyText: proxyTextFromFields('204.252.87.159:47403', 'socks5', '', '')}, lib);
    expect(proxyBadge(cleared, lib)).toBe('saved-credentials');
    expect(cleared.row.proxy?.password).toBe('p');
  });
});
