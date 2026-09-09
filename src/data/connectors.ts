// The outside services an automation can talk to: AI models to ask and
// messaging services to notify. A row in `connectors` names one of these by
// `kind`; everything service-specific lives in the row's `config`, whose SHAPE
// is declared here -- the same move step-schema.json makes for steps, and for
// the same reason: the editor and the connector form both render whatever this
// file describes, so adding a service is an entry here plus a send adapter in
// the main process, never a schema change or a new form.
//
// A static catalogue, like src/data/integrations.ts: what these services are
// does not change per workspace, only which ones a workspace has configured.
//
// THE IMPORTANT THING ABOUT THE AI HALF is `adapter`. There are thirteen
// entries and exactly two wire protocols. Eleven speak OpenAI's
// POST {base}/chat/completions with `Authorization: Bearer`, because every one
// of them shipped an OpenAI-compatible endpoint rather than ask the ecosystem
// to write a thirteenth client -- and Google's is a compatibility shim it
// publishes for the same reason. Anthropic is the one that is genuinely
// different: POST /v1/messages, `x-api-key`, an `anthropic-version` header and
// its own response shape. If you find yourself adding a third adapter, check
// first whether the service publishes an OpenAI-compatible base URL; most do.
//
// The message half has one adapter per kind (electron/automation/connectors.cjs)
// because unlike model vendors, chat services never converged on a wire format.

export type ConnectorCategory = 'ai' | 'message';

// Brand marks, the tagPresets.ts trick: resolved at build time, an absent file
// costs the preset's lucide glyph rather than a build error, so the catalogue
// can name every service before any artwork exists. Adding a logo is a drop
// into src/assets/connectors/<kind>.svg (or .png) with no code change here.
const CONNECTOR_LOGO_FILES = import.meta.glob('../assets/connectors/*.{svg,png}', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;

// The tag catalogue's marks double as a fallback for the services both lists
// know -- Telegram, Discord, WhatsApp and Google already have full-colour cuts
// in assets/brands, and shipping a second copy of each would be two files to
// keep in step.
const SHARED_BRAND_FILES = import.meta.glob('../assets/brands/*.svg', {
  eager: true,
  import: 'default',
  query: '?url',
}) as Record<string, string>;

function logoIndex(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).map(([path, url]) => [
    path.slice(path.lastIndexOf('/') + 1).replace(/\.(svg|png)$/, ''),
    url,
  ]));
}

const CONNECTOR_LOGOS = logoIndex(CONNECTOR_LOGO_FILES);
const SHARED_BRAND_LOGOS = logoIndex(SHARED_BRAND_FILES);

// Which assets/brands file stands in when assets/connectors has nothing for a
// kind. Only genuine matches: X's mark is not xAI's, so 'xai' is absent.
const BRAND_FALLBACK: Record<string, string> = {
  telegram: 'telegram',
  discord: 'discord',
  whatsapp: 'whatsapp',
  google: 'google',
};

// The image for a kind's card and picker tile, or null for the lucide glyph.
export function connectorLogo(kind: string): string | null {
  return CONNECTOR_LOGOS[kind] ||
    (BRAND_FALLBACK[kind] ? SHARED_BRAND_LOGOS[BRAND_FALLBACK[kind]] : undefined) ||
    null;
}

// Marks drawn for one background, and how each survives the other -- the
// assets/brands/README.md taxonomy. The white-only cuts vanish on paper; the
// currentColor ones resolve to black inside an <img> (nothing to inherit
// from) and vanish on charcoal. Keyed by kind, checked in both themes when a
// file is swapped for a different cut.
const LOGO_ADAPT: Record<string, 'invert-on-light' | 'invert-on-dark'> = {
  openai: 'invert-on-light',
  openrouter: 'invert-on-light',
  ollama: 'invert-on-light',
  xai: 'invert-on-dark',
  lmstudio: 'invert-on-dark',
};

export function connectorLogoAdapt(kind: string): string | null {
  return LOGO_ADAPT[kind] || null;
}

export type AiAdapter = 'openai' | 'anthropic';

// One field of a connector's config, as the generated form renders it.
// `secret` is what masking keys off: a secret field shows as a password input
// and appears on cards as its last four characters. Masking is a courtesy and
// NOT a boundary -- every org member can read the column; see the migration.
export type ConnectorField = {
  key: string;
  label: string;
  kind: 'text' | 'password' | 'number' | 'select';
  required?: boolean;
  secret?: boolean;
  hint?: string;
  placeholder?: string;
  options?: string[];
};

export type ConnectorPreset = {
  kind: string;
  label: string;
  category: ConnectorCategory;
  // A key the UI resolves to a glyph. A short name, never markup -- the same
  // contract folder icons follow.
  icon: string;
  // The config shape. The form is generated from this and validation reads it,
  // so a field that is not listed here does not exist as far as the app knows.
  fields: ConnectorField[];
  // AI presets only ------------------------------------------------------
  adapter?: AiAdapter;
  // Where the preset points. Empty for 'custom', which requires the user to
  // supply one.
  baseUrl?: string;
  // Prefilled in the model box. Not a validated list: these services rename
  // and retire models faster than this app ships, so the field stays free text
  // and this is only a starting point.
  suggestedModel?: string;
  // Where to get a key, opened in the user's own browser. Omitted for the
  // local runtimes, which have nowhere to send anyone.
  keyUrl?: string;
};

// The three config fields every AI provider shares, with the two per-preset
// differences threaded in: whether a key is demanded at all (the local
// runtimes authenticate nobody, and demanding one would make the easiest
// provider to try the hardest to set up), and whether the endpoint is
// required (only 'custom' has no preset URL to fall back to).
//
// The key comes FIRST. The model box under it fills itself from the
// endpoint's live listing the moment the key works (ConnectorModal), so the
// order is the workflow: paste the key, pick from what it unlocked. Model
// before key read as "type a model from memory" with a dead Load button.
function aiFields({needsKey, custom}: {needsKey: boolean; custom?: boolean}): ConnectorField[] {
  return [
    ...(needsKey ?
      [{key: 'api_key', label: 'API key', kind: 'password', required: true, secret: true} as
        ConnectorField] :
      []),
    {key: 'model', label: 'Model', kind: 'text', required: true,
      hint: 'The exact model id the provider expects.'},
    {
      key: 'base_url',
      label: custom ? 'Endpoint' : 'Endpoint (optional)',
      kind: 'text',
      required: Boolean(custom),
      hint: custom ?
        'The OpenAI-compatible base URL, e.g. https://host/v1.' :
        'Leave empty to use the provider’s standard endpoint.',
    },
  ];
}

export const CONNECTOR_PRESETS: ConnectorPreset[] = [
  // ── AI ────────────────────────────────────────────────────────────────────
  // Labels are what the picker and cards show; `kind` is what rows store and
  // must never change. These two carry the product names people search for
  // rather than the company names on the API bill.
  {
    kind: 'openai',
    label: 'ChatGPT',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    suggestedModel: 'gpt-4.1-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'anthropic',
    label: 'Claude',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    suggestedModel: 'claude-sonnet-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'deepseek',
    label: 'DeepSeek',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    suggestedModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'google',
    label: 'Google Gemini',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    suggestedModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'mistral',
    label: 'Mistral',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    suggestedModel: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    fields: aiFields({needsKey: true}),
  },
  // 'groq' (the LPU inference cloud) was here and was cut: beside "xAI Grok"
  // the picker read as offering Grok twice, and clearing that up was worth
  // more than the eleventh OpenAI-compatible vendor. Nobody had stored one
  // (the table was empty when this shipped); a row from another build renders
  // as unrecognised and runs only if it carries its own base_url.
  {
    kind: 'xai',
    label: 'xAI Grok',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    suggestedModel: 'grok-4',
    keyUrl: 'https://console.x.ai',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModel: 'openai/gpt-4.1-mini',
    keyUrl: 'https://openrouter.ai/keys',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'together',
    label: 'Together AI',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    suggestedModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'huggingface',
    label: 'Hugging Face',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'https://router.huggingface.co/v1',
    suggestedModel: 'meta-llama/Llama-3.3-70B-Instruct',
    keyUrl: 'https://huggingface.co/settings/tokens',
    fields: aiFields({needsKey: true}),
  },
  {
    kind: 'lmstudio',
    label: 'LM Studio (local)',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1',
    suggestedModel: 'local-model',
    fields: aiFields({needsKey: false}),
  },
  {
    kind: 'ollama',
    label: 'Ollama (local)',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    suggestedModel: 'llama3.1',
    fields: aiFields({needsKey: false}),
  },
  {
    kind: 'custom',
    label: 'Other (OpenAI-compatible)',
    category: 'ai',
    icon: 'sparkles',
    adapter: 'openai',
    baseUrl: '',
    suggestedModel: '',
    fields: aiFields({needsKey: false, custom: true}),
  },
  // ── Messaging ─────────────────────────────────────────────────────────────
  {
    kind: 'telegram',
    label: 'Telegram',
    category: 'message',
    icon: 'send',
    keyUrl: 'https://core.telegram.org/bots#how-do-i-create-a-bot',
    fields: [
      {key: 'botToken', label: 'Bot token', kind: 'password', required: true, secret: true,
        placeholder: '123456789:AA…',
        hint: 'From @BotFather. The bot must have messaged the chat once, or be in the group.'},
      {key: 'chatId', label: 'Chat ID', kind: 'text', required: true,
        placeholder: '-1004281234567',
        hint: 'A user, group or channel id. Groups are negative numbers.'},
    ],
  },
  {
    kind: 'slack',
    label: 'Slack',
    category: 'message',
    icon: 'hash',
    keyUrl: 'https://api.slack.com/messaging/webhooks',
    fields: [
      // The URL itself is the credential -- anyone holding it can post to the
      // channel -- which is why it is marked secret rather than shown in full.
      {key: 'webhookUrl', label: 'Webhook URL', kind: 'password', required: true, secret: true,
        placeholder: 'https://hooks.slack.com/services/…'},
    ],
  },
  {
    kind: 'discord',
    label: 'Discord',
    category: 'message',
    icon: 'message-circle',
    keyUrl: 'https://support.discord.com/hc/en-us/articles/228383668',
    fields: [
      {key: 'webhookUrl', label: 'Webhook URL', kind: 'password', required: true, secret: true,
        placeholder: 'https://discord.com/api/webhooks/…'},
    ],
  },
  {
    kind: 'whatsapp',
    label: 'WhatsApp Business',
    category: 'message',
    icon: 'phone',
    keyUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started',
    fields: [
      {key: 'phoneNumberId', label: 'Phone number ID', kind: 'text', required: true,
        hint: 'The Cloud API phone number id, not the phone number itself.'},
      {key: 'accessToken', label: 'Access token', kind: 'password', required: true, secret: true},
      {key: 'to', label: 'Send to', kind: 'text', required: true,
        placeholder: '15551234567',
        // The 24-hour window is a real API constraint, surfaced here so the
        // first failed send is not the first time anyone hears of it. The send
        // adapter names it again, distinctly, when WhatsApp refuses for this
        // reason.
        hint: 'Free-form messages only reach people who messaged this number in the ' +
          'last 24 hours; outside that window WhatsApp requires a pre-approved template.'},
    ],
  },
  {
    kind: 'smtp',
    label: 'Email (SMTP)',
    category: 'message',
    icon: 'mail',
    fields: [
      {key: 'host', label: 'SMTP host', kind: 'text', required: true,
        placeholder: 'smtp.example.com'},
      {key: 'port', label: 'Port', kind: 'number', required: true, placeholder: '587',
        hint: '465 connects over TLS; anything else starts plain and upgrades with STARTTLS.'},
      {key: 'user', label: 'Username', kind: 'text',
        hint: 'Leave empty for a relay that does not authenticate.'},
      {key: 'password', label: 'Password', kind: 'password', secret: true},
      {key: 'from', label: 'From', kind: 'text', required: true,
        placeholder: 'scout@example.com'},
      {key: 'to', label: 'To', kind: 'text', required: true,
        placeholder: 'ops@example.com',
        hint: 'Separate multiple recipients with commas.'},
    ],
  },
];

// The preset a stored row names, or null when this build does not recognise it.
//
// Null rather than a fallback: a row written by a newer build names a real
// service with a real endpoint or wire format, and quietly treating it as
// something else would send its requests to the wrong place. The connector
// card says it does not recognise the kind instead.
export function presetFor(kind: string): ConnectorPreset | null {
  return CONNECTOR_PRESETS.find((preset) => preset.kind === kind) || null;
}

// Which config keys are credentials, for masking and for anything that lists
// connectors into a context that gets logged. Empty for an unrecognised kind:
// with no field declarations there is nothing to mask, and the card for such a
// row shows no config at all.
export function secretKeysFor(kind: string): string[] {
  const preset = presetFor(kind);
  return (preset?.fields || []).filter((field) => field.secret).map((field) => field.key);
}

// The catalogue as GET /v1/connectors serves it, so an agent authoring a
// connector learns the same field list the form generates itself from.
//
// Derived rather than written out for the reason the whole preset table exists:
// electron/ compiles nothing from src/, and a second hand-kept copy of five
// messaging shapes and thirteen AI ones is drift by construction. The bridge
// calls this and forwards the result.
//
// `kind` is dropped from each field on purpose -- 'password' is a rendering
// instruction for a form, and `secret` already carries the only part of it an
// API caller can act on. Everything kept here is static catalogue text: no
// stored value of any kind passes through this function.
export type ConnectorKindSummary = {
  kind: string;
  label: string;
  category: ConnectorCategory;
  fields: {
    key: string;
    label: string;
    required: boolean;
    secret: boolean;
    hint?: string;
    example?: string;
    options?: string[];
  }[];
};

export function connectorKindsForApi(): ConnectorKindSummary[] {
  return CONNECTOR_PRESETS.map((preset) => ({
    kind: preset.kind,
    label: preset.label,
    category: preset.category,
    fields: preset.fields.map((field) => ({
      key: field.key,
      label: field.label,
      required: Boolean(field.required),
      secret: Boolean(field.secret),
      ...(field.hint ? {hint: field.hint} : {}),
      // The form's placeholder, renamed: to a caller filling this in from a
      // chat it is an example value, not grey text in a box. It is the one
      // thing that says a Telegram chat id looks like -1004281234567.
      ...(field.placeholder ? {example: field.placeholder} : {}),
      ...(field.options ? {options: field.options} : {}),
    })),
  }));
}

// A connector's config as stored: string values under the keys the preset
// declares. Number fields hold the digits as text -- everything arrives from a
// form input, and the send adapters coerce where a number is genuinely needed.
export type ConnectorConfig = Record<string, string>;

// What is wrong with a draft, as sentences, or an empty list when nothing is.
// Pure on purpose: the connector form gates Save on it and the tests drive it
// directly. An unrecognised kind validates to "no problems" -- this build
// cannot know what such a config needs, and refusing to keep a row a newer
// build wrote would break the workspace on version skew.
export function validateConnectorConfig(kind: string, config: ConnectorConfig): string[] {
  const preset = presetFor(kind);
  if (!preset) {
    return [];
  }
  const problems: string[] = [];
  for (const field of preset.fields) {
    const value = (config[field.key] || '').trim();
    if (field.required && !value) {
      problems.push(`${field.label.replace(/ \(optional\)$/, '')} is required`);
      continue;
    }
    if (value && field.kind === 'number' && !Number.isFinite(Number(value))) {
      problems.push(`${field.label} must be a number`);
    }
  }
  return problems;
}

// What the main process is handed: a connector with its preset already applied.
//
// The resolution happens on this side because this is the side that has the
// catalogue. electron/ compiles nothing from src/, so the alternative is a
// second copy of thirteen base URLs and their adapters over there, kept in
// step by hand -- the drift step-schema.json exists to avoid.
//
// An unrecognised AI `kind` still resolves, as long as the row carries its own
// base_url. That is the honest reading: a row written by a newer build names a
// real service, and refusing to run it because this build has not heard of the
// preset would break a workspace on the strength of a version skew.
export type RuntimeConnector = {
  id: string;
  name: string;
  category: string;
  kind: string;
  is_default: boolean;
  // The whole config, secrets included -- the main process is the only place
  // an outbound call can leave from, and a credential nobody can send is a
  // connector nothing can run against. Memory-only over there.
  config: ConnectorConfig;
  // AI connectors only, resolved against the preset:
  adapter?: AiAdapter;
  base_url?: string;
  model?: string;
  api_key?: string | null;
};

export function runtimeConnector(connector: {
  id: string;
  name: string;
  category: string;
  kind: string;
  config: ConnectorConfig;
  is_default?: boolean;
}): RuntimeConnector {
  const base: RuntimeConnector = {
    id: connector.id,
    name: connector.name,
    category: connector.category,
    kind: connector.kind,
    is_default: Boolean(connector.is_default),
    config: connector.config || {},
  };
  if (connector.category !== 'ai') {
    return base;
  }
  const preset = presetFor(connector.kind);
  return {
    ...base,
    adapter: preset?.adapter || 'openai',
    // The row's own endpoint wins. It is only set when the user typed one, and
    // someone who typed one meant it -- a self-hosted gateway or a regional
    // endpoint is exactly this field's purpose.
    base_url: (connector.config.base_url || '').trim() || preset?.baseUrl || '',
    model: connector.config.model || '',
    api_key: connector.config.api_key || null,
  };
}
