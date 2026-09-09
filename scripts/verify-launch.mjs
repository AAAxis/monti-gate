#!/usr/bin/env node
// Launches Monti Browser directly (bypassing the Electron launcher UI, since
// this only needs to exercise the browser-side --monti-profile-launch flow)
// with a full runtime fingerprint and no working proxy, then uses CDP to read
// back what the page actually observes. Verifies:
//   - the browser never navigates to the real target/login/direct page when
//     the proxy is missing or unreachable (fails closed to a local error
//     page instead, per StartupBrowserCreatorImpl's Scout-launch gate)
//   - the fingerprint the launcher would send is faithfully applied in the
//     renderer (navigator.hardwareConcurrency/deviceMemory/languages,
//     Intl timezone, WebGL unmasked vendor/renderer, userAgent)
// It intentionally does NOT exercise the proxy-verified/connected path: that
// needs a real routable proxy (egress IP must differ from this host's), which
// this environment doesn't have. See the plan doc for why.
import {spawn} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const BROWSER_APP = process.env.MONTI_BROWSER_APP ||
  '/Users/dima/monti-browser/out/Release-dmg/Monti.app';
const EXECUTABLE = path.join(BROWSER_APP, 'Contents/MacOS/Scout');
const LOCAL_API_PORT = 39217;

function base64UrlEncode(text) {
  return Buffer.from(text, 'utf8').toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
}

const FINGERPRINT_PAYLOAD = {
  platform: 'Win32',
  ua_string: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 ScoutVerify/1',
  preset: 'windows',
  seed: 424242,
  webrtc_mode: 'noise',
  canvas_mode: 'noise',
  webgl_mode: 'noise',
  webgpu_mode: 'real',
  client_rects_mode: 'noise',
  audio_mode: 'noise',
  webgl_vendor: 'Verify Vendor Inc.',
  webgl_renderer: 'ANGLE (Verify, Verify Renderer XYZ, Direct3D11)',
  timezone: 'Europe/Berlin',
  languages: ['de-DE', 'de'],
  geolocation_mode: 'off',
  latitude: 0,
  longitude: 0,
  cpu_cores: 6,
  memory_gb: 4,
  screen: '1600x900',
  rotate_on_launch: false,
};

async function waitFor(fn, {timeoutMs = 15000, intervalMs = 200, label = 'condition'} = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function findPageTarget(devtoolsPort) {
  const res = await fetch(`http://127.0.0.1:${devtoolsPort}/json`);
  if (!res.ok) {
    return null;
  }
  const targets = await res.json();
  return targets.find((t) => t.type === 'page') || null;
}

function cdpEvaluate(webSocketDebuggerUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const id = 1;
    ws.on('open', () => {
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {expression, returnByValue: true, awaitPromise: true},
      }));
    });
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id === id) {
        ws.close();
        if (msg.result?.exceptionDetails) {
          reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
          return;
        }
        resolve(msg.result?.result?.value);
      }
    });
    ws.on('error', reject);
  });
}

const OBSERVE_EXPRESSION = `(() => {
  let webglVendor = null, webglRenderer = null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (gl && ext) {
      webglVendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
      webglRenderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
    }
  } catch (e) {}
  return {
    href: location.href,
    title: document.title,
    bodyText: (document.body && document.body.innerText || '').slice(0, 500),
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    language: navigator.language,
    languages: Array.from(navigator.languages || []),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    webglVendor,
    webglRenderer,
  };
})()`;

function killTree(child) {
  return new Promise((resolve) => {
    if (!child || child.killed || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
    }, 4000);
  });
}

async function runScenario({name, profileId, devtoolsPort, extraArgs, expectHref}) {
  console.log(`\n=== Scenario: ${name} ===`);
  const userDataDir = mkdtempSync(path.join(tmpdir(), `scout-verify-${profileId}-`));
  const fingerprintArg = base64UrlEncode(JSON.stringify(FINGERPRINT_PAYLOAD));
  const args = [
    '--monti-profile-launch',
    `--monti-profile-id=${profileId}`,
    `--monti-profile-name=Verify ${name}`,
    `--user-data-dir=${userDataDir}`,
    '--profile-directory=Default',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--hide-crash-restore-bubble',
    '--disable-session-restore',
    '--disable-restore-session-state',
    '--disable-features=InfiniteSessionRestore',
    '--new-window',
    `--remote-debugging-port=${devtoolsPort}`,
    `--monti-fingerprint-json=${fingerprintArg}`,
    ...extraArgs,
    'https://example.com/should-never-load',
  ];

  const child = spawn(EXECUTABLE, args, {stdio: 'ignore'});
  const results = {name, pass: [], fail: []};
  const check = (label, ok, detail) => {
    (ok ? results.pass : results.fail).push(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` -- ${detail}` : ''}`);
  };

  try {
    const target = await waitFor(() => findPageTarget(devtoolsPort), {label: 'devtools page target'});
    // Give the Scout-launch gate time to resolve. This may pass through the
    // "connecting" interstitial first (while SocksBridge/egress-check attempts
    // run their retries) before landing on the terminal error page, so wait
    // for the specific expected URL rather than any /v1.0/internal/* page.
    let observed;
    await waitFor(async () => {
      observed = await cdpEvaluate(target.webSocketDebuggerUrl, OBSERVE_EXPRESSION);
      return observed.href === expectHref;
    }, {timeoutMs: 40000, label: `navigation to ${expectHref}`});

    console.log('Observed:', JSON.stringify(observed, null, 2));

    check('never navigated to the real target URL', observed.href !== 'https://example.com/should-never-load');
    check('first/only page is not about:blank, chrome://scout*, or data:',
      !observed.href.startsWith('about:blank') &&
      !observed.href.startsWith('chrome://scout') &&
      !observed.href.startsWith('data:'));
    check('landed on expected local page', observed.href === expectHref, observed.href);
    check('no "Sign in to Scout" / "Cloud account required" text',
      !/Sign in to Scout|Cloud account required/i.test(observed.bodyText));
    check('navigator.hardwareConcurrency matches payload',
      observed.hardwareConcurrency === FINGERPRINT_PAYLOAD.cpu_cores,
      `got ${observed.hardwareConcurrency}, want ${FINGERPRINT_PAYLOAD.cpu_cores}`);
    check('navigator.deviceMemory matches payload bucket',
      observed.deviceMemory === FINGERPRINT_PAYLOAD.memory_gb,
      `got ${observed.deviceMemory}, want ${FINGERPRINT_PAYLOAD.memory_gb}`);
    check('Intl timezone matches payload',
      observed.timeZone === FINGERPRINT_PAYLOAD.timezone,
      `got ${observed.timeZone}, want ${FINGERPRINT_PAYLOAD.timezone}`);
    check('navigator.language(s) matches payload',
      observed.language === FINGERPRINT_PAYLOAD.languages[0] &&
      FINGERPRINT_PAYLOAD.languages.every((l) => observed.languages.includes(l)),
      `got ${JSON.stringify(observed.languages)}, want ${JSON.stringify(FINGERPRINT_PAYLOAD.languages)}`);
    check('WebGL unmasked vendor matches payload',
      observed.webglVendor === FINGERPRINT_PAYLOAD.webgl_vendor,
      `got ${observed.webglVendor}, want ${FINGERPRINT_PAYLOAD.webgl_vendor}`);
    check('WebGL unmasked renderer matches payload',
      observed.webglRenderer === FINGERPRINT_PAYLOAD.webgl_renderer,
      `got ${observed.webglRenderer}, want ${FINGERPRINT_PAYLOAD.webgl_renderer}`);
    check('navigator.platform matches preset', observed.platform === FINGERPRINT_PAYLOAD.platform);

    // Cross-check the diagnostic endpoint too.
    const debugRes = await fetch(`http://127.0.0.1:${LOCAL_API_PORT}/v1.0/browser_profiles/${profileId}/debug`);
    const debugEnvelope = await debugRes.json();
    const debugJson = debugEnvelope.data || {};
    check('debug endpoint reports running:true', debugJson.running === true, JSON.stringify(debugEnvelope));
    check('debug endpoint proxy chip is never "connected"',
      debugJson.connection_state !== 'connected', debugJson.connection_state);
    check('debug endpoint fingerprint matches payload',
      debugJson.fingerprint?.cpu_cores === FINGERPRINT_PAYLOAD.cpu_cores &&
      debugJson.fingerprint?.timezone === FINGERPRINT_PAYLOAD.timezone &&
      debugJson.fingerprint?.webgl_vendor === FINGERPRINT_PAYLOAD.webgl_vendor,
      JSON.stringify(debugJson.fingerprint));
  } finally {
    await killTree(child);
    rmSync(userDataDir, {recursive: true, force: true});
  }
  return results;
}

async function main() {
  const scenarios = [
    {
      name: 'missing proxy (no --scout-proxy-* switches)',
      profileId: 'verify-missing-proxy',
      devtoolsPort: 9333,
      extraArgs: [],
      expectHref: 'http://127.0.0.1:39217/v1.0/internal/proxy-error',
    },
    {
      name: 'unreachable proxy (TEST-NET address)',
      profileId: 'verify-unreachable-proxy',
      devtoolsPort: 9334,
      extraArgs: [
        '--monti-proxy-host=203.0.113.1',
        '--monti-proxy-port=1',
        '--monti-proxy-type=socks5',
      ],
      expectHref: 'http://127.0.0.1:39217/v1.0/internal/proxy-error',
    },
  ];

  let allPass = true;
  for (const scenario of scenarios) {
    const {name, pass, fail} = await runScenario(scenario);
    console.log(`\n-- ${name} --`);
    for (const line of [...pass, ...fail]) {
      console.log(line);
    }
    if (fail.length) {
      allPass = false;
    }
  }

  console.log(`\n${allPass ? 'ALL SCENARIOS PASSED' : 'SOME CHECKS FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((error) => {
  console.error('Verify script crashed:', error);
  process.exit(1);
});
