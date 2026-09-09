// The tool surface an agent actually sees.
//
// Two rules shaped this list:
//
// 1. Every tool takes `profileId` and nothing session-shaped. No cdpUrl, no
//    handle, no cursor. The server resolves the debugging port on each call
//    through /v1/profiles/cdp, so a restarted launcher, a restarted agent and a
//    restarted MCP process are all non-events.
// 2. Only what an agent has a real reason to do. Every tool listed here costs
//    context in *every* session for these users, so the bulk-import routes
//    (proxies/create, cookies/*, monitoring/report) stay HTTP-only.
//
//    profiles/create, update-fingerprint and profiles/delete WERE in that set
//    and are now exposed, at the owner's explicit request -- profile creation
//    and editing was the largest "the app can, the agent cannot" gap. Delete is
//    soft-only here (scout_delete_profile never sends permanent: true); a purge
//    stays in the app. When the toolPacks model from the 2026-08-05 design
//    lands, update-fingerprint and delete belong in its default-off
//    `destructive` pack.

const cdp = require('./cdp.cjs');
const {routes: apiRoutes} = require('../api/routes.json');

const DEFAULT_READ_CHARS = 20000;

// Resolving the port is its own step so every CDP tool fails the same way when
// the profile simply is not open -- which is by far the most common mistake.
async function requireCdpUrl(api, profileId) {
  const session = await api.post('/v1/profiles/cdp', {profileId});
  if (!session.running || !session.cdpUrl) {
    throw new Error(
        `Profile ${profileId} is not open. Call scout_launch_profile first.`);
  }
  return session.cdpUrl;
}

function text(value) {
  return {
    content: [{
      type: 'text',
      text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
    }],
  };
}

const TOOLS = [
  {
    name: 'scout_list_profiles',
    description:
      'List the Scout browser profiles this key can see. Each profile is an ' +
      'isolated browser identity with its own proxy, fingerprint and cookies.',
    inputSchema: {
      type: 'object',
      properties: {
        folder: {type: 'string', description: 'Only profiles in this folder id.'},
      },
    },
    run: async ({api, args}) => text(await api.get(
        args.folder ? `/v1/profiles?folder=${encodeURIComponent(args.folder)}` : '/v1/profiles')),
  },
  {
    name: 'scout_get_profile',
    description: 'Read one profile: its proxy, status, tags, folder and fingerprint.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}},
      required: ['profileId'],
    },
    run: async ({api, args}) => text(await api.post('/v1/profiles/get', {profileId: args.profileId})),
  },
  {
    name: 'scout_profile_session',
    description:
      'Check whether a profile is currently open for automation, and where its ' +
      'debugging endpoint is. Call this before launching to avoid disturbing a ' +
      'session that is already running.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}},
      required: ['profileId'],
    },
    run: async ({api, args}) => text(await api.post('/v1/profiles/cdp', {profileId: args.profileId})),
  },
  {
    name: 'scout_launch_profile',
    // Two earlier sentences here were simply untrue, and a false statement in a
    // tool description is worse than no statement: the model plans around it.
    // "The browser session is anonymous" is wrong whenever the profile has a
    // cookie set assigned, which is a normal setup. And a claim that a proxy is
    // always required is wrong too -- proxy_mode is 'assigned' | 'direct' |
    // 'free_proxy', and only the first requires one.
    description:
      'Open a profile in the Scout browser, ready for automation. If it is ' +
      'already open this returns the existing session rather than restarting ' +
      'it; pass relaunch=true to force a fresh window (which closes the current ' +
      'one). A profile set to use an assigned proxy needs that proxy to be ' +
      'working before it will launch. The session carries whatever identity the ' +
      'profile already holds, including its cookies — do not send it anything ' +
      'the profile is not meant to have.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {type: 'string'},
        relaunch: {
          type: 'boolean',
          description: 'Close any existing session and start a new one.',
        },
      },
      required: ['profileId'],
    },
    run: async ({api, args}) => text(await api.post('/v1/profiles/launch-automation', {
      profileId: args.profileId,
      relaunch: Boolean(args.relaunch),
    })),
  },
  {
    name: 'scout_close_profile',
    description: 'Close a profile session this key opened.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}},
      required: ['profileId'],
    },
    run: async ({api, args}) => text(await api.post('/v1/profiles/close-automation', {
      profileId: args.profileId,
    })),
  },
  // scout_create_profile is generated from the /v1/profiles/create route in
  // routes.json (it carries a `channel`, so the generator builds its schema from
  // the route's `fields`). It must NOT be hand-written here too -- a second
  // definition of the same name shadows the generated one in BY_NAME and the
  // verify script fails on the duplicate. Fingerprint and delete are the reverse
  // case: their routes have no channel, so they ARE hand-written below.
  {
    name: 'scout_update_profile',
    // `notes` used to be advertised here and silently did nothing -- the route's
    // field whitelist has no such column, so an agent could report success on a
    // write that never happened.
    description:
      'Change a profile\'s name, status, tags, colour, avatar, folder, proxy mode, ' +
      'start URL, login URL or launch automation. Assigning a specific proxy is a separate ' +
      'call (scout_assign_proxy); setting proxyMode to direct or free_proxy here ' +
      'clears whatever proxy the profile was on.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {type: 'string'},
        name: {type: 'string'},
        status: {type: 'string'},
        tags: {type: 'array', items: {type: 'string'},
          description: 'At most 5; extras are dropped.'},
        color: {type: 'string'},
        avatar: {type: 'string',
          description: 'The mark shown beside the name: "brand:<slug>" for one of the ' +
            'built-in site logos (brand:instagram, brand:facebook, brand:x, brand:tiktok, ' +
            '…), or "" to go back to the initials. Uploaded pictures are set in the app.'},
        folderId: {type: 'string'},
        proxyMode: {type: 'string',
          description: 'assigned, direct or free_proxy. assigned requires the profile ' +
            'to already have a proxy (use scout_assign_proxy to set one); direct and ' +
            'free_proxy clear it.'},
        startUrl: {type: 'string',
          description: 'URL the profile opens on launch. "" to clear.'},
        loginUrl: {type: 'string',
          description: 'The sign-in page this profile\'s stored email/password belong ' +
            'to. A note, not an action — nothing fills the form in; an automation reads ' +
            'it as {{profile.login_url}}. "" to clear. Distinct from startUrl, which is ' +
            'where a launch lands.'},
        automationId: {type: 'string',
          description: 'Automation to run on every launch (scout_list_automations). ' +
            '"" to detach.'},
        automationVars: {type: 'object',
          description: 'This profile\'s answers to automations\' declared parameters, ' +
            'keyed by automation id: {"<automationId>": {"city_name": "Dortmund"}}. ' +
            'This is how one automation runs a different city per profile. Replaces ' +
            'the whole map, so read it back with scout_get_profile and merge rather ' +
            'than sending one automation on its own. Values for a parameter the ' +
            'automation no longer declares are ignored at run time. See ' +
            'scout_automation_schema for the parameter vocabulary.'},
      },
      required: ['profileId'],
    },
    // Forwards only the declared fields. This used to pass `args` straight
    // through, and the route also accepts `email` and `password` -- so an agent
    // that guessed those names could rewrite a profile's stored credentials
    // through a tool whose schema never mentions them. Anything undeclared is
    // dropped here rather than relied on being rejected downstream.
    //
    // `loginUrl` is deliberately on the list while those two stay off it: it
    // records where a credential is used, not what it is, so an agent setting it
    // cannot lock anybody out of anything.
    run: async ({api, args}) => {
      const patch = {profileId: args.profileId};
      for (const field of ['name', 'status', 'tags', 'color', 'avatar', 'folderId',
        'proxyMode', 'startUrl', 'loginUrl', 'automationId', 'automationVars']) {
        if (args[field] !== undefined) {
          patch[field] = args[field];
        }
      }
      return text(await api.post('/v1/profiles/update', patch));
    },
  },
  {
    name: 'scout_update_fingerprint',
    description:
      'Change parts of a profile\'s fingerprint. The fields you send are merged into ' +
      'the stored fingerprint; anything you omit keeps its value. Read the current ' +
      'one with scout_get_profile first. Changing the device identity of a profile ' +
      'that is holding a logged-in session looks exactly like a stolen cookie and ' +
      'can get the session challenged -- prefer a new profile for a new identity.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {type: 'string'},
        fingerprint: {
          type: 'object',
          description: 'The fingerprint fields to change. Any subset of these.',
          properties: {
            os: {type: 'string',
              description: 'Windows 11, Windows 10, macOS, Ubuntu, Android or iOS.'},
            browser_version: {type: 'string'},
            user_agent: {type: 'string'},
            language: {type: 'string'},
            timezone: {type: 'string'},
            geolocation: {type: 'string'},
            webrtc: {type: 'string', description: 'Proxy only, Disabled, Real or Custom.'},
            canvas: {type: 'string', description: 'Real, Noise or Block.'},
            webgl: {type: 'string', description: 'Real, Noise or Block.'},
            webgpu: {type: 'string', description: 'Real or Block.'},
            client_rects: {type: 'string', description: 'Real, Noise or Block.'},
            audio: {type: 'string', description: 'Real, Noise or Block.'},
            webgl_vendor: {type: 'string'},
            webgl_renderer: {type: 'string'},
            screen: {type: 'string', description: 'Auto, or a size like 1920x1080.'},
            cpu_model: {type: 'string'},
            cpu_cores: {type: 'number'},
            memory_gb: {type: 'number'},
            media_devices: {type: 'string'},
            do_not_track: {type: 'boolean'},
            rotate_on_launch: {type: 'boolean',
              description: 'Re-roll the noise seeds on every launch. Unsafe for a ' +
                'profile that is holding a session.'},
          },
        },
      },
      required: ['profileId', 'fingerprint'],
    },
    // The renderer merges whatever keys arrive into the stored JSON, so the
    // enumerated whitelist here is the layer that stops a guessed key landing in
    // the fingerprint. Kept in step with ScoutProfile['fingerprint'] in types.ts.
    run: async ({api, args}) => {
      const FP_KEYS = ['os', 'browser_version', 'user_agent', 'language', 'timezone',
        'geolocation', 'webrtc', 'canvas', 'webgl', 'webgpu', 'client_rects', 'audio',
        'webgl_vendor', 'webgl_renderer', 'screen', 'cpu_model', 'cpu_cores', 'memory_gb',
        'media_devices', 'do_not_track', 'rotate_on_launch'];
      const fingerprint = {};
      const sent = args.fingerprint || {};
      for (const key of FP_KEYS) {
        if (sent[key] !== undefined) {
          fingerprint[key] = sent[key];
        }
      }
      return text(await api.post('/v1/profiles/update-fingerprint', {
        profileId: args.profileId,
        fingerprint,
      }));
    },
  },
  {
    name: 'scout_delete_profile',
    description:
      'Move a profile to Trash, where the app can restore it. This does not remove ' +
      'the profile\'s on-disk browser data. Permanent deletion is only available in ' +
      'the app, not over this tool.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}},
      required: ['profileId'],
    },
    // Soft delete only. The route accepts `permanent: true`, but this tool never
    // sends it -- an irreversible, no-Trash purge is not something an agent
    // should be able to do from a one-line call.
    run: async ({api, args}) => text(await api.post('/v1/profiles/delete', {
      profileId: args.profileId,
    })),
  },
  {
    name: 'scout_list_proxies',
    description: 'List the proxies in this account\'s library.',
    inputSchema: {type: 'object', properties: {}},
    run: async ({api}) => text(await api.get('/v1/proxies')),
  },
  {
    name: 'scout_assign_proxy',
    description:
      'Put a profile on a proxy from the library. A profile whose proxy mode is ' +
      '"assigned" needs a working proxy before it will launch.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}, proxyId: {type: 'string'}},
      required: ['profileId', 'proxyId'],
    },
    run: async ({api, args}) => text(await api.post('/v1/profiles/assign-proxy', {
      profileId: args.profileId,
      proxyId: args.proxyId,
    })),
  },
  {
    name: 'scout_check_proxy',
    description: 'Check a proxy\'s reachability and egress IP.',
    inputSchema: {
      type: 'object',
      properties: {
        host: {type: 'string'},
        port: {type: 'number'},
        username: {type: 'string'},
        password: {type: 'string'},
        type: {type: 'string', description: 'http or socks5. Defaults to http.'},
      },
      required: ['host', 'port'],
    },
    // Declared fields only, for the same reason as scout_update_profile.
    run: async ({api, args}) => text(await api.post('/v1/proxies/check', {
      host: args.host,
      port: args.port,
      type: args.type,
      username: args.username,
      password: args.password,
    })),
  },
  {
    name: 'scout_list_tabs',
    description: 'List the open pages in a running profile.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}},
      required: ['profileId'],
    },
    run: async ({api, args}) => text(await cdp.tabs(await requireCdpUrl(api, args.profileId))),
  },
  {
    name: 'scout_navigate',
    description: 'Point a running profile\'s active page at a URL and wait for it to settle.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}, url: {type: 'string'}},
      required: ['profileId', 'url'],
    },
    run: async ({api, args}) => text(
        await cdp.navigate(await requireCdpUrl(api, args.profileId), args.url)),
  },
  {
    name: 'scout_read_page',
    description:
      'Read the visible text of a running profile\'s active page, with its title ' +
      'and URL. Use a CSS selector to read one region instead of the whole page.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {type: 'string'},
        selector: {type: 'string', description: 'CSS selector; defaults to the whole body.'},
        maxChars: {type: 'number', description: `Defaults to ${DEFAULT_READ_CHARS}.`},
      },
      required: ['profileId'],
    },
    run: async ({api, args}) => text(await cdp.readPage(
        await requireCdpUrl(api, args.profileId),
        args.selector || null,
        Number(args.maxChars) > 0 ? Math.floor(args.maxChars) : DEFAULT_READ_CHARS)),
  },
  {
    name: 'scout_screenshot',
    description:
      'Screenshot a running profile\'s active page. Returns JPEG by default; ' +
      'pass png=true for a lossless capture.',
    inputSchema: {
      type: 'object',
      properties: {
        profileId: {type: 'string'},
        fullPage: {type: 'boolean'},
        png: {type: 'boolean'},
      },
      required: ['profileId'],
    },
    run: async ({api, args}) => {
      const shot = await cdp.screenshot(await requireCdpUrl(api, args.profileId), {
        fullPage: Boolean(args.fullPage),
        png: Boolean(args.png),
      });
      // The caption is not decoration: some clients drop image content
      // entirely, and a bare image with no text is useless in a transcript.
      return {
        content: [
          {type: 'text', text: `${shot.url || 'about:blank'} — ${shot.title || 'untitled'}`},
          {type: 'image', data: shot.data, mimeType: shot.mimeType},
        ],
      };
    },
  },
  {
    name: 'scout_eval',
    description:
      'Evaluate a JavaScript expression in a running profile\'s active page and ' +
      'return its value. Awaits promises.',
    inputSchema: {
      type: 'object',
      properties: {profileId: {type: 'string'}, expression: {type: 'string'}},
      required: ['profileId', 'expression'],
    },
    run: async ({api, args}) => text(
        await cdp.evaluate(await requireCdpUrl(api, args.profileId), args.expression)),
  },
];

// ── The automations tools ────────────────────────────────────────────────────
// Generated from the route table rather than written out one by one. The table
// already carries the path, the method, the field list and the description, and
// a hand-written copy of those is exactly the drift this table was added to
// stop -- the profiles and proxies tools above are still hand-written, and the
// catalogue they duplicate had already fallen out of step with what main.cjs
// routes.

function inputSchemaFor(route) {
  const properties = {};
  const required = [];
  for (const field of route.fields || []) {
    // A step tree is an array of objects whose real shape lives in
    // step-schema.json. Inlining that here would put 184 lines of catalogue
    // into every session's context; the description points at the tool that
    // returns it on demand instead.
    properties[field.key] =
      field.type === 'steps' || field.type === 'objects' ?
        {type: 'array', items: {type: 'object'}, description: field.description} :
      // Two names for one shape -- see ApiFieldType in src/api/routes.ts.
      field.type === 'tags' || field.type === 'strings' ?
        {type: 'array', items: {type: 'string'}, description: field.description} :
        {type: field.type, description: field.description};
    if (field.required) {
      required.push(field.key);
    }
  }
  return {type: 'object', properties, required};
}

// The step catalogue, cut down to what an agent needs to write a valid step:
// the type, what it is called, and its fields with the required ones marked.
// The full spec -- hints, placeholders, patterns, showWhen -- stays behind
// GET /v1/automations/schema for anything that needs it.
// What an automation may ask for before it runs, told the same way the step
// catalogue is: an agent that has to guess a `kind` writes a parameter the
// editor cannot render.
//
// Kept beside compactSchema deliberately -- both answer "what vocabulary am I
// writing in", and an agent gets them in one call.
const PARAMETER_VOCABULARY = {
  shape: 'parameters: [{name, kind, label?, required?, default?, options?, hint?, placeholder?}]',
  name: 'Matches ^[A-Za-z_][A-Za-z0-9_]*$. Read from any interpolated step ' +
    'field as {{vars.<name>}}.',
  kinds: {
    text: 'One line.',
    textarea: 'Several lines, still one string.',
    number: 'Coerced to a number at run time.',
    boolean: 'Always answered, so it may not be required.',
    select: 'One of `options`, which is required and must not be empty.',
    secret: 'Hidden in the UI and masked in run history. Stored as plain text.',
    list: 'One value per line, coerced to a real array -- feed it to a loop ' +
      'step as items: "{{vars.<name>}}".',
  },
  resolution: 'Weakest first: the callee defaults of any callAutomation target, ' +
    "then this automation's `default`, then the profile's own value " +
    '(scout_update_profile automationVars), then the `vars` passed to ' +
    'scout_run_automation. A blank never overrides -- it falls through.',
  required: 'A run with no value and no default is refused before the browser ' +
    'opens, naming the profile and the parameter.',
  limits: 'At most 20 per automation.',
};

function compactSchema(steps) {
  return Object.entries(steps).map(([type, spec]) => ({
    type,
    label: spec.label,
    summary: spec.summary,
    fields: (spec.fields || []).map((field) => {
      const parts = [`${field.key}: ${field.kind}`];
      if (field.required) {
        parts.push('required');
      }
      if (field.options) {
        parts.push(`one of ${field.options.join('|')}`);
      }
      if (field.kind === 'steps') {
        parts.push('nested steps');
      }
      // The `connector` kind is the one place `key: kind` says nothing usable.
      // Its category is what decides which connectors are even legal here -- a
      // notify step must not name a model and an aiPrompt must not name a bot
      // -- and leaving it empty is a real choice, not an omission. Dropping
      // both left an agent knowing the field exists and nothing about what
      // goes in it, which is how five invented ids got tried in a row.
      if (field.kind === 'connector') {
        parts.push(`${field.category || 'any'} connector id from scout_list_connectors`);
        parts.push('blank uses the workspace default for that category');
      }
      return parts.join(', ');
    }),
  }));
}

// `channel || local`, not `mcp`. Nine of the routes above also carry an `mcp`
// name -- they are the hand-written tools, cross-referenced there so the agent
// brief can list every tool from one file -- and filtering on `mcp` alone
// generated a second, field-less copy of each of them. tools/list answered with
// thirty tools and BY_NAME resolved scout_update_profile to the generated one,
// which forwards no fields at all.
const AUTOMATION_TOOLS = apiRoutes
    .filter((route) => route.mcp && (route.channel || route.local))
    .map((route) => ({
  name: route.mcp,
  description: route.mcpDescription,
  inputSchema: inputSchemaFor(route),
  run: async ({api, args}) => {
    if (route.path === '/v1/automations/schema') {
      const answer = await api.get(route.path);
      return text({
        steps: compactSchema(answer.steps),
        note: 'Every step also takes id (required, unique), label, enabled, ' +
          'timeoutMs, onError (stop|continue|retry) and retries. Full field ' +
          'specs: GET /v1/automations/schema. The notify, aiPrompt and aiCheck ' +
          'steps name a connector by id -- call scout_list_connectors for the ' +
          'ids this workspace has, and scout_create_connector if it has none.',
        // Declared here rather than left to the create tool's field
        // description, because an agent calls this BEFORE authoring anything --
        // which is the whole reason this tool exists. Without it, parameters
        // are discoverable only by reading a paragraph on another tool.
        parameters: PARAMETER_VOCABULARY,
      });
    }
    if (route.method === 'GET') {
      return text(await api.get(route.path));
    }
    // Only declared fields travel, for the reason scout_update_profile spells
    // out above: a route may accept more than its tool advertises, and an
    // agent that guesses a name should not be able to reach it.
    const body = {};
    for (const field of route.fields || []) {
      if (args[field.key] !== undefined) {
        body[field.key] = args[field.key];
      }
    }
    return text(await api.post(route.path, body));
  },
}));

TOOLS.push(...AUTOMATION_TOOLS);

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

// What the client sees in tools/list -- `run` is ours and must not leak into
// the wire format.
function listed() {
  return TOOLS.map(({name, description, inputSchema}) => ({name, description, inputSchema}));
}

module.exports = {BY_NAME, TOOLS, listed};
