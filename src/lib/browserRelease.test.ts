// Whether the launcher thinks the installed browser is current.
//
// The archive is ~200 MB, so both directions of this decision are expensive:
// a false "stale" downloads it again for nothing, a false "current" strands
// someone on a build that will never be replaced. The legacy-marker case below
// is the one that ships once and cannot be re-run -- every install in the
// field today has a bare-string marker and no JSON record.
import {describe, expect, it} from 'vitest';
import {buildInstallRecord, decideBrowserAction, normalizeManifest, readInstallRecord}
// @ts-expect-error CJS module without types
  from '../../electron/browser-release.cjs';

const SHA = 'aRSCo2r/F7erpSXjjxTIN2lebcuOWiNE9XnCdARPP2YkvRVNMfqFHeJ68/sjQ7qCD/gZ6KiY9RThYEoJWQRCNQ==';

function manifest(overrides = {}) {
  return normalizeManifest({
    version: '151.0.7906.0',
    url: 'EasyDeck-Browser-mac-arm64.zip',
    sha512: SHA,
    size: 184499616,
    releaseDate: '2026-08-09T12:00:00.000Z',
    chromiumVersion: '151.0.7906.0',
    notes: 'Panel tabs.',
    ...overrides,
  });
}

describe('normalizeManifest', () => {
  it('identifies a build by its hash, not its version', () => {
    // Two builds of the same Chromium version are two different builds, and
    // for a fork that is the common case -- the fork changes far more often
    // than it rebases.
    expect(manifest().buildId).toBe(SHA);
    expect(manifest({sha512: 'other'}).buildId).toBe('other');
  });

  it('falls back to version when a manifest predates hashing', () => {
    // The mac manifest that was live for months carried no useful version and
    // the win one carried no consistent scheme; neither is guaranteed to have
    // a hash. Without this fallback such a manifest has no build id at all and
    // every check reports stale forever.
    expect(manifest({sha512: undefined}).buildId).toBe('151.0.7906.0');
  });

  it('carries the fields the Updates page shows', () => {
    expect(manifest()).toMatchObject({
      version: '151.0.7906.0',
      chromiumVersion: '151.0.7906.0',
      releaseDate: '2026-08-09T12:00:00.000Z',
      notes: 'Panel tabs.',
      size: 184499616,
    });
  });

  it('treats chromiumVersion as version when absent', () => {
    // Every manifest published before publish-browser.mjs existed.
    expect(manifest({chromiumVersion: undefined}).chromiumVersion).toBe('151.0.7906.0');
  });

  it('rejects what it cannot act on', () => {
    expect(() => normalizeManifest(null)).toThrow();
    expect(() => normalizeManifest({sha512: SHA})).toThrow(/url/);
    expect(() => normalizeManifest({url: 'x.zip'})).toThrow(/sha512 nor version/);
  });
});

describe('readInstallRecord', () => {
  it('reads a record written by a current install', () => {
    const record = readInstallRecord({
      recordJson: JSON.stringify(buildInstallRecord(manifest(), {installedAt: '2026-08-09T13:00:00.000Z'})),
    });
    expect(record).toMatchObject({
      buildId: SHA, version: '151.0.7906.0', installedAt: '2026-08-09T13:00:00.000Z', legacy: false,
    });
  });

  it('reads the legacy bare-string marker', () => {
    // The exact contents of ~/Library/Application Support/monti-anty/Browser/
    // .monti-browser-build on a machine that installed before this change.
    const record = readInstallRecord({legacyBuildId: `${SHA}\n`});
    expect(record).toMatchObject({buildId: SHA, legacy: true});
    // Honest about what the old format never recorded, rather than inventing it.
    expect(record.version).toBe('');
    expect(record.installedAt).toBe('');
  });

  it('prefers the JSON record when both exist', () => {
    const record = readInstallRecord({
      recordJson: JSON.stringify({buildId: 'new', version: '151.0.7906.0'}),
      legacyBuildId: 'old',
    });
    expect(record.buildId).toBe('new');
  });

  it('falls back to the legacy marker when the record is corrupt', () => {
    // The build on disk is still real; declaring nothing installed would
    // re-download it.
    expect(readInstallRecord({recordJson: '{not json', legacyBuildId: SHA}))
        .toMatchObject({buildId: SHA, legacy: true});
    expect(readInstallRecord({recordJson: '{"version":"1.0"}', legacyBuildId: SHA}))
        .toMatchObject({buildId: SHA, legacy: true});
  });

  it('reports nothing installed only when there is nothing', () => {
    expect(readInstallRecord({})).toBeNull();
    expect(readInstallRecord({recordJson: '   ', legacyBuildId: '  '})).toBeNull();
  });
});

describe('decideBrowserAction', () => {
  it('does not re-download when a legacy marker already names the published build', () => {
    // The case that ships once and cannot be re-run. Every install in the
    // field has this exact shape on the day this lands: a bare-string marker
    // matching the live manifest, and no JSON record. Getting it wrong pushes
    // a ~200 MB download onto every user to fetch what they already have.
    const record = readInstallRecord({legacyBuildId: SHA});
    expect(decideBrowserAction({record, manifest: manifest(), usingManaged: true})).toBe('up-to-date');
  });

  it('offers an update when a managed install is behind', () => {
    // Not an automatic download: an existing install still launches, so
    // spending 200 MB of someone's connection is their call.
    const record = readInstallRecord({legacyBuildId: 'an-older-build'});
    expect(decideBrowserAction({record, manifest: manifest(), usingManaged: true}))
        .toBe('update-available');
  });

  it('installs without asking when nothing managed exists', () => {
    expect(decideBrowserAction({record: null, manifest: manifest(), usingManaged: false}))
        .toBe('install');
  });

  it('installs the managed copy even when another browser resolves', () => {
    // A bundled or hand-installed /Applications copy launches but can never be
    // kept current, so the managed copy has to land before anything else can
    // work. Only happens once -- it outranks the others from then on.
    expect(decideBrowserAction({record: null, manifest: manifest(), usingManaged: false}))
        .toBe('install');
  });

  it('treats a managed directory with no marker at all as behind', () => {
    // An interrupted install, or one from before any marker existed. The
    // files are there but nothing says which build, so it cannot be trusted.
    expect(decideBrowserAction({record: null, manifest: manifest(), usingManaged: true}))
        .toBe('update-available');
  });

  it('refuses to decide without a manifest', () => {
    expect(() => decideBrowserAction({record: null, manifest: null, usingManaged: true})).toThrow();
  });
});
