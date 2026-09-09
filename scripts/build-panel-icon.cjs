// Rasterizes scripts/panel-icon-art.cjs into the Scout Panel's action icons.
//
//   npm run panel-icon
//
// Same shape and the same reasoning as build-icons.cjs next door: a build step
// rather than something the launch path does, rendered through Electron because
// Electron is already a devDependency and Chromium is the only SVG rasterizer
// this repo can assume is present. The output is committed, so a normal
// checkout can package without ever running this.
//
// Unlike build-icons.cjs this is not macOS-only -- there is no iconutil in it,
// only PNGs -- and it renders each size separately rather than downscaling one
// master. The artwork is line art with hairlines at 16px, which is exactly the
// case where a resample and a fresh rasterization are not the same thing.
const fs = require('node:fs');
const path = require('node:path');

const {app, BrowserWindow, screen} = require('electron');

const {iconSpecs} = require('./panel-icon-art.cjs');

const OUT_DIR = path.join(__dirname, '../extensions/cookie-manager/icons');

async function main() {
  const specs = iconSpecs();
  const window = await openRenderWindow();
  try {
    for (const spec of specs) {
      const dir = path.join(OUT_DIR, spec.dir);
      fs.mkdirSync(dir, {recursive: true});
      const png = await render(window, spec.svg(), spec.size);
      fs.writeFileSync(path.join(dir, `icon-${spec.size}.png`), png);
      console.log(`  wrote ${spec.dir}/icon-${spec.size}.png`);
    }
  } finally {
    window.destroy();
  }
  console.log(`${specs.length} icons -> ${OUT_DIR}`);
}

// Frameless and transparent: the mark is drawn straight onto alpha, so anything
// composited behind it would ship as an opaque square sitting in the toolbar.
async function openRenderWindow() {
  const window = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {offscreen: true},
  });
  await window.loadURL('data:text/html,<html><body></body></html>');
  return window;
}

// capturePage() reports its rect in CSS pixels but hands back device pixels, so
// on a Retina Mac an N-wide window captures 2N. The page is laid out at
// N/scaleFactor CSS pixels, which makes the SVG rasterize at exactly N device
// pixels -- the same file on any display.
async function render(window, svg, size) {
  const scale = screen.getPrimaryDisplay().scaleFactor || 1;
  const css = size / scale;
  const html =
    '<html><head><style>' +
    'html,body{margin:0;padding:0;background:transparent}' +
    `svg{display:block;width:${css}px;height:${css}px}` +
    '</style></head><body>' + svg + '</body></html>';
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const image = await window.webContents.capturePage({x: 0, y: 0, width: css, height: css});
  const captured = image.getSize().width;
  if (captured !== size) {
    // Not fatal, but it means the scale-factor compensation above missed and
    // this icon is a resample rather than a render. Worth saying out loud.
    console.warn(`  captured ${captured}px, expected ${size}px; resizing`);
    return image.resize({width: size, height: size, quality: 'best'}).toPNG();
  }
  return image.toPNG();
}

app.disableHardwareAcceleration();
app.whenReady()
    .then(main)
    .then(() => app.exit(0))
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
