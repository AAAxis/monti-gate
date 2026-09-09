// Linking a member's Telegram to the workspace's notification bot, with no
// server leg at all.
//
// The bot deliberately has NO webhook, which is what makes this possible:
// getUpdates and webhooks are mutually exclusive on Telegram's side, and a
// webhook would need a host to receive it (the abandoned first design put
// that on the landing site, which meant a deploy, env vars and a secret
// before the first message could flow). Instead the launcher opens
// t.me/<bot>?start=<code> in the user's own browser and watches the bot's
// update feed for the /start that carries the code back.
//
// Linking is a one-off, so two launchers polling at once is rare -- but
// Telegram enforces one getUpdates consumer at a time with a 409, which is
// turned into a sentence rather than left as a status code.
//
// The reply on success is a courtesy so the chat does not end on the user's
// own /start; the launcher's own state flip is the real confirmation.
const {getJson, postJson} = require('./automation/connectors.cjs');

const POLL_TIMEOUT_MS = 120000;
// getUpdates long-polls server-side for this many seconds per call. Kept well
// under the shared 60s HTTP timeout in connectors.cjs.
const LONG_POLL_SECONDS = 15;
// How long a /start carrying the WRONG code (or none) waits before being
// accepted anyway. Telegram keeps stale start-parameters around: a chat opened
// from an earlier attempt keeps its old Start button, and pressing it sends
// the old code -- which this poll then consumes, matches against nothing, and
// the link hangs. The grace keeps the exact code authoritative when two people
// link at once, while letting the everyday stale-button case complete.
const WRONG_CODE_GRACE_MS = 8000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Resolves {chatId, username} when a chat sends `/start <code>` to the bot,
// or null when nobody does before the timeout. Throws with a readable
// sentence on a bad token or a competing consumer.
//
// `welcome` is the reply sent into the chat on success. Composed by the
// renderer, because the useful half of it -- which workspaces will message
// this chat -- lives in data this process never holds.
async function pollForStart({token, code, welcome, timeoutMs = POLL_TIMEOUT_MS}) {
  const deadline = Date.now() + timeoutMs;
  let offset;
  // A /start whose parameter is stale or missing, held while the exact code
  // gets its head start. See WRONG_CODE_GRACE_MS.
  let candidate = null;
  let candidateAt = 0;

  const accept = async (chatId, username) => {
    // Best-effort courtesy; the renderer's own row write is the truth.
    try {
      await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {}, {
        chat_id: chatId,
        text: welcome ||
          'Telegram is linked to Scout. Automation runs you subscribe to ' +
          'will message you here.',
      });
    } catch {
      // The link still happened.
    }
    return {chatId, username};
  };

  while (Date.now() < deadline) {
    if (candidate && Date.now() - candidateAt >= WRONG_CODE_GRACE_MS) {
      return accept(candidate.chatId, candidate.username);
    }
    const url = `https://api.telegram.org/bot${token}/getUpdates` +
      `?timeout=${LONG_POLL_SECONDS}${offset ? `&offset=${offset}` : ''}`;
    let answer;
    try {
      answer = await getJson(url, {});
    } catch (error) {
      const message = error?.message || String(error);
      if (message.includes('409')) {
        throw new Error('Another launcher is linking against this bot right now. ' +
          'Finish there first, or try again in a minute.');
      }
      throw error;
    }
    if (answer.ok === false) {
      // 401 means the token itself is wrong -- the one failure the owner has
      // to fix rather than retry.
      throw new Error(`Telegram refused: ${answer.description || 'no reason given'}. ` +
        'Check the bot token on the Notification bot tab.');
    }
    for (const update of answer.result || []) {
      offset = update.update_id + 1;
      const message = update.message;
      const text = String(message?.text || '').trim();
      if (message?.chat?.id === undefined || !text.startsWith('/start')) {
        continue;
      }
      const chatId = String(message.chat.id);
      const username = message.from?.username || null;
      if (text === `/start ${code}`) {
        return accept(chatId, username);
      }
      // Stale button, hand-typed /start, or a link from a previous attempt.
      // Held rather than accepted: if the exact code lands within the grace,
      // it wins -- that is the teammate-linking-at-the-same-time case.
      candidate = {chatId, username};
      candidateAt = Date.now();
    }
    // Only reached when the long poll returned early (updates that were not
    // ours, or an empty feed); a beat before re-asking keeps this polite.
    await sleep(1000);
  }
  // A candidate that arrived in the poll's final seconds still counts -- the
  // grace exists to prefer the exact code, not to lose a link to the clock.
  if (candidate) {
    return accept(candidate.chatId, candidate.username);
  }
  return null;
}

module.exports = {pollForStart};
