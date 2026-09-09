// One executor per step type, plus the validator.
//
// Executors receive a context and the already-interpolated step, and return
// either nothing or {vars} to merge. They do NOT implement their own timeouts:
// runner.cjs applies one with Promise.race around every call, so no executor
// can forget one. They also do not catch their own errors -- throwing is how a
// step reports failure, and the runner's onError policy decides what that means.

const https = require('node:https');
const http = require('node:http');
const {LOAD_TIMEOUT_MS} = require('../cdp-core.cjs');
const ai = require('./ai.cjs');
const connectors = require('./connectors.cjs');

const POLL_INTERVAL_MS = 100;

// ── helpers ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs an expression in the page and returns its value, turning a thrown
// exception into a thrown Error rather than a silent undefined.
async function evaluateValue(cdp, expression, {awaitPromise = false} = {}) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });
  if (result.exceptionDetails) {
    throw new Error(
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        'The script threw');
  }
  return result.result?.value;
}

// Resolves a selector to its centre point in viewport coordinates, scrolling it
// into view first. Returns null when it does not match.
async function boxOf(cdp, selector, nth) {
  const expression = `(() => {
    const all = document.querySelectorAll(${JSON.stringify(selector)});
    const el = all[${Number(nth) || 0}];
    if (!el) return null;
    el.scrollIntoView({block: 'center', inline: 'center'});
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return {x: r.left + r.width / 2, y: r.top + r.height / 2};
  })()`;
  return evaluateValue(cdp, expression);
}

async function focusSelector(cdp, selector, clear) {
  const expression = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    if (${Boolean(clear)} && 'value' in el) {
      el.value = '';
      el.dispatchEvent(new Event('input', {bubbles: true}));
    }
    return true;
  })()`;
  const ok = await evaluateValue(cdp, expression);
  if (!ok) {
    throw new Error(`No element matches ${selector}`);
  }
}

// How much of a page an AI step may send.
//
// A cap, not a nicety. Pages run to hundreds of kilobytes of boilerplate, every
// character of it is billed, and past a model's context window the request is
// rejected outright rather than truncated for us. 12k characters is roughly
// 3k tokens -- enough for the readable content of an ordinary page, and small
// enough that a runaway single-page app cannot turn one step into a large bill.
const AI_CONTEXT_LIMIT = 12000;

// What an AI step shows the model, per its `context` field.
//
// innerText and not innerHTML: the question is almost always about what the
// page says, markup triples the token count, and a model reading tag soup
// answers worse than one reading prose.
async function pageContext(cdp, step) {
  if (step.context === 'selector') {
    if (!step.selector) {
      throw new Error('This step is set to read a selector but names none');
    }
    const text = await evaluateValue(cdp, `(() => {
      const el = document.querySelector(${JSON.stringify(String(step.selector))});
      return el ? (el.innerText || el.textContent || '') : null;
    })()`);
    // Null means no match, which is a different thing from an element that is
    // empty -- and asking a model about nothing produces a confident answer
    // about nothing. Same "no phantom data" rule extract follows.
    if (text === null) {
      throw new Error(`No element matches ${step.selector}`);
    }
    return String(text).slice(0, AI_CONTEXT_LIMIT);
  }
  if (step.context === 'pageText') {
    const text = await evaluateValue(
        cdp, '(document.body && document.body.innerText) || ""');
    return String(text || '').slice(0, AI_CONTEXT_LIMIT);
  }
  return '';
}

// Polls `expression` until it returns true. Used by waitFor, which cannot lean
// on a single CDP event for selector and text conditions.
async function pollUntil(cdp, expression, deadline, describe) {
  for (;;) {
    if (await evaluateValue(cdp, expression)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${describe}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Maps a CDP Storage.getCookies() cookie to the shape src/lib/cookieFile.ts
// normalizeCookie() expects -- the same shape the extension pushes through
// scout:cookie-sync-push-request. THE CONTRACT THAT MUST NOT DRIFT: see that
// file's header.
//
// `expires` is CDP's seconds-since-epoch, with -1 (or anything <= 0) meaning a
// session cookie -- expirationDate is omitted entirely rather than written as
// 0 or -1, because normalizeCookie treats *any* expirationDate key as "has an
// expiry". `sameSite` is omitted, not defaulted, when CDP omits it: the
// renderer's own normalizer supplies its default, and hard-coding one here
// would take that decision away from it.
function cdpCookieToEntry(cookie) {
  const entry = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
  };
  const sameSite = {Strict: 'strict', Lax: 'lax', None: 'no_restriction'}[cookie.sameSite];
  if (sameSite) {
    entry.sameSite = sameSite;
  }
  if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
    entry.expirationDate = cookie.expires;
  }
  return entry;
}

// Empty filter keeps everything. Otherwise a cookie's domain -- stripped of
// CDP's leading dot -- must equal the filter or be one of its subdomains, so
// "example.com" keeps ".example.com" and "sub.example.com" but not
// "notexample.com" (a plain suffix match would let that one through).
//
// Both sides are lowercased and dot-stripped before comparing, not just the
// cookie side: ".example.com" is the exact spelling the Cookies tab and every
// export file show, and RFC 6265 domains are case-insensitive even though CDP
// happens to hand them back lowercased -- a filter typed by hand is not.
function filterCookiesByDomain(cookies, domain) {
  const filter = String(domain || '').trim().toLowerCase().replace(/^\./, '');
  if (!filter) {
    return cookies;
  }
  return cookies.filter((cookie) => {
    const bare = String(cookie.domain || '').toLowerCase().replace(/^\./, '');
    return bare === filter || bare.endsWith(`.${filter}`);
  });
}

// ── executors ────────────────────────────────────────────────────────────────

const EXECUTORS = {
  async goto({cdp, step, log}) {
    await cdp.send('Page.enable');
    // Subscribe before navigating: a cached page can fire its load event before
    // Page.navigate's own response comes back.
    const event = step.waitUntil === 'domcontentloaded' ?
      'Page.domContentEventFired' :
      'Page.frameStoppedLoading';
    const settled = cdp.once(event, LOAD_TIMEOUT_MS);
    const result = await cdp.send('Page.navigate', {url: step.url});
    if (result.errorText) {
      throw new Error(`${step.url} failed to load: ${result.errorText}`);
    }
    try {
      await settled;
    } catch {
      // A page that never stops loading is still a page the next step can use.
      log('warn', `${step.url} did not finish loading; continuing`);
    }
  },

  async waitFor({cdp, step, deadline}) {
    if (step.for === 'selector') {
      return pollUntil(cdp,
          `!!document.querySelector(${JSON.stringify(step.selector)})`,
          deadline, step.selector);
    }
    if (step.for === 'selectorGone') {
      return pollUntil(cdp,
          `!document.querySelector(${JSON.stringify(step.selector)})`,
          deadline, `${step.selector} to disappear`);
    }
    if (step.for === 'url') {
      return pollUntil(cdp,
          `location.href.includes(${JSON.stringify(step.url)})`,
          deadline, `the URL to contain ${step.url}`);
    }
    return pollUntil(cdp,
        `(document.body?.innerText || '').includes(${JSON.stringify(step.text)})`,
        deadline, `the text ${JSON.stringify(step.text)}`);
  },

  async click({cdp, step}) {
    const point = await boxOf(cdp, step.selector, step.nth);
    if (!point) {
      throw new Error(`No visible element matches ${step.selector}`);
    }
    // Real mouse events rather than el.click(): sites that check isTrusted
    // ignore a synthetic click, and this is an anti-detect product.
    const base = {x: point.x, y: point.y, button: 'left', clickCount: 1};
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mousePressed'});
    await cdp.send('Input.dispatchMouseEvent', {...base, type: 'mouseReleased'});
  },

  async type({cdp, step}) {
    await focusSelector(cdp, step.selector, step.clear !== false);
    const text = String(step.text ?? '');
    if (step.delayMs && step.delayMs > 0) {
      // Per-character key events. Slower, but it is what a site watching for
      // paste-shaped input is looking at.
      for (const char of text) {
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyDown', text: char});
        await cdp.send('Input.dispatchKeyEvent', {type: 'keyUp'});
        await sleep(step.delayMs);
      }
    } else {
      await cdp.send('Input.insertText', {text});
    }
    if (step.pressEnter) {
      const enter = {windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r'};
      await cdp.send('Input.dispatchKeyEvent', {...enter, type: 'keyDown'});
      await cdp.send('Input.dispatchKeyEvent', {...enter, type: 'keyUp'});
    }
  },

  async scroll({cdp, step}) {
    if (step.to === 'selector') {
      const ok = await evaluateValue(cdp, `(() => {
        const el = document.querySelector(${JSON.stringify(step.selector)});
        if (!el) return false;
        el.scrollIntoView({block: 'center'});
        return true;
      })()`);
      if (!ok) {
        throw new Error(`No element matches ${step.selector}`);
      }
      return;
    }
    const target = step.to === 'top' ? '0' : 'document.body.scrollHeight';
    await evaluateValue(cdp, `window.scrollTo(0, ${target})`);
  },

  async extract({cdp, step}) {
    const what = step.what || 'text';
    const reader = {
      text: 'el.innerText',
      html: 'el.innerHTML',
      value: 'el.value',
      attr: `el.getAttribute(${JSON.stringify(step.attr || '')})`,
    }[what];
    const expression = step.all ?
      `Array.from(document.querySelectorAll(${JSON.stringify(step.selector)}))
         .map((el) => ${reader} ?? null)` :
      `(() => {
         const el = document.querySelector(${JSON.stringify(step.selector)});
         if (!el) return null;
         return ${reader} ?? null;
       })()`;
    const value = await evaluateValue(cdp, expression);
    // An empty array is a legitimate answer; a null single match is not -- it
    // means the selector found nothing, and storing null would let the next
    // step run on a value that was never really there.
    if (!step.all && value === null) {
      throw new Error(`No element matches ${step.selector}`);
    }
    return {vars: {[step.into]: value}};
  },

  async evaluate({cdp, step}) {
    // The script is NEVER interpolated -- see interpolate.cjs. Values arrive as
    // a real argument, JSON-encoded, so nothing is spliced into source.
    const args = JSON.stringify(step.args || {});
    const value = await evaluateValue(
        cdp,
        `(function(vars){ ${step.script} })(${args})`,
        {awaitPromise: true});
    return step.into ? {vars: {[step.into]: value}} : undefined;
  },

  async screenshot({cdp, step, saveScreenshot}) {
    await cdp.send('Page.enable');
    // A shot kept for the run history is a PNG, because it is looked at once
    // and space is cheap. One a workflow is going to carry -- into a variable,
    // through a POST, over somebody's phone signal -- is a JPEG, because none
    // of that is cheap.
    const wanted = step.into ? 'jpeg' : 'png';
    const params = {
      format: step.format || wanted,
      captureBeyondViewport: Boolean(step.fullPage),
    };
    if (params.format === 'jpeg') {
      params.quality = Number.isFinite(Number(step.quality)) ? Number(step.quality) : 55;
    }
    if (step.selector) {
      const box = await evaluateValue(cdp, `(() => {
        const el = document.querySelector(${JSON.stringify(step.selector)});
        if (!el) return null;
        el.scrollIntoView({block: 'center'});
        const r = el.getBoundingClientRect();
        return {x: r.left, y: r.top, width: r.width, height: r.height};
      })()`);
      if (!box) {
        throw new Error(`No element matches ${step.selector}`);
      }
      params.clip = {...box, scale: 1};
    }
    const result = await cdp.send('Page.captureScreenshot', params);
    if (!result.data) {
      throw new Error('The browser returned an empty screenshot');
    }
    const saved = {screenshot: await saveScreenshot(result.data)};
    // The picture itself, for a step that wants to do something with it. Base64
    // as the browser handed it over, so an httpRequest can post it as-is.
    return step.into ? {...saved, vars: {[step.into]: result.data}} : saved;
  },

  async wait({step}) {
    if (step.minMs !== undefined && step.maxMs !== undefined) {
      const min = Math.min(step.minMs, step.maxMs);
      const max = Math.max(step.minMs, step.maxMs);
      return sleep(min + Math.random() * (max - min));
    }
    return sleep(Math.max(0, Number(step.ms) || 0));
  },

  async setVar({step}) {
    return {vars: {[step.name]: step.value}};
  },

  // Sent from the launcher, not the page. A fetch from the page would traverse
  // the profile's proxy and carry its cookies, which is a surprising and leaky
  // default for "post my results to a webhook".
  async httpRequest({step}) {
    const value = await new Promise((resolve, reject) => {
      let url;
      try {
        url = new URL(step.url);
      } catch {
        reject(new Error(`Not a valid URL: ${step.url}`));
        return;
      }
      const transport = url.protocol === 'http:' ? http : https;
      const request = transport.request(url, {
        method: step.method || 'GET',
        headers: step.headers || {},
        timeout: 30000,
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => {
          let parsed = body;
          try {
            parsed = JSON.parse(body);
          } catch {
            // Not JSON; the raw text is the answer.
          }
          resolve({status: response.statusCode, body: parsed});
        });
      });
      request.on('timeout', () => request.destroy(new Error(`${step.url} timed out`)));
      request.on('error', reject);
      if (step.method === 'POST' && step.body) {
        request.write(step.body);
      }
      request.end();
    });
    return step.into ? {vars: {[step.into]: value}} : undefined;
  },

  async aiPrompt({cdp, step, log}) {
    const provider = connectors.resolve(step.provider, 'ai');
    const context = await pageContext(cdp, step);
    const answer = await ai.complete({
      provider,
      system: step.format === 'json' ?
        'Answer with a single JSON object and nothing else. No prose, no code fences.' :
        'Answer plainly and briefly. No preamble.',
      user: context ? `${step.prompt}\n\n---\n${context}` : step.prompt,
      maxTokens: step.maxTokens,
      json: step.format === 'json',
    });
    // The model's answer is logged; the prompt and the key are not. The answer
    // is what a person debugging this run needs to see, and it is the only one
    // of the three that is not either large or secret.
    log('info', `${provider.name} answered ${answer.length} characters`);
    if (step.format !== 'json') {
      return {vars: {[step.into]: answer}};
    }
    // Fences happen even when the prompt forbids them and response_format is
    // set, because not every OpenAI-compatible server implements that flag.
    const cleaned = answer.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      return {vars: {[step.into]: JSON.parse(cleaned)}};
    } catch {
      // The raw text is NOT stored as a fallback. A step that asked for JSON and
      // silently stored a paragraph turns into a failure three steps later, in
      // whichever step first read a field off it.
      throw new Error(
          `${provider.name} was asked for JSON and did not answer with any: ` +
          `${cleaned.slice(0, 120)}`);
    }
  },

  async aiCheck({cdp, step, log}) {
    const provider = connectors.resolve(step.provider, 'ai');
    const context = await pageContext(cdp, step);
    const answer = await ai.complete({
      provider,
      // Both halves matter. Without the first the model explains itself; without
      // the second a cautious model answers "I cannot determine that", which is
      // not a branch either arm of an If can take.
      system: 'Answer with exactly one word: yes or no. Never anything else. ' +
        'If you are unsure, answer no.',
      user: context ? `${step.question}\n\n---\n${context}` : step.question,
      maxTokens: 8,
    });
    // Punctuation and casing are stripped; anything beyond that is not
    // interpreted. "Yes." is a yes, "probably yes" is not -- guessing at a
    // hedge is how a branch silently starts taking the wrong arm.
    const word = answer.toLowerCase().replace(/[^a-z]/g, '');
    if (word !== 'yes' && word !== 'no') {
      throw new Error(
          `${provider.name} was asked for yes or no and answered "${answer.slice(0, 60)}"`);
    }
    log('info', `${provider.name}: ${word}`);
    if (word === 'no' && step.onFalse === 'fail') {
      // The assertion the catalogue never had. Thrown rather than returned, so
      // the step's own onError decides whether the run stops or goes partial --
      // this executor should not be the thing that makes that call.
      //
      // `into` is not written on this path: the runner merges vars only from a
      // step that returned. The log line above is where the answer survives,
      // which is the right place for it when the point was that it was "no".
      throw new Error(`AI check failed: ${step.question}`);
    }
    return step.into ? {vars: {[step.into]: word}} : undefined;
  },

  async notify({step, log}) {
    // No CDP, like httpRequest, and sent from the launcher for the same
    // reason: a send from the page would traverse the profile's proxy and
    // carry its cookies. `message` arrives already interpolated -- that is how
    // an AI step's answer travels: "Done: {{vars.summary}}".
    const connector = connectors.resolve(step.connector, 'message');
    await connectors.send({connector, message: step.message, subject: step.subject});
    // The length, not the body. The body may hold interpolated page data and
    // the log is flushed to the cloud with the run record -- same rule as the
    // aiPrompt prompt above.
    log('info', `Sent ${String(step.message || '').length} characters via ${connector.name}`);
  },

  // saveCookies has no CDP-level "does this launch support it" check -- the
  // capability lives one level up, in runner.cjs's saveCookies(), which
  // throws when this launch was started without a pushCookies callback rather
  // than letting this executor silently save nothing.
  async saveCookies({cdp, step, log, saveCookies}) {
    const {cookies} = await cdp.send('Storage.getCookies');
    const filtered = filterCookiesByDomain(cookies, step.domain);
    const mapped = filtered.map(cdpCookieToEntry);
    const result = await saveCookies(mapped);
    // result.saved is what the renderer actually stored, not what was sent --
    // cookiesFromJsonValue drops anything normalizeCookie() rejects, so this
    // can be lower than mapped.length even on a genuine success. Fall back to
    // mapped.length only when the capability's result carries no count.
    const saved = result && Number.isFinite(result.saved) ? result.saved : mapped.length;
    // mapped.length === 0 means the domain filter matched nothing in this
    // profile. The renderer's empty-push guard no-ops on that (it will not
    // wipe a live set down to nothing), so the step and the run both still
    // read `ok` -- warn is the one place a mistyped filter is visible at all.
    log(mapped.length === 0 ? 'warn' : 'info',
        `Saved ${saved} cookies to the Launcher` +
        (result && result.set ? ` (${result.set})` : ''));
  },
};

// ── conditions ───────────────────────────────────────────────────────────────

async function evaluateCondition(cdp, condition) {
  const left = condition.left;
  const right = condition.right;
  switch (condition.op) {
    case 'exists':
      return left !== undefined && left !== null && String(left) !== '';
    case 'selectorExists':
      return Boolean(await evaluateValue(
          cdp, `!!document.querySelector(${JSON.stringify(String(left))})`));
    case 'equals':
      return String(left) === String(right);
    case 'notEquals':
      return String(left) !== String(right);
    case 'contains':
      return String(left).includes(String(right));
    default:
      throw new Error(`Unknown condition ${condition.op}`);
  }
}

// ── validation ───────────────────────────────────────────────────────────────

const MAX_DEPTH = 3;
const MAX_RETRIES = 5;

function fieldVisible(field, step) {
  if (!field.showWhen) {
    return true;
  }
  return Object.entries(field.showWhen).every(([key, expected]) => {
    const actual = step[key];
    return Array.isArray(expected) ?
      expected.includes(String(actual)) :
      String(actual) === expected;
  });
}

// Returns a list of human-readable problems. Empty means valid.
//
// The messages are addressed by path ("steps[2].selector is required") because
// they are what an agent authoring a workflow over MCP gets back -- the
// validator is its feedback loop, so a vague message costs a round trip.
function validateSteps(steps, schema, path = 'steps', depth = 0) {
  const problems = [];
  if (!Array.isArray(steps)) {
    return [`${path} must be a list`];
  }
  if (depth > MAX_DEPTH) {
    return [`${path} is nested deeper than ${MAX_DEPTH} levels`];
  }
  steps.forEach((step, index) => {
    const at = `${path}[${index}]`;
    if (!step || typeof step !== 'object') {
      problems.push(`${at} must be an object`);
      return;
    }
    const spec = schema[step.type];
    if (!spec) {
      problems.push(`${at}.type "${step.type}" is not a known step type`);
      return;
    }
    if (!step.id) {
      problems.push(`${at}.id is required`);
    }
    if (step.onError && !['stop', 'continue', 'retry'].includes(step.onError)) {
      problems.push(`${at}.onError must be stop, continue or retry`);
    }
    if (step.retries !== undefined && (step.retries < 0 || step.retries > MAX_RETRIES)) {
      problems.push(`${at}.retries must be between 0 and ${MAX_RETRIES}`);
    }
    for (const field of spec.fields) {
      const value = step[field.key];
      if (field.kind === 'steps') {
        if (value !== undefined) {
          problems.push(...validateSteps(value, schema, `${at}.${field.key}`, depth + 1));
        }
        continue;
      }
      // A hidden field is never required -- otherwise `attr` would block every
      // extract that is not reading an attribute.
      if (!fieldVisible(field, step)) {
        continue;
      }
      if (field.required && (value === undefined || value === null || value === '')) {
        problems.push(`${at}.${field.key} is required`);
        continue;
      }
      if (value === undefined || value === null) {
        continue;
      }
      if (field.pattern && !new RegExp(field.pattern).test(String(value))) {
        problems.push(`${at}.${field.key} must match ${field.pattern}`);
      }
      if (field.options && !field.options.includes(String(value))) {
        problems.push(
            `${at}.${field.key} must be one of ${field.options.join(', ')}`);
      }
    }
    if (step.type === 'if') {
      if (!step.condition || !step.condition.op) {
        problems.push(`${at}.condition is required`);
      }
      problems.push(...validateSteps(step.then || [], schema, `${at}.then`, depth + 1));
      if (step.else) {
        problems.push(...validateSteps(step.else, schema, `${at}.else`, depth + 1));
      }
    }
    if (step.type === 'loop') {
      if (step.mode === 'times' && !(step.times > 0)) {
        problems.push(`${at}.times must be a positive number`);
      }
      if (step.mode === 'forEach' && !step.items) {
        problems.push(`${at}.items is required for a forEach loop`);
      }
      problems.push(...validateSteps(step.body || [], schema, `${at}.body`, depth + 1));
    }
    if (step.type === 'wait' &&
        step.ms === undefined && (step.minMs === undefined || step.maxMs === undefined)) {
      problems.push(`${at} needs either ms, or both minMs and maxMs`);
    }
  });
  return problems;
}

module.exports = {
  EXECUTORS, evaluateCondition, sleep, validateSteps,
  cdpCookieToEntry, filterCookiesByDomain,
};
