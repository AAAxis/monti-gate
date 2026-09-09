// The connector registry and the message send adapters, in the main process.
//
// WHY HERE AND NOT IN THE PAGE. The same reason httpRequest is here: a fetch
// from the profile's page would traverse that profile's proxy and carry its
// cookies, so every send would leak the workflow's shape to the proxy operator
// and bill an identity's residential IP for a request that has nothing to do
// with that identity. These go out from the launcher.
//
// WHY THE CREDENTIALS LIVE IN THIS PROCESS. A step names a connector by id and
// nothing else. The renderer reads `connectors` from Supabase and pushes the
// resolved list in over IPC; the map below is the only copy, it is in memory,
// and it is never written anywhere. So no token can reach an automation's
// steps, its vars, its run log or run.json -- which is what makes it safe for
// the run record to be flushed to the cloud and read back by anyone in the org.
//
// ONE ADAPTER PER MESSAGING KIND. Unlike the model vendors (see ai.cjs), chat
// services never converged on a wire format, so each kind below carries its
// own few lines. What they share -- transport, timeouts, error surfacing --
// is shared through postText/postJson.
const http = require('http');
const https = require('https');

// How long one call may take. The runner still races every step against its
// own deadline, so this is a backstop against a socket that never answers,
// not the real budget.
const REQUEST_TIMEOUT_MS = 60000;

// id -> {id, name, category, kind, is_default, config, adapter?, base_url?, model?, api_key?}
//
// AI entries arrive with `adapter` and `base_url` already resolved against the
// preset catalogue; see ai.cjs complete() for why that resolution belongs on
// the renderer side.
let connectors = new Map();

// Replaces the whole list, including with an empty one. Clearing matters as
// much as filling: a connector deleted in the workspace has to stop working
// here immediately, not at the next restart.
function setConnectors(list) {
  connectors = new Map();
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry && typeof entry.id === 'string') {
      connectors.set(entry.id, entry);
    }
  }
}

// The connector a step named, or the category's workspace default when it
// named none. `category` filters both paths: an AI step must not fall back to
// a Telegram bot, and a notify step naming an AI connector's id by mistake is
// an error to report, not a call to make.
//
// Throws rather than returning null: every caller is inside a step executor,
// where a thrown error is how a step reports that it cannot run, and a null
// would have to be turned back into this same message by each of them.
function resolve(connectorId, category) {
  if (connectorId) {
    const found = connectors.get(connectorId);
    if (!found || (category && found.category !== category)) {
      throw new Error(
          'This step names a connector that no longer exists. ' +
          'Pick one under Automations → Connectors.');
    }
    return found;
  }
  for (const entry of connectors.values()) {
    if (entry.is_default && (!category || entry.category === category)) {
      return entry;
    }
  }
  throw new Error(category === 'message' ?
      'No default message connector is set. Add one under Automations → Connectors.' :
      'No AI connector is configured. Add one under Automations → Connectors.');
}

// One HTTP round trip, shared by every adapter here and by ai.cjs.
//
// Success is any 2xx; the body is parsed as JSON when it is JSON and left as
// text otherwise -- Slack's webhook answers the literal text `ok` and Discord
// answers 204 with nothing at all, and treating either as a failure would
// "fail" every send that worked. Callers that need the parsed body check
// `parsed`; callers that only care that it went through ignore the result.
function requestText(method, url, headers, payload) {
  return new Promise((resolvePromise, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      reject(new Error(`Not a valid URL: ${url}`));
      return;
    }
    const transport = target.protocol === 'http:' ? http : https;
    const request = transport.request(target, {
      method,
      headers: {
        ...(payload === undefined ? {} : {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        }),
        ...headers,
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
      });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          // Not JSON. For a webhook that is normal; for an error it is almost
          // always an HTML page from a gateway, and the raw text is the only
          // thing we can honestly report.
        }
        if (response.statusCode >= 400) {
          // The service's own message, when it sent one. A bare "HTTP 401" is
          // the difference between "your token is wrong" and half an hour.
          const detail = parsed?.error?.message || parsed?.description ||
            parsed?.message || (text ? text.slice(0, 300) : '');
          const error = new Error(
              `${target.host} answered ${response.statusCode}${detail ? `: ${detail}` : ''}`);
          error.parsed = parsed;
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        resolvePromise({parsed, text, statusCode: response.statusCode});
      });
    });
    request.on('timeout', () =>
      request.destroy(new Error(`${target.host} did not answer within ${
        Math.round(REQUEST_TIMEOUT_MS / 1000)}s`)));
    request.on('error', reject);
    if (payload !== undefined) {
      request.write(payload);
    }
    request.end();
  });
}

function postText(url, headers, payload) {
  return requestText('POST', url, headers, payload);
}

// The JSON-in, JSON-out wrappers ai.cjs and the JSON adapters use: same
// transport, but a 2xx that is not JSON is an error, because these callers
// read the body.
async function postJson(url, headers, body) {
  const response = await postText(url, headers, JSON.stringify(body));
  if (!response.parsed) {
    throw new Error(`${new URL(url).host} did not answer with JSON`);
  }
  return response.parsed;
}

async function getJson(url, headers) {
  const response = await requestText('GET', url, headers);
  if (!response.parsed) {
    throw new Error(`${new URL(url).host} did not answer with JSON`);
  }
  return response.parsed;
}

// Trailing slashes are the single most common way a hand-typed base URL breaks:
// 'https://host/v1/' + '/chat/completions' is a 404 that reads like a wrong key.
function join(baseUrl, path) {
  return `${String(baseUrl || '').replace(/\/+$/, '')}${path}`;
}

function requireConfig(connector, key, label) {
  const value = String(connector.config?.[key] || '').trim();
  if (!value) {
    throw new Error(`Connector "${connector.name}" has no ${label} set`);
  }
  return value;
}

// Telegram rejects a whole message when its markup does not parse -- 400,
// "can't parse entities". Everything Scout composes is escaped, but a message
// a step assembled from scraped page text is not, and losing a notification to
// a stray `<` in someone's product title would be the worst possible failure
// for the one channel that exists to report failures. So the markup is treated
// as a nicety: when it does not parse, the same text goes out unformatted.
function isParseFailure(error) {
  return error?.statusCode === 400 &&
    /can't parse entities|unsupported start tag|unclosed/i.test(
        String(error?.parsed?.description || error?.message || ''));
}

// The retry's text. Resending the markup verbatim would deliver a message full
// of literal `<b>` and `&amp;`, which is a worse read than the plain sentence
// it was decorating -- so the tags come off and the entities go back to being
// the characters they stand for.
function stripHtml(text) {
  return String(text)
      .replace(/<\/?[a-z][^>]*>/gi, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
}

async function sendTelegram(connector, message, parseMode) {
  const token = requireConfig(connector, 'botToken', 'bot token');
  const chatId = requireConfig(connector, 'chatId', 'chat id');
  const post = (body) => postJson(`https://api.telegram.org/bot${token}/sendMessage`, {}, body);
  let answer;
  try {
    answer = await post({
      chat_id: chatId,
      text: message,
      ...(parseMode ? {parse_mode: parseMode} : {}),
    });
  } catch (error) {
    if (!parseMode || !isParseFailure(error)) {
      throw error;
    }
    answer = await post({
      chat_id: chatId,
      text: parseMode === 'HTML' ? stripHtml(message) : message,
    });
  }
  // Telegram can answer 200 with ok:false in some proxy setups; trust the
  // body's verdict over the status line.
  if (answer && answer.ok === false) {
    throw new Error(`Telegram refused the message: ${answer.description || 'no reason given'}`);
  }
}

async function sendSlack(connector, message) {
  const url = requireConfig(connector, 'webhookUrl', 'webhook URL');
  // Success is the literal text `ok`, not JSON -- postText allows that.
  await postText(url, {}, JSON.stringify({text: message}));
}

async function sendDiscord(connector, message) {
  const url = requireConfig(connector, 'webhookUrl', 'webhook URL');
  // Success is 204 with an empty body.
  await postText(url, {}, JSON.stringify({content: message}));
}

// The WhatsApp Cloud API error codes that mean "the 24-hour customer-service
// window is closed". A free-form message only reaches someone who messaged
// this number in the last 24 hours; outside that window the API demands a
// pre-approved template. Worth naming precisely: the generic error for this
// case reads like a delivery failure, and the fix (have the recipient message
// first, or use a template) is nothing like the fix for a bad token.
const WHATSAPP_WINDOW_CODES = new Set([131047, 131026]);

async function sendWhatsApp(connector, message) {
  const phoneNumberId = requireConfig(connector, 'phoneNumberId', 'phone number id');
  const accessToken = requireConfig(connector, 'accessToken', 'access token');
  const to = requireConfig(connector, 'to', 'recipient');
  try {
    await postJson(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`,
        {authorization: `Bearer ${accessToken}`},
        {messaging_product: 'whatsapp', to, type: 'text', text: {body: message}});
  } catch (error) {
    const code = error?.parsed?.error?.code;
    if (WHATSAPP_WINDOW_CODES.has(code)) {
      throw new Error(
          `WhatsApp refused this message: the 24-hour customer-service window for ${to} ` +
          'has closed. Free-form messages only reach people who messaged this number in ' +
          'the last 24 hours; outside that window WhatsApp requires a pre-approved template.');
    }
    throw error;
  }
}

async function sendSmtp(connector, message, subject) {
  const host = requireConfig(connector, 'host', 'SMTP host');
  const from = requireConfig(connector, 'from', 'sender');
  const to = requireConfig(connector, 'to', 'recipient');
  const port = Number(connector.config?.port) || 587;
  const user = String(connector.config?.user || '').trim();
  const password = String(connector.config?.password || '');
  // Required here rather than at the top of the file so the app does not pay
  // for nodemailer's startup on every launch that never sends an email.
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host,
    port,
    // 465 is implicit TLS; everything else starts plain and upgrades with
    // STARTTLS when the server offers it, which is nodemailer's default.
    secure: port === 465,
    ...(user ? {auth: {user, pass: password}} : {}),
    connectionTimeout: REQUEST_TIMEOUT_MS,
    greetingTimeout: REQUEST_TIMEOUT_MS,
    socketTimeout: REQUEST_TIMEOUT_MS,
  });
  try {
    await transport.sendMail({
      from,
      to,
      subject: String(subject || '').trim() || 'Scout automation',
      text: message,
    });
  } finally {
    transport.close();
  }
}

// One outbound message through a message connector. `connector` is a resolved
// record, not an id -- the Test button passes an unsaved draft, and steps pass
// what resolve() handed back. `subject` is used by the kinds that have one
// (email) and ignored by the rest, and `parseMode` likewise: it is Telegram's
// word for rich text, and a caller that composed markup for one kind has to
// have composed it knowing which kind it was sending to.
async function send({connector, message, subject, parseMode}) {
  const body = String(message || '').trim();
  if (!body) {
    throw new Error('There is no message to send');
  }
  switch (connector.kind) {
    case 'telegram':
      return sendTelegram(connector, body, parseMode);
    case 'slack':
      return sendSlack(connector, body);
    case 'discord':
      return sendDiscord(connector, body);
    case 'whatsapp':
      return sendWhatsApp(connector, body);
    case 'smtp':
      return sendSmtp(connector, body, subject);
    default:
      // A kind this build has no adapter for -- a row written by a newer
      // build. Honest refusal over a guess at somebody's wire format.
      throw new Error(
          `This version of Scout cannot send through "${connector.kind}" connectors. ` +
          'Update the app.');
  }
}

module.exports = {REQUEST_TIMEOUT_MS, getJson, join, postJson, resolve, send, setConnectors};
