const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {launcherIconIcns} = require('../electron/profile-icons.cjs');

const root = path.resolve(__dirname, '..');
const sourceApp = path.join(root, 'node_modules/electron/dist/Electron.app');
const targetApp = path.join(os.homedir(), 'Applications/Scout Web.app');
const targetContents = path.join(targetApp, 'Contents');
const targetResources = path.join(targetContents, 'Resources');
const plistPath = path.join(targetContents, 'Info.plist');
// The dev bundle gets the same mark the packaged app ships (see
// build.mac.icon), so a dev run is not the one place the launcher still wears
// the browser's tile. Light because a bundle icon on disk cannot follow the
// app's theme -- the running app re-tiles its own Dock entry from the matching
// .png, which is the only part of this that can react to dark mode.
const iconSource = launcherIconIcns(false) || path.join(root, 'assets/app.icns');
const iconTarget = path.join(targetResources, 'app.icns');

function xmlEscape(value) {
  return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
}

function replacePlistString(plist, key, value) {
  const escaped = xmlEscape(value);
  const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)([^<]*)(</string>)`);
  if (pattern.test(plist)) {
    return plist.replace(pattern, `$1${escaped}$3`);
  }
  return plist.replace('</dict>', `<key>${key}</key><string>${escaped}</string>\n</dict>`);
}

// LaunchServices decides who handles scout:// from CFBundleURLTypes in the
// bundle's Info.plist -- app.setAsDefaultProtocolClient() alone does not
// register the scheme on macOS. Without this the deep link silently goes
// nowhere, which looks exactly like a broken button.
//
// This is an array of dicts, which replacePlistString cannot express, so it
// gets its own writer. Replaces any existing block so re-runs stay idempotent.
function setPlistUrlScheme(plist, {name, scheme}) {
  const block = [
    '<key>CFBundleURLTypes</key>',
    '<array>',
    '  <dict>',
    `    <key>CFBundleURLName</key><string>${xmlEscape(name)}</string>`,
    '    <key>CFBundleTypeRole</key><string>Viewer</string>',
    '    <key>CFBundleURLSchemes</key>',
    `    <array><string>${xmlEscape(scheme)}</string></array>`,
    '  </dict>',
    '</array>',
  ].join('\n');

  const existing = /<key>CFBundleURLTypes<\/key>\s*<array>[\s\S]*?<\/array>/;
  if (existing.test(plist)) {
    return plist.replace(existing, block);
  }
  // Append to the ROOT dict, which is the last </dict> before </plist>.
  // Electron's plist nests dicts inside CFBundleDocumentTypes, so a plain
  // replace('</dict>', ...) lands inside a child and LaunchServices never sees
  // the key. (replacePlistString has the same latent flaw, but every key it
  // writes already exists, so it never reaches its fallback.)
  const rootClose = /<\/dict>\s*<\/plist>\s*$/;
  if (!rootClose.test(plist)) {
    throw new Error('Info.plist does not end with </dict></plist> -- refusing to guess where the root dict ends');
  }
  return plist.replace(rootClose, `${block}\n</dict>\n</plist>\n`);
}

if (process.platform !== 'darwin') {
  process.exit(0);
}

if (!fs.existsSync(sourceApp)) {
  throw new Error(`Electron app not found at ${sourceApp}`);
}

fs.rmSync(targetApp, {recursive: true, force: true});
fs.mkdirSync(path.dirname(targetApp), {recursive: true});
fs.cpSync(sourceApp, targetApp, {recursive: true, verbatimSymlinks: true});

let plist = fs.readFileSync(plistPath, 'utf8');
plist = replacePlistString(plist, 'CFBundleName', 'Scout Web');
plist = replacePlistString(plist, 'CFBundleDisplayName', 'Scout Web');
plist = replacePlistString(plist, 'CFBundleIdentifier', 'com.scout.web');
plist = replacePlistString(plist, 'CFBundleIconFile', 'app');
plist = setPlistUrlScheme(plist, {name: 'com.scout.web.deeplink', scheme: 'scout'});
fs.writeFileSync(plistPath, plist);

if (fs.existsSync(iconSource)) {
  fs.mkdirSync(targetResources, {recursive: true});
  fs.copyFileSync(iconSource, iconTarget);
}

// What makes the bundle openable on its own.
//
// This is a copy of Electron.app, and Electron only has an app to run if one is
// named on the command line or sits at Contents/Resources/app. start-macos-app
// passes the project on the command line, so `npm start` worked -- but the
// bundle it leaves in ~/Applications is also a normal app in Launchpad and
// Spotlight, and clicking it there passes no arguments. Electron then fell back
// to its built-in default_app.asar: the grey window listing Electron/Chromium/
// Node versions, which looks exactly like the launcher failing to start.
//
// A symlink rather than a copy so the bundle always runs the working tree, and
// to the project root rather than a stub so Electron reads the real
// package.json -- `name` there is what decides the userData directory, and a
// stub with a different name would silently strand every existing setting in
// ~/Library/Application Support/scout-web. Verified: this leaves
// app.isPackaged false, so the auto-updater stays off in a dev bundle.
const appPayload = path.join(targetResources, 'app');
fs.rmSync(appPayload, {recursive: true, force: true});
fs.symlinkSync(root, appPayload);

console.log(targetApp);
