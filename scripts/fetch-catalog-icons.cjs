// Fills src/assets/extensions/ with the real artwork for every entry in
// EXTENSION_CATALOG (src/data/extensionCatalog.ts).
//
//   node scripts/fetch-catalog-icons.cjs
//
// A build step, not something the app does at runtime: the Discover cards have
// to draw offline and on first paint, and an extension's icon changes about
// once a year. The output is committed, so a normal checkout never runs this.
//
// It downloads each extension's CRX from the same public update endpoint
// electron/main.cjs uses to actually install one, unpacks it, and pulls the
// largest icon out. That means there is one answer to "what does this id
// resolve to" -- the store's, not a re-hosted copy of ours.
//
// The other half of its job is the check. A Web Store id is 32 opaque
// characters; a typo in one installs a completely different extension and the
// only symptom is a surprised user. So this also reads each CRX's manifest
// name and compares it to the catalog's, and exits non-zero on a mismatch.
// Run it after editing the catalog.
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

const CATALOG_SOURCE = path.join(__dirname, '..', 'src', 'data', 'extensionCatalog.ts');
const ASSET_DIR = path.join(__dirname, '..', 'src', 'assets', 'extensions');

// The catalog is TypeScript and this is plain node, so rather than pull in a
// compiler for three fields, read them straight out of the source. Anchored on
// all three keys in order, which is how the file is written and how a
// half-edited entry gets noticed: it simply will not match, and the count
// assertion below fails.
function readCatalog() {
  const source = fs.readFileSync(CATALOG_SOURCE, 'utf8');
  const entries = [];
  // `gap` is a line comment or two between the keys -- several entries carry
  // one explaining why their name is worded the way it is.
  const gap = String.raw`\s*(?:\/\/[^\n]*\n\s*)*`;
  const pattern = new RegExp(
      String.raw`\{\s*id: '([a-p]{32})',${gap}slug: '([a-z0-9-]+)',${gap}` +
      String.raw`name: '((?:[^'\\]|\\.)*)'`, 'g');
  for (const match of source.matchAll(pattern)) {
    entries.push({id: match[1], slug: match[2], name: match[3].replace(/\\'/g, '\'')});
  }
  const declared = (source.match(/^\s*id: '[a-p]{32}',$/gm) || []).length;
  if (entries.length !== declared) {
    throw new Error(
        `Parsed ${entries.length} catalog entries but the file declares ${declared} ids. ` +
        'An entry is probably not in {id, slug, name} order -- see readCatalog().');
  }
  return entries;
}

function downloadBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, {headers: {'User-Agent': 'ScoutWeb/1.0'}}, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location &&
          redirectsLeft > 0) {
        res.resume();
        resolve(downloadBuffer(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// A CRX is a small header followed by a plain ZIP. Same reader as
// electron/main.cjs:crxZipOffset -- duplicated rather than imported because
// main.cjs is the Electron entry point and requiring it here would boot half
// the app.
function crxZipOffset(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'Cr24') {
    throw new Error('Not a CRX file (bad magic)');
  }
  const version = buffer.readUInt32LE(4);
  if (version === 3) {
    return 12 + buffer.readUInt32LE(8);
  }
  if (version === 2) {
    return 16 + buffer.readUInt32LE(8) + buffer.readUInt32LE(12);
  }
  throw new Error(`Unsupported CRX version ${version}`);
}

function unzipTo(zipBuffer, destDir) {
  fs.mkdirSync(destDir, {recursive: true});
  const tmpZip = path.join(destDir, 'package.zip');
  fs.writeFileSync(tmpZip, zipBuffer);
  const result = spawnSync('unzip', ['-o', '-q', tmpZip, '-d', destDir]);
  if (result.status !== 0) {
    throw new Error(`unzip failed: ${result.stderr?.toString() || result.status}`);
  }
  fs.rmSync(tmpZip, {force: true});
  // unzip honours the modes stored in the archive, and at least one published
  // CRX ships its icons mode 000 -- readable by Chrome, which never touches
  // the file through the filesystem, but not by us.
  spawnSync('chmod', ['-R', 'u+rwX', destDir]);
}

function updateUrl(id) {
  return 'https://clients2.google.com/service/update2/crx?response=redirect' +
      '&acceptformat=crx2,crx3&prodversion=124.0.0.0' +
      `&x=id%3D${id}%26installsource%3Dondemand%26uc`;
}

// Many extensions localize their own name, so manifest.name is the literal
// "__MSG_extName__" and the real string lives in the default locale's
// messages.json. Without this, every check below would compare against a
// placeholder and pass on anything.
function resolveName(dir, manifest) {
  const raw = manifest.name || '';
  const token = /^__MSG_(.+)__$/.exec(raw);
  if (!token) {
    return raw;
  }
  const locale = manifest.default_locale || 'en';
  for (const candidate of [locale, 'en', 'en_US']) {
    const messagesPath = path.join(dir, '_locales', candidate, 'messages.json');
    if (!fs.existsSync(messagesPath)) {
      continue;
    }
    const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
    // Message keys are case-insensitive in Chrome's own lookup.
    const key = Object.keys(messages).find((k) => k.toLowerCase() === token[1].toLowerCase());
    if (key && messages[key]?.message) {
      return messages[key].message;
    }
  }
  return raw;
}

// Prefer the biggest declared icon: these are drawn at 34px on a retina
// display, so a 48px source is already soft. Falls back to the toolbar icon,
// which some extensions declare instead of a top-level `icons` block.
function largestIconPath(dir, manifest) {
  const declared = {
    ...(manifest.icons || {}),
    ...(manifest.action?.default_icon || manifest.browser_action?.default_icon || {}),
  };
  const bySize = Object.entries(declared)
      .map(([size, file]) => ({size: Number(size), file}))
      .filter((icon) => Number.isFinite(icon.size) && typeof icon.file === 'string')
      .sort((a, b) => b.size - a.size);
  for (const icon of bySize) {
    const full = path.join(dir, icon.file);
    if (fs.existsSync(full)) {
      return full;
    }
  }
  return null;
}

async function fetchOne(entry, workRoot) {
  const dir = path.join(workRoot, entry.slug);
  const crx = await downloadBuffer(updateUrl(entry.id));
  unzipTo(crx.subarray(crxZipOffset(crx)), dir);

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const actualName = resolveName(dir, manifest);
  const iconPath = largestIconPath(dir, manifest);
  if (!iconPath) {
    throw new Error('CRX declares no usable icon');
  }
  // Written rather than copied, because copyFileSync carries the source's mode
  // across: a CRX icon stored read-only produced a read-only asset, and the
  // next run then could not overwrite its own output.
  const destination = path.join(ASSET_DIR, `${entry.slug}${path.extname(iconPath)}`);
  fs.rmSync(destination, {force: true});
  fs.writeFileSync(destination, fs.readFileSync(iconPath), {mode: 0o644});
  return {actualName, version: manifest.version, asset: path.basename(destination)};
}

// A store name legitimately carries suffixes the catalog's own label trims
// ("Dark Reader – Dark Mode for Chrome"), so this compares the shorter against
// the longer rather than demanding equality. It is a wrong-extension check,
// not a copy-editing one.
function namesAgree(expected, actual) {
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const a = normalize(expected);
  const b = normalize(actual);
  return a.includes(b) || b.includes(a);
}

async function main() {
  const catalog = readCatalog();
  fs.mkdirSync(ASSET_DIR, {recursive: true});
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scout-catalog-'));
  const mismatches = [];
  const failures = [];

  try {
    for (const entry of catalog) {
      try {
        const {actualName, version, asset} = await fetchOne(entry, workRoot);
        const agrees = namesAgree(entry.name, actualName);
        if (!agrees) {
          mismatches.push({entry, actualName});
        }
        console.log(
            `${agrees ? 'ok  ' : 'MISMATCH'}  ${entry.slug.padEnd(22)} ` +
            `${entry.id}  v${version}  ${asset}  "${actualName}"`);
      } catch (error) {
        failures.push({entry, error});
        console.log(`FAIL      ${entry.slug.padEnd(22)} ${entry.id}  ${error.message}`);
      }
    }
  } finally {
    fs.rmSync(workRoot, {recursive: true, force: true});
  }

  const ok = catalog.length - mismatches.length - failures.length;
  console.log(`\n${ok}/${catalog.length} name matches, ${mismatches.length} mismatched, ` +
      `${failures.length} failed`);
  for (const {entry, actualName} of mismatches) {
    console.log(`  ${entry.id} is "${actualName}", catalog says "${entry.name}"`);
  }
  if (mismatches.length || failures.length) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
