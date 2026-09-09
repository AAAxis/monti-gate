// Per-launch credentials for the generated start page, and the endpoints they
// open.
//
// The start page (ScoutHome/home.html) is a file:// document with no key and no
// way to be given one, but it offers a launch's automations as cards and shows
// whether the profile's proxy is working. This is how it asks for one of those
// automations to be run or opened in the launcher, and for that proxy to be
// re-checked.
//
// The token's safety comes from being NARROW, not from being secret. It
// authorizes exactly three things:
//
//   1. run one of THIS launch's listed automations, against THIS profile, on
//      THIS port;
//   2. re-check THIS profile's assigned proxy;
//   3. bring the launcher window to the front with one of those same
//      automations open.
//
// The third is the narrowest of them and is checked the same way the first is:
// it names an automation this launch already offers, and its entire effect is
// that a window the user already owns comes forward showing something they
// could have navigated to themselves.
//
// It cannot create, edit or delete anything, cannot read another run, cannot
// mint keys, cannot supply its own steps -- the run request carries an id and
// the workflow is looked up here -- and cannot supply its own proxy: the
// re-check request carries nothing at all, and the proxy is resolved from the
// profile on the entry. Worst case for a leaked token is someone re-running a
// workflow the user pinned, re-testing one proxy, or raising a window, in a
// session the user already has open.
//
// A token is minted on EVERY launch, including one with nothing pinned and
// nothing attached -- the proxy panel needs it. Those launches have no
// debugging port, so cdpPort is null and `automations` is empty, and an empty
// list matches no id: such a token can only re-check.
//
// It lives in its own file rather than in main.cjs so its refusal paths can be
// tested against the real code. scripts/verify-run-token.mjs drives exactly the
// handlers below; a copy of this logic living in a test would be free to drift
// from what actually ships, which for an auth path is the whole ballgame.

const crypto = require('node:crypto');
const {StringDecoder} = require('node:string_decoder');

const TTL_MS = 12 * 60 * 60 * 1000;
// 32 random bytes makes guessing a non-issue. These limits exist so the
// endpoint cannot be used to hammer the runner, and so a wrong guess costs the
// same as a right one.
const RATE = {perTokenPerMin: 10, globalPerMin: 60};
const MAX_BODY_BYTES = 4096;
// The cookie-sync routes carry whole cookie jars, not 200-byte run requests:
// their own body cap, and their own rate bucket so a busy sync can never
// starve the start page's shared limiter (or be starved by it).
const COOKIE_RATE = {perTokenPerMin: 12, globalPerMin: 120};
const COOKIE_MAX_BODY_BYTES = 10 * 1024 * 1024;
// The status poll is the one route a page hits on a timer -- the side panel asks
// roughly once a second while a run is in flight, which would exhaust RATE's ten
// per minute in ten seconds. Its own bucket, sized for that cadence plus enough
// headroom for two open panels and a burst on reconnect. Reads nothing but the
// entry's own profile, so a generous limit here buys an attacker a description of
// a run they could already see out of the window in front of them.
const STATUS_RATE = {perTokenPerMin: 150, globalPerMin: 900};

// `load` and `save` are how the map outlives this process. They are injected
// rather than done here for the same reason `now` is: this file must stay
// requireable from a test with no Electron and no disk. main.cjs supplies a
// pair backed by a 0600 file in userData -- 0600 because these entries ARE the
// credentials, not a cache of them.
//
// Persisting at all is a fix, not an optimization. The map used to be memory
// only, so quitting the launcher invalidated every open profile window's
// session instantly: the browser kept running, its next cookie push got the
// same 403 a forged token gets, and the panel told the user their session was
// "stale or invalid" when nothing about it was. A token is valid until it
// expires or its profile relaunches, and neither of those is "the launcher
// restarted".
function createRunTokens({now = () => Date.now(), load = null, save = null} = {}) {
  const tokens = new Map();

  // One sliding-window limiter per surface, from one implementation. This loop
  // existed twice before the status poll wanted a third window with a third
  // size, and three hand-copied sliding windows is how the three quietly stop
  // agreeing about what a minute is.
  //
  // Rate-limiter state is deliberately NOT restored from `load`. These buckets
  // exist to stop this process being hammered, and a process that just started
  // has not been hammered yet.
  function makeRateLimiter(config) {
    const hits = [];
    return (token) => {
      const at = now();
      while (hits.length > 0 && at - hits[0].at > 60000) {
        hits.shift();
      }
      if (hits.length >= config.globalPerMin) {
        return false;
      }
      if (hits.filter((hit) => hit.token === token).length >= config.perTokenPerMin) {
        return false;
      }
      hits.push({token, at});
      return true;
    };
  }

  const rateLimit = makeRateLimiter(RATE);
  const rateLimitCookie = makeRateLimiter(COOKIE_RATE);
  const rateLimitStatus = makeRateLimiter(STATUS_RATE);

  if (load) {
    try {
      for (const [token, entry] of load() || []) {
        if (entry && typeof token === 'string' && entry.expiresAt > now()) {
          tokens.set(token, entry);
        }
      }
    } catch (error) {
      // A corrupt or unreadable store costs every open window its session --
      // bad, but recoverable by relaunching, and far better than refusing to
      // start the API at all.
      console.warn('Scout: could not restore run tokens', error);
    }
  }

  function persist() {
    if (!save) return;
    try {
      save([...tokens.entries()]);
    } catch (error) {
      console.warn('Scout: could not persist run tokens', error);
    }
  }

  function prune() {
    const at = now();
    let dropped = false;
    for (const [token, entry] of tokens) {
      if (entry.expiresAt <= at) {
        tokens.delete(token);
        dropped = true;
      }
    }
    return dropped;
  }

  function dropForProfile(profileId) {
    let dropped = false;
    for (const [token, entry] of tokens) {
      if (entry.profileId === profileId) {
        tokens.delete(token);
        dropped = true;
      }
    }
    return dropped;
  }

  function mint({profileId, profileName, orgId, cdpPort, automations}) {
    prune();
    // One live token per profile: relaunching must not leave the previous
    // launch's token working against a window that is gone.
    dropForProfile(profileId);
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, {
      profileId,
      profileName: profileName || '',
      // Which workspace this launch was composed under. It is carried so the
      // renderer can resolve the profile against the org it actually belongs
      // to instead of whichever one happens to be active when the request
      // lands -- switching workspace with a profile window open used to break
      // that window's cookie sync until it was relaunched.
      //
      // It is NOT an authorization input, and must never be read off a request
      // body: it is stamped here, at mint time, from what the launcher already
      // knew. A caller that could name its own org would be choosing which
      // workspace to read, which is exactly what this token may not do.
      orgId: typeof orgId === 'string' ? orgId : '',
      // Null on a launch with nothing to run. Normalized here so every entry
      // holds the same shape and the run path has one thing to test.
      cdpPort: typeof cdpPort === 'number' ? cdpPort : null,
      automations: Array.isArray(automations) ? automations : [],
      expiresAt: now() + TTL_MS,
    });
    persist();
    return token;
  }

  // Resolves a request to its entry, or to a refusal.
  //
  // EVERY refusal returns the same 403 and the same body, so neither endpoint
  // is an oracle: an unknown token, an expired one, and a valid one naming an
  // automation it does not own are indistinguishable from outside. Only success
  // and rate-limiting are separable.
  //
  // The rate limiter is shared across both routes on purpose. It is there to
  // stop the token being used to hammer this process, and which of the two
  // things it is hammering with does not change that.
  function resolve(payload) {
    const token = typeof payload.runToken === 'string' ? payload.runToken : '';
    if (!rateLimit(token)) {
      return {ok: false, status: 429, body: {status: false, msg: 'Too many requests'}};
    }
    prune();
    const entry = tokens.get(token);
    if (!entry) {
      return {ok: false, status: 403, body: {status: false, msg: 'Not allowed'}};
    }
    return {ok: true, entry};
  }

  function authorize(payload) {
    const verdict = resolve(payload);
    if (!verdict.ok) {
      return verdict;
    }
    const automation = verdict.entry.automations.find((item) => item.id === payload.automationId);
    // Same refusal as an unknown token, deliberately: naming an automation this
    // launch does not offer must not be distinguishable from holding a token
    // that was never valid.
    if (!automation) {
      return {ok: false, status: 403, body: {status: false, msg: 'Not allowed'}};
    }
    return {ok: true, entry: verdict.entry, automation};
  }

  // Re-checking needs no id: the proxy is the one assigned to the profile on
  // the entry, so there is nothing in the request for a caller to choose. That
  // is what makes this safe to open to a document with no key -- it is not a
  // proxy-testing endpoint, it is "re-check the thing this page is showing".
  function authorizeRecheck(payload) {
    return resolve(payload);
  }

  // resolve()'s shape against a different bucket. Same refusal semantics --
  // still not an oracle -- and the SAME reason the buckets are separate: a busy
  // cookie sync must not be able to starve the start page's run button, and a
  // once-a-second status poll must not be able to starve either.
  function resolveIn(limiter, payload) {
    const token = typeof payload.runToken === 'string' ? payload.runToken : '';
    if (!limiter(token)) {
      return {ok: false, status: 429, body: {status: false, msg: 'Too many requests'}};
    }
    prune();
    const entry = tokens.get(token);
    if (!entry) {
      return {ok: false, status: 403, body: {status: false, msg: 'Not allowed'}};
    }
    return {ok: true, entry};
  }

  // The cookie-sync twin of resolve(): same refusal semantics, its own bucket.
  function authorizeCookieSync(payload) {
    return resolveIn(rateLimitCookie, payload);
  }

  // Reading this launch's own run needs no id, for the same reason re-checking
  // the proxy does not: the run is looked up by the profile on the entry, so
  // there is nothing in the request for a caller to choose. Its own bucket
  // because it is the one route that arrives on a timer.
  function authorizeStatus(payload) {
    return resolveIn(rateLimitStatus, payload);
  }

  // Stopping a run names no run either -- the runner is asked for whatever is in
  // flight against THIS entry's profile, so a leaked token cannot stop a run on
  // some other profile even by guessing its id. On the ordinary bucket: this is
  // a button someone presses, not a poll.
  function authorizeCancel(payload) {
    return resolve(payload);
  }

  // Running a workflow this launch was NOT handed.
  //
  // This is the one authorizer that deliberately does less than authorize()
  // above, and it is worth being explicit about what that costs. authorize()
  // checks the named automation against entry.automations, so a leaked token
  // could only ever re-run something a person had already pinned or assigned to
  // this profile. This one checks nothing but the token, so it can run anything
  // in the workspace the token was minted under -- including workflows carrying
  // connector credentials and secret parameter values.
  //
  // That widening is the deliberate product decision behind the side panel's
  // team-wide automations list; it is not an oversight, and it is not a
  // property to give away again by accident. What is NOT widened:
  //
  //   - The workspace. orgId still comes off the entry, stamped at mint time.
  //     A caller cannot reach another org's workflows by naming one.
  //   - The profile. It comes off the entry too, so the run still happens in
  //     the window this token was minted for.
  //   - The refusal. An unknown token and an expired one are still the same
  //     403 as everything else on this file.
  //
  // The id itself is validated in the renderer, against the token's own
  // workspace -- see the panel-resolve-automation handler in
  // useAutomationBridge.ts. It is request DATA here, exactly like `saveAs`.
  //
  // Ordinary bucket rather than the status one: this is a button someone
  // presses, and it costs a browser automation run.
  function authorizeRunAny(payload) {
    return resolve(payload);
  }

  // Raising the launcher window may name one of this launch's automations, or
  // nothing at all -- "just show me the Automations tab for this profile", which
  // is the only thing the side panel's empty state can usefully offer. Naming
  // one is authorized exactly as running it is; naming none authorizes nothing
  // beyond holding a valid token, and its entire effect is that a window the
  // user already owns comes forward.
  function authorizeOpen(payload) {
    const named = typeof payload.automationId === 'string' && payload.automationId !== '';
    return named ? authorize(payload) : resolve(payload);
  }

  // The mutating members persist; the read paths do not, even though prune()
  // inside them can delete. An expired entry that survives in the file is
  // re-pruned on the next load (and is refused in the meantime by the same
  // prune the authorizers already run), so writing the file on every request
  // would buy nothing and put a disk write on the hot path.
  return {
    authorize,
    authorizeCancel,
    authorizeCookieSync,
    authorizeOpen,
    authorizeRecheck,
    authorizeRunAny,
    authorizeStatus,
    clear: () => {
      tokens.clear();
      persist();
    },
    dropForProfile: (profileId) => {
      if (dropForProfile(profileId)) persist();
    },
    mint,
    prune: () => {
      if (prune()) persist();
    },
    size: () => tokens.size,
  };
}

// The shared half of both page routes: reject anything that is not a JSON POST
// from the page, read a bounded body, authorize it, and hand the entry to the
// work. `authorizeWith` names which of the two token checks applies and `work`
// does the rest; both are injected so this file needs neither the runner, nor
// the proxy checker, nor Electron.
function handlePageRequest({req, res, tokens, sendJson, authorizeWith, work, maxBodyBytes = MAX_BODY_BYTES}) {
  // A cross-origin <form> POST cannot set this, so requiring it means a hostile
  // page has to send a preflight first. That is a speed bump and not a wall:
  // the loopback server answers OPTIONS for every path with
  // Access-Control-Allow-Origin: *, so the preflight passes. This comment used
  // to claim the opposite -- that the preflight went unanswered -- and reading
  // it that way is how the real gate got left implicit.
  //
  // The real gate is the run token below. It is minted per launch, written only
  // into that profile's own user-data-dir at 0600, and names nothing the caller
  // may choose: every one of these routes takes its profile off the token's
  // entry rather than off the request body. A page that cannot read that file
  // cannot reach any of this, however cleanly its preflight is answered.
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.includes('application/json')) {
    sendJson(res, 403, {status: false, msg: 'Not allowed'});
    return;
  }
  let body = '';
  let bytes = 0;
  // `body.length` after `body += chunk` counts UTF-16 code units, not wire
  // bytes -- multi-byte characters would let the cap admit up to ~3x its
  // stated size, and coercing each Buffer to a string independently can split
  // a multi-byte character across a socket-read boundary, corrupting it to
  // U+FFFD without JSON.parse ever noticing. `bytes` is measured off the raw
  // chunks, and StringDecoder holds back any trailing partial character until
  // the bytes that complete it arrive.
  const decoder = new StringDecoder('utf8');
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBodyBytes) {
      req.destroy();
      return;
    }
    body += decoder.write(chunk);
  });
  req.on('end', async () => {
    body += decoder.end();
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      sendJson(res, 403, {status: false, msg: 'Not allowed'});
      return;
    }
    // JSON.parse accepts any JSON value, not just objects -- a body of `null`
    // parses cleanly and would otherwise be dereferenced below with nothing to
    // catch the crash, killing the process rather than answering the request.
    // Same refusal as every other auth failure: this must not be an oracle
    // either.
    if (!payload || typeof payload !== 'object') {
      sendJson(res, 403, {status: false, msg: 'Not allowed'});
      return;
    }
    const verdict = tokens[authorizeWith](payload);
    if (!verdict.ok) {
      sendJson(res, verdict.status, verdict.body);
      return;
    }
    try {
      sendJson(res, 200, {status: true, ...await work(verdict, payload)});
    } catch (error) {
      // A failure from the work itself is an answer the page can show, unlike
      // the refusals above: the caller already proved it holds a valid token,
      // so there is nothing left to leak. (409 and 429 from the runner, a dead
      // proxy from the checker.)
      sendJson(res, error?.status || 500,
          {status: false, msg: error?.message || 'The request did not complete'});
    }
  });
}

// Runs one of this launch's automations. `startRun` returns the run id.
function handleRunFromPage({req, res, tokens, sendJson, startRun}) {
  handlePageRequest({
    req,
    res,
    tokens,
    sendJson,
    authorizeWith: 'authorize',
    work: async ({entry, automation}) => ({runId: await startRun(entry, automation)}),
  });
}

// Every automation in the workspace this launch was minted under, for the side
// panel's Automations tab.
//
// The panel's list used to be the launch snapshot -- org-pinned workflows plus
// the profile's own -- frozen in a JSON file before the browser process even
// existed. A teammate's workflow created mid-session never appeared, and
// neither did anything nobody had thought to pin.
//
// Body is `{runToken}` and nothing else: no profile id, no org id, no filter.
// Both come off the entry, which is the property that makes these routes safe
// to expose to a keyless document. This route widens WHAT is listed; it does
// not widen who gets to ask.
//
// What comes back is decided in the renderer, not here, and it is metadata:
// name, description, whether it is pinned or assigned, icon and colour. Steps,
// variables and parameters never travel -- they carry selectors, urls, typed
// values and resolved secrets, and this answer lands in a document that goes on
// to visit arbitrary sites.
//
// On the status bucket (150/token/min) rather than the ordinary one: the panel
// refetches this whenever its Automations tab is opened, and it must not be
// able to starve the run button.
function handleAutomationListFromPage({req, res, tokens, sendJson, listAutomations}) {
  handlePageRequest({
    req,
    res,
    tokens,
    sendJson,
    authorizeWith: 'authorizeStatus',
    work: async ({entry}) => await listAutomations(entry),
  });
}

// Runs a workflow this launch was NOT handed -- the other half of the list
// above, since a list you cannot act on is a tease.
//
// Kept as its own route rather than loosening handleRunFromPage, so the narrow
// path stays narrow and keeps working with the launcher window closed: it needs
// nothing but the token entry, while this one cannot resolve an automation
// without a renderer round trip (the entry holds no steps, no called
// automations, no variables and no secret names for anything that was not in
// it). See authorizeRunAny for exactly what this widens and what it does not.
//
// `automationId` is request DATA, type-checked here and validated for real in
// the renderer against the token's own workspace -- the same division of labour
// `saveAs` has on the cookie push route.
function handleRunAnyFromPage({req, res, tokens, sendJson, startAnyRun}) {
  handlePageRequest({
    req,
    res,
    tokens,
    sendJson,
    authorizeWith: 'authorizeRunAny',
    work: async ({entry}, payload) => {
      const automationId =
        typeof payload.automationId === 'string' ? payload.automationId : '';
      if (!automationId) {
        throw Object.assign(new Error('No automation named'), {status: 400});
      }
      return {runId: await startAnyRun(entry, automationId)};
    },
  });
}

// Raises the launcher window with one of this launch's automations open.
//
// Same authorization as the narrow run route, deliberately: naming an
// automation this launch does not offer is refused identically to holding a
// token that was never valid.
//
// This used to be justified as "so this cannot be used to probe which workflows
// an org has". That is no longer the property being defended, and pretending
// otherwise would leave a comment guarding a door that
// handleAutomationListFromPage below now opens on purpose: the side panel lists
// every workflow in the launch's workspace, because a panel that can only show
// what one launch was handed cannot show a team anything. What is still true,
// and is what this refusal is for, is that the SHAPE of the check does not vary
// with the reason it failed -- an unknown token, an expired one and a valid one
// naming something outside its workspace are one 403 with one body.
//
// `open` does not wait for the launcher's renderer to acknowledge anything.
// The window is raised by the main process either way, and the caller is a
// start page whose only feedback for success is a different window arriving in
// front of it -- making it wait on a renderer round trip (the way the re-check
// route has to, because it has an answer to return) would buy nothing but a
// timeout to handle.
// `automation` is null when the request named none -- see authorizeOpen. `open`
// is expected to read that as "the Automations tab, no particular workflow".
function handleOpenInLauncherFromPage({req, res, tokens, sendJson, open}) {
  handlePageRequest({
    req,
    res,
    tokens,
    sendJson,
    authorizeWith: 'authorizeOpen',
    work: ({entry, automation}) => {
      open(entry, automation || null);
      return {};
    },
  });
}

// What is running against this launch's profile, for the side panel's
// Automations tab. Polled, so `status` is expected to answer with something
// small -- compact records, never a step log.
//
// The shape of that answer is deliberately not decided here: this file knows
// about tokens and refusals, and main.cjs knows what a run looks like. It is
// passed through as the response body.
//
// Scoped to the entry's profile rather than to the entry's automations list, and
// that widening is on purpose. A run started from the launcher's own window, from
// a schedule, or by an MCP tool is exactly as relevant to the person watching
// this window as one they started from the panel -- and reporting it reveals
// nothing they cannot see happening in front of them. Starting a run stays
// narrow (handleRunFromPage still requires a named, offered automation); only
// watching one is broad.
function handleRunStatusFromPage({req, res, tokens, sendJson, status}) {
  handlePageRequest({
    req,
    res,
    tokens,
    sendJson,
    authorizeWith: 'authorizeStatus',
    work: ({entry}) => status(entry),
  });
}

// Stops whatever is running against this launch's profile. Named nothing, so
// there is nothing for a caller to choose; `cancel` returns whether there was
// anything to stop, which the panel reports rather than treating as a failure --
// a run that finished a moment before the click is not an error.
function handleCancelRunFromPage({req, res, tokens, sendJson, cancel}) {
  handlePageRequest({
    req,
    res,
    tokens,
    sendJson,
    authorizeWith: 'authorizeCancel',
    work: ({entry}) => ({cancelled: Boolean(cancel(entry))}),
  });
}

// Re-checks this launch's assigned proxy. `recheck` returns the panel's next
// {proxyOk, title, detail, fields} -- composed by homeProxyStatus in the
// renderer, the same function that wrote the wording the page launched with.
// `fields` is the labelled readout (exit, location, timezone, device); the page
// rebuilds those rows from it, since a re-check that moves the exit moves every
// row under it.
function handleRecheckFromPage({req, res, tokens, sendJson, recheck}) {
  handlePageRequest({
    req,
    res,
    tokens,
    sendJson,
    authorizeWith: 'authorizeRecheck',
    work: ({entry}) => recheck(entry),
  });
}

// Saves a running profile's live cookie jar into the launcher. The profile is
// the token entry's own -- the payload names no profile, so a leaked token can
// only ever write to the launch it was minted for.
//
// `saveAs` and `saveToSetId` are the two optional fields this route accepts,
// and they are alternatives:
//
//   - `saveAs` is a user-chosen NAME, turning this push into a library save (a
//     new, named set) instead of the default live-set sync.
//   - `saveToSetId` is an existing set's id, turning it into an overwrite of
//     that set. Behind a confirmation in the panel, never reachable from the
//     automatic push loop, and with no undo once it lands.
//
// Both are request DATA, not authorization inputs -- same as `cookies` -- so
// both get the same treatment: type-checked here (a string, or dropped), never
// trusted as anything more. The real validation happens once, in
// useAutomationBridge.ts: sanitizeSetName decides what a valid name is, and the
// workspace's own set list decides what a reachable id is. Neither decision
// belongs in this file, which knows about tokens and refusals and nothing else.
function handleCookiePushFromPage({req, res, tokens, sendJson, pushCookies}) {
  handlePageRequest({
    req, res, tokens, sendJson,
    authorizeWith: 'authorizeCookieSync',
    maxBodyBytes: COOKIE_MAX_BODY_BYTES,
    work: async ({entry}, payload) => {
      const cookies = Array.isArray(payload.cookies) ? payload.cookies : [];
      const saveAs = typeof payload.saveAs === 'string' ? payload.saveAs : undefined;
      const saveToSetId =
        typeof payload.saveToSetId === 'string' ? payload.saveToSetId : undefined;
      return await pushCookies(entry, cookies, saveAs, saveToSetId);
    },
  });
}

// Hands a cookie set back to this launch's running browser, for "Load from
// Launcher" without a relaunch.
//
// `setId`, when present, picks a set the profile is NOT assigned to -- the side
// panel's picker over the workspace's whole library. Absent means the assigned
// set, which is what every caller before that picker did.
//
// This is the field that breaks the old rule these routes were written under,
// and the break is deliberate rather than accidental, so it is worth writing
// down what replaced it. The rule was: the body is `{runToken}` and nothing
// else, so there is nothing in a request for a caller to CHOOSE. A picker is
// exactly a choice. What makes it safe is not the token layer -- an id is
// type-checked here and no more -- but the renderer, which resolves the id
// against the set list of the workspace the token was minted under and refuses
// anything else. Not RLS: RLS would also refuse another org's set, but only
// because the signed-in user is not a member of it, so a bug in orgId plumbing
// would become a cross-org read the moment they belonged to both.
function handleCookiePullFromPage({req, res, tokens, sendJson, pullCookies}) {
  handlePageRequest({
    req, res, tokens, sendJson,
    authorizeWith: 'authorizeCookieSync',
    work: async ({entry}, payload) => {
      const setId = typeof payload.setId === 'string' ? payload.setId : undefined;
      return await pullCookies(entry, setId);
    },
  });
}

// Read-only: what the launcher holds, WITHOUT applying it.
//
// The pull route above answers the same question but the panel can only ask it
// by taking the answer -- it imports the set into the live jar. So a user who
// wanted to know what "Load from Launcher" was about to do had to do it and
// find out, on a button whose own hint says it replaces this browser's cookies.
// This is the look-before-you-leap half, and with a picker it matters more, not
// less: the set about to be applied may be one this profile has never used.
//
// Takes the same optional `setId` as the pull, validated the same way in the
// renderer. Metadata only either way -- never cookie values.
//
// The default body cap applies rather than the 10 MB cookie one: this request
// carries a token and an id. Only pushes need the large cap.
function handleCookieListFromPage({req, res, tokens, sendJson, listCookies}) {
  handlePageRequest({
    req, res, tokens, sendJson,
    authorizeWith: 'authorizeCookieSync',
    work: async ({entry}, payload) => {
      const setId = typeof payload.setId === 'string' ? payload.setId : undefined;
      return await listCookies(entry, setId);
    },
  });
}

// Every cookie set in the workspace this launch was minted under, so the panel
// can offer a picker rather than one button wired to one set.
//
// Body is `{runToken}` and nothing else -- this is the route that TELLS the
// caller what ids exist, so it has nothing to choose from yet. Metadata only:
// names, counts, filing and timestamps, never a payload and never a cookie
// value. The renderer reads it straight from the database rather than the
// window's cached state, because the launcher window is by definition not
// focused while someone is looking at a browser side panel.
function handleCookieSetsFromPage({req, res, tokens, sendJson, listSets}) {
  handlePageRequest({
    req, res, tokens, sendJson,
    authorizeWith: 'authorizeCookieSync',
    work: async ({entry}) => await listSets(entry),
  });
}

module.exports = {
  COOKIE_MAX_BODY_BYTES,
  COOKIE_RATE,
  MAX_BODY_BYTES,
  RATE,
  STATUS_RATE,
  TTL_MS,
  createRunTokens,
  handleAutomationListFromPage,
  handleCancelRunFromPage,
  handleCookieListFromPage,
  handleCookiePullFromPage,
  handleCookiePushFromPage,
  handleCookieSetsFromPage,
  handleOpenInLauncherFromPage,
  handleRecheckFromPage,
  handleRunAnyFromPage,
  handleRunFromPage,
  handleRunStatusFromPage,
};
