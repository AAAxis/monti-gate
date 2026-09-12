// Everything that mutates automations, plus starting a run.
//
// Mirrors useProxyActions: local state is patched optimistically and the write
// goes through withDb, so a failure toasts once and the caller bails without a
// false success message.
import {useRef} from 'react';
// Through the namespace, not named imports: vite's dev server hands this CJS
// file to the renderer as an ESM module whose only export is default
// (module.exports), while the production build's commonjs interop offers named
// exports too. Named imports therefore whitescreen dev at load time and work
// in the packaged app; the namespace + default fallback resolves in both.
import * as notifyCjs from '../../electron/automation/notify.cjs';
const {composeFinishTelegram, shouldNotify} =
  (notifyCjs as unknown as {default?: typeof notifyCjs}).default ?? notifyCjs;
import {useAutomationRuns} from '../hooks/useAutomationRuns';
import * as db from '../db';
import {buildLaunchPayload} from '../lib/launch';
import {mapWithConcurrency} from '../lib/concurrency';
import {buildRunTile} from '../lib/runTile';
import {startPageAutomations} from '../lib/startPageAutomations';
import {botDeepLink, mintLinkCode, sendTelegram} from '../lib/telegram';
import {native} from '../native';
import {useOrg} from '../org';
import {SHOWCASE_AUTOMATION} from '../data/showcaseAutomation';
import {collectCallees, resolveCallTree} from '../automations/callGraph';
import {RUN_CONCURRENCY, runWaitCeiling} from '../automations/limit';
import {describeMissingParams, resolveRunVars, secretVarNames} from '../automations/parameters';
import {newId} from './core';
import type {WorkspaceCore} from './core';
import type {ProxyActions} from './useProxyActions';
import type {ScoutAutomation, ScoutProfile, AutomationRun} from '../types';
import type {AutomationVars, RunTrigger} from '../automations/types';

export type AutomationActions = ReturnType<typeof useAutomationActions>;

export function useAutomationActions(
    {data, toast}: WorkspaceCore,
    // The pre-launch proxy gate. Taken as a dependency rather than reading
    // state.proxies directly so a run is blocked by the same check a manual
    // launch is -- see resolveForLaunch.
    proxies: ProxyActions,
    orgId: string | null,
    signedIn: boolean,
) {
  const {state, withDb, withDbError, patch} = data;
  // For the workspace's notification bot (organizations.telegram_bot_*), which
  // rides the org row rather than CloudState.
  const org = useOrg();
  const {runs, startRun, cancelRun, waitForRun} = useAutomationRuns(orgId, signedIn,
      // Every terminal run lands here. Three independent consequences:
      //
      // The card's last-run verdict, patched locally so the dot updates the
      // moment the run ends -- useAutomationRuns wrote the columns; this is the
      // same value applied to the render cache, guarded the same way (only
      // forward).
      //
      // Notify-on-finish delivered to Scout Web, only when the event carries a
      // notification: one row in `notifications` (main composed it; only this
      // side can write it) and the same row patched into the bell immediately
      // -- the reload-on-focus would show it anyway, but the machine that ran
      // the automation should not have to lose focus to see its own bell ring.
      // Offline, the insert fails quietly and the local row lasts until the
      // next reload; the flushed run record remains the durable truth.
      //
      // A personal Telegram message, when this user opted in for this
      // automation -- fire-and-forget through the landing API, which holds the
      // bot token.
      (run, notification) => {
        if (run.automation_id && run.finished_at) {
          patch.automations((list) => list.map((item) =>
            item.id === run.automation_id &&
                (!item.last_run_at || item.last_run_at < run.finished_at!) ?
              {...item, last_run_at: run.finished_at, last_run_status: run.status} :
              item));
        }
        if (notification) {
          const row = {
            id: newId(),
            kind: notification.kind,
            title: notification.title,
            body: notification.body,
            status: notification.status ?? null,
            automation_id: notification.automation_id ?? null,
            run_id: notification.run_id ?? null,
            created_at: new Date().toISOString(),
            read: false,
          };
          if (orgId) {
            void db.notifications.create(orgId, row).catch(() => undefined);
          }
          patch.notifications((list) => [row, ...list]);
        }
        sendTelegramForRun(run);
      });
  // automationId -> the profile it last ran on, this session. State the editor's
  // Check button reads through runTarget so it tests a selector against the page
  // the last run actually used. A ref, not state: nothing re-renders on it, and
  // it is written from inside an in-flight run.
  const lastRunProfileIds = useRef<Record<string, string>>({});

  // The personal-Telegram half of notify-on-finish. Gated by the same pure
  // shouldNotify the org-connector path uses ('failure' includes partial,
  // cancelled never sends), against MY pref for this automation rather than
  // the automation's own notify_on -- the two are independent settings.
  function sendTelegramForRun(run: AutomationRun) {
    const botToken = org.org?.telegram_bot_token;
    const link = state.telegram_link;
    if (!run.automation_id || !botToken || !link) {
      return;
    }
    const pref = state.telegram_prefs.find(
        (entry) => entry.automation_id === run.automation_id);
    if (!pref || !shouldNotify(pref.notify_on, run.status)) {
      return;
    }
    // Marked up rather than plain: this one lands on a phone, where the emoji
    // verdict is what distinguishes "your run finished" from "your run needs
    // you" in a list of chats, and the error is worth its own copyable block.
    void sendTelegram(botToken, link.chat_id, composeFinishTelegram(run), 'HTML');
  }

  function newAutomation(): ScoutAutomation {
    return {
      id: newId(),
      name: 'New automation',
      steps: [],
      variables: {},
      parameters: [],
      pinned: false,
      timeout_ms: 300000,
      close_on_finish: false,
      // Minted here, not left to the column default: the optimistic row is
      // sorted (newest first) the moment it lands in local state, and a row
      // without created_at would sort last instead of first.
      created_at: new Date().toISOString(),
    };
  }

  // The pre-written example, minted the same way a blank one is.
  //
  // The id is added here rather than baked into src/data/showcaseAutomation.ts:
  // it becomes a directory name under <userData>/AutomationRuns/, so a constant
  // would hand every org the same one and make loading the example twice a
  // primary-key collision instead of two independent rows.
  //
  // Deep-cloned, not spread. The template is a module-level constant and its
  // steps are nested arrays that the editor edits in place -- a shallow copy
  // would let the first person who edits the example rewrite what everyone
  // loads next, for the rest of the session.
  function exampleAutomation(): ScoutAutomation {
    return {
      ...structuredClone(SHOWCASE_AUTOMATION),
      id: newId(),
      created_at: new Date().toISOString(),
    };
  }

  // create vs replace is the caller's call, never an upsert -- see the comment
  // in src/db/automations.ts for the BEFORE INSERT trigger this avoids.
  async function save(automation: ScoutAutomation, exists: boolean): Promise<string | null> {
    const error = await withDbError(
        (activeOrgId) => db.automations.save(activeOrgId, automation, exists));
    if (error) {
      return error;
    }
    // Prepend, not append: the grid renders newest first and the DB read
    // orders created_at DESC, so a new row lands where the next reload would
    // put it. (The tab re-sorts anyway; this keeps the two honest.)
    patch.automations((list) => exists ?
      list.map((item) => item.id === automation.id ? automation : item) :
      [automation, ...list]);
    return null;
  }

  // Delete, as the app and MCP both mean it now: into Trash, recoverable for
  // 30 days. `purge` below is the permanent one, reachable only from there.
  //
  // Answers whether it actually happened. The editor's Delete button closes the
  // dialog it was clicked in, and a dialog that closes on a failed write
  // reports success the toast is simultaneously denying.
  //
  // Profiles keep their automation_id through a soft delete, unlike the
  // permanent path below: restoring has to put things back exactly, and
  // detaching here would silently unbind every profile the moment someone
  // trashed a workflow by mistake. The surfaces that must not offer a trashed
  // automation filter on deleted_at instead.
  async function softDelete(ids: string[]): Promise<boolean> {
    if (ids.length === 0) {
      return false;
    }
    const deletedAt = new Date().toISOString();
    if (!await withDb((activeOrgId) => db.automations.softDelete(activeOrgId, ids))) {
      return false;
    }
    patch.automations((list) => list.map((item) =>
      ids.includes(item.id) ? {...item, deleted_at: deletedAt} : item));
    // Callers left pointing at what just went to Trash. Non-blocking -- the
    // delete happened -- but said out loud, because their next run will refuse
    // and this is the moment that explains why.
    const orphaned = state.automations.filter((item) =>
      !ids.includes(item.id) && !item.deleted_at &&
      collectCallees(item.steps).some((calleeId) => ids.includes(calleeId)));
    if (orphaned.length > 0) {
      toast.notify(
          `${orphaned.map((item) => item.name).join(', ')} call${orphaned.length === 1 ? 's' : ''} ` +
          'what you just deleted — their Run automation steps will now fail.',
          {tone: 'info'});
    }
    return true;
  }

  // Restoring crosses the plan cap as much as creating does, so
  // trg_automation_limit_restore fires on exactly this update and can refuse
  // it. One statement for the set, so it either all lands or none of it does.
  async function restore(ids: string[]): Promise<boolean> {
    if (!await withDb((activeOrgId) => db.automations.restore(activeOrgId, ids))) {
      return false;
    }
    patch.automations((list) => list.map((item) =>
      ids.includes(item.id) ? {...item, deleted_at: null} : item));
    return true;
  }

  // Permanent, from Trash.
  async function purge(ids: string[]): Promise<boolean> {
    if (ids.length === 0) {
      return false;
    }
    if (!await withDb((activeOrgId) => db.automations.remove(activeOrgId, ids))) {
      return false;
    }
    patch.automations((list) => list.filter((item) => !ids.includes(item.id)));
    // The database detaches profiles for us (ON DELETE SET NULL), but local
    // state has to be told, or the profile row keeps showing a workflow that
    // no longer exists until the next reload.
    patch.profiles((list) => list.map((profile) =>
      profile.automation_id && ids.includes(profile.automation_id) ?
        {...profile, automation_id: null} :
        profile));
    return true;
  }

  // Empty Trash. The local patch drops every trashed row rather than the ids
  // the statement returned: those are the same set, and filtering on
  // deleted_at keeps the two sides describing Trash the same way.
  async function purgeAll(): Promise<boolean> {
    const purged = state.automations.filter((item) => item.deleted_at).map((item) => item.id);
    if (!await withDb((activeOrgId) => db.automations.purgeAll(activeOrgId))) {
      return false;
    }
    patch.automations((list) => list.filter((item) => !item.deleted_at));
    patch.profiles((list) => list.map((profile) =>
      profile.automation_id && purged.includes(profile.automation_id) ?
        {...profile, automation_id: null} :
        profile));
    return true;
  }

  async function assignToFolder(ids: string[], folderId: string | null): Promise<boolean> {
    const ok = await withDb(async (activeOrgId) => {
      for (const id of ids) {
        await db.automations.update(activeOrgId, id, {folder_id: folderId});
      }
    });
    if (!ok) {
      return false;
    }
    patch.automations((list) => list.map((item) =>
      ids.includes(item.id) ? {...item, folder_id: folderId} : item));
    return true;
  }

  async function setPinned(automation: ScoutAutomation, pinned: boolean) {
    patch.automations((list) =>
      list.map((item) => item.id === automation.id ? {...item, pinned} : item));
    await withDb((activeOrgId) =>
      db.automations.update(activeOrgId, automation.id, {pinned}));
  }

  // My per-automation Telegram preference. Written immediately, not on Save:
  // it is a per-user row beside the automation, not part of the document.
  async function setTelegramPref(automationId: string, value: 'always' | 'failure' | null) {
    patch.telegramPrefs((list) => {
      const rest = list.filter((entry) => entry.automation_id !== automationId);
      return value ? [...rest, {automation_id: automationId, notify_on: value}] : rest;
    });
    await withDb((activeOrgId) => value ?
      db.telegramPrefs.set(activeOrgId, automationId, value) :
      db.telegramPrefs.clear(activeOrgId, automationId));
  }

  // The one-time link, entirely local: mint a code, open the bot's deep link
  // in the user's own browser (never a profile), and let the main process
  // watch the bot's getUpdates feed for the /start that carries the code back.
  // The poll gives up after two minutes with a sentence -- the user may simply
  // not have finished, and the button is still there.
  async function linkTelegram() {
    const botToken = org.org?.telegram_bot_token;
    const botName = org.org?.telegram_bot_name;
    if (!botToken || !botName) {
      toast.setMessage(
          'Set up the notification bot first — Automations tab, Notification bot.');
      return;
    }
    if (!native?.telegramLinkPoll) {
      toast.setMessage('Linking Telegram needs the desktop app.');
      return;
    }
    const code = mintLinkCode();
    const deepLink = botDeepLink(botName, code);
    // The bot's welcome, composed here because only the renderer can answer
    // the question it exists for: which workspaces will message this chat.
    // That is every workspace this user belongs to that runs THIS bot -- a
    // send happens wherever a launcher is signed into one of them.
    const botSlug = botName.replace(/^@/, '');
    const serving = org.orgs
        .filter((membership) =>
          (membership.org.telegram_bot_name || '').replace(/^@/, '') === botSlug)
        .map((membership) => membership.org.name);
    const welcome =
      'Welcome! Your Telegram is now linked to Scout Web.\n\n' +
      'This chat will receive automation updates from: ' +
      `${serving.length > 0 ? serving.join(', ') : org.org?.name || 'your workspace'}.\n\n` +
      'Pick which automations message you in each automation\'s editor, under ' +
      'Personal Telegram. Nothing is sent until you subscribe to one.';
    // openExternal answers whether the OS actually took the URL (main refuses
    // hosts off its allow-list, among other things). Claiming "the chat just
    // opened" when nothing opened is the failure this used to have -- fall
    // back to showing the link itself, and keep polling either way: pasting
    // it into Telegram by hand still completes the same link.
    const opened = await native.openExternal?.(deepLink);
    toast.setMessage(opened ?
      'Press Start in the Telegram chat that just opened.' :
      `Couldn't open Telegram. Open ${deepLink} yourself, then press Start.`);
    const found = await native.telegramLinkPoll(botToken, code, welcome);
    if (!found.ok || !found.chatId) {
      toast.setMessage(found.error || 'Linking timed out. Try again.');
      return;
    }
    const chatId = found.chatId;
    const username = found.username || null;
    const error = await withDbError(() => db.telegramPrefs.saveLink(chatId, username));
    if (error) {
      toast.setMessage(error);
      return;
    }
    patch.telegramLink({
      chat_id: chatId,
      telegram_username: username,
      linked_at: new Date().toISOString(),
    });
    toast.notify('Telegram linked. Scout Web can message you now.', {tone: 'ok'});
  }

  // Severs MY chat only. The per-automation prefs survive on purpose --
  // relinking next week should not mean re-subscribing to a dozen automations.
  async function unlinkTelegram() {
    patch.telegramLink(null);
    await withDb(() => db.telegramPrefs.unlink());
  }

  // The Notification bot view's test button. Returns the failure sentence, or
  // null -- the caller renders it inline rather than as a toast.
  async function testTelegram(): Promise<string | null> {
    const botToken = org.org?.telegram_bot_token;
    const link = state.telegram_link;
    if (!botToken || !link) {
      return 'Link Telegram first.';
    }
    // Sent as markup, and shaped like a real run summary: the point of a test
    // is to prove the channel end to end, and rich text is now part of the
    // channel -- a bot whose token works but whose HTML is refused would pass
    // a plain test and still mangle every notification after it.
    const sent = await sendTelegram(
        botToken, link.chat_id,
        '✅ <b>Test message from Scout Web</b>\nYour notifications work.', 'HTML');
    return sent.ok ? null : (sent.error || 'The send failed.');
  }

  // A star is the signed-in user's own, so this patches automation_stars (the
  // per-user list) rather than the automation row -- same optimistic shape as
  // setPinned otherwise.
  async function setStarred(automationId: string, starred: boolean) {
    patch.automationStars((ids) => starred ?
      (ids.includes(automationId) ? ids : [...ids, automationId]) :
      ids.filter((id) => id !== automationId));
    await withDb((activeOrgId) => starred ?
      db.automationStars.add(activeOrgId, automationId) :
      db.automationStars.remove(activeOrgId, automationId));
  }

  // Which automation runs when this profile launches. A bare UPDATE, so it
  // never fires trg_profile_limit.
  async function attach(profileId: string, automationId: string | null) {
    patch.profiles((list) => list.map((profile) =>
      profile.id === profileId ? {...profile, automation_id: automationId} : profile));
    await withDb((activeOrgId) =>
      db.profiles.update(activeOrgId, profileId, {automation_id: automationId}));
  }

  // Runs an automation against a profile, launching it first if it is not open.
  //
  // The launch goes through buildLaunchPayload like every other launch -- it is
  // the single seam, and routing around it is how a run would miss the proxy,
  // the fingerprint or the shared extensions. The debugging port is appended
  // only here, for this launch.
  // `quiet` is for a batch. toast.fail does not raise a banner -- it opens a
  // blocking ErrorModal (hooks/useToast.ts) -- so five failed runs would be
  // five stacked dialogs to dismiss. runMany collects the failures and says it
  // once instead.
  async function run(
      automation: ScoutAutomation,
      profile: ScoutProfile,
      options: {trigger?: RunTrigger; vars?: AutomationVars; quiet?: boolean} = {},
  ) {
    const bridge = native;
    if (!bridge) {
      const error = 'Automation needs the desktop app.';
      if (!options.quiet) {
        toast.setMessage(error);
      }
      return {ok: false as const, error};
    }
    // Every callAutomation reference, resolved against the loaded workspace
    // before anything launches. A dangling id or a cycle is a sentence here,
    // not a failed run three steps in.
    const tree = resolveCallTree(automation, state.automations);
    if (tree.problems.length > 0) {
      const error = tree.problems.join(' ');
      if (!options.quiet) {
        toast.fail(`Couldn't run ${automation.name}`, error);
      }
      return {ok: false as const, error};
    }
    // The variable bag this run starts with, assembled from the automation's
    // defaults, this profile's own answers and whatever the caller passed --
    // resolveRunVars owns that precedence, and the whole of it happens here
    // rather than in the runner, so the main process still receives one already
    // resolved `vars` object and knows nothing about parameters.
    //
    // Callee declarations come along because a callAutomation target shares
    // this bag: without their defaults, a callee's own default is invisible.
    const calleeParameters = Object.keys(tree.resolved).map((id) =>
      state.automations.find((entry) => entry.id === id)?.parameters || []);
    const vars = resolveRunVars({
      parameters: automation.parameters,
      calleeParameters,
      profileValues: profile.automation_vars?.[automation.id],
      overrides: options.vars,
    });
    // Better here than three steps in. An unresolved {{vars.x}} already fails
    // the step, but it fails it inside a browser the user cannot see, in a
    // sentence about interpolation rather than about the value they forgot.
    const missing = describeMissingParams(automation.parameters, vars);
    if (missing) {
      const error = `${profile.name} ${missing}. Set it on the profile, or in the Run dialog.`;
      if (!options.quiet) {
        toast.fail(`Couldn't run ${automation.name}`, error);
      }
      return {ok: false as const, error};
    }
    if (!options.quiet) {
      toast.setMessage(`Starting ${automation.name}`);
    }
    const result = await startRun(automation, profile, {
      trigger: options.trigger,
      vars,
      resolvedAutomations:
        Object.keys(tree.resolved).length > 0 ? tree.resolved : undefined,
      // Collected on the same pass, and from the same lists: the runner masks
      // these in the log and in the record it seals, because a run's vars are
      // readable by the whole workspace.
      secretVarNames: secretVarNames(automation.parameters, ...calleeParameters),
      buildLaunch: async (cdpPort) => {
        // The same gate the Launch button goes through, rather than reading
        // the proxy straight off state. This path used to do the latter, which
        // is how a dead proxy first showed up as a failed run several seconds
        // in, reported by the main process in a sentence naming a profile the
        // user never picked. resolveForLaunch checks it here, where the failure
        // can be attributed and shown, and returns 'blocked' when it must not
        // launch. null is a legitimate answer -- direct and free-proxy modes
        // have no proxy to resolve.
        const proxy = await proxies.resolveForLaunch(profile);
        if (proxy === 'blocked') {
          return {ok: false, error: `${profile.name}'s proxy failed its check.`};
        }
        // Minted here for the same reason the Launch button and the local API
        // both mint one: without it built-in-extensions.cjs writes neither
        // scout-launch.json nor scout-session.json, and the Scout Helper in the
        // window this run opens answers every question with "This window was not
        // launched from Scout Web Launcher" -- no proxy card, no automations, and,
        // the part that actually costs something, no cookie sync. A run that
        // logs a profile in would leave those cookies in the local jar and never
        // push them to the launcher or the cloud.
        //
        // The tiles are this profile's own start-page list, not the automation
        // being run: the run itself is driven over CDP from the main process and
        // needs no token. The token's list only authorizes what someone can
        // start from inside the browser, which is the same set a hand-launched
        // window offers. buildRunTile resolves it exactly as useProfileActions
        // does, so a panel run started during an automation run behaves the way
        // one started after a manual launch does.
        const tiles = startPageAutomations(state.automations, profile)
            .map((tile) => buildRunTile(tile, profile, state.automations));
        const runToken = await bridge.mintRunToken?.(
            profile.id, profile.name, orgId || '', cdpPort, tiles) || '';
        // From the running server rather than a second copy of the constant --
        // AUTOMATION_API_PORT lives in main.cjs.
        const apiPort = runToken ? (await bridge.getApiStatus?.())?.port : 0;
        return bridge.launchProfile(
            buildLaunchPayload(profile, proxy, state,
                runToken && apiPort ? {port: apiPort, token: runToken} : null),
            [`--remote-debugging-port=${cdpPort}`]);
      },
    });
    if (!result.ok) {
      if (!options.quiet) {
        toast.fail(`Couldn't run ${automation.name}`, result.error);
      }
      return result;
    }
    // Recorded on every successful start, whatever triggered it -- manual,
    // on-launch or an agent over the local API. The editor's Check button reads
    // it so it tests against the page this automation last ran on.
    lastRunProfileIds.current[automation.id] = profile.id;
    if (!options.quiet) {
      toast.setMessage(`Running ${automation.name}`);
    }
    // Returned as well as toasted: the API bridge answers its HTTP caller with
    // the run id, and a toast is no use to an agent.
    return result;
  }

  // One automation across several profiles, RUN_CONCURRENCY at a time.
  //
  // Paced on each run FINISHING, not on it starting. startRun resolves as soon
  // as the runner has accepted the run -- execute() is deliberately not awaited
  // over there -- so a queue built on startRun alone would launch every profile
  // at once and hit the runner's own cap, which refuses with a 429 instead of
  // waiting. waitForRun is what turns that cap into a queue.
  async function runMany(
      automation: ScoutAutomation,
      list: ScoutProfile[],
      options: {
        trigger?: RunTrigger;
        vars?: AutomationVars;
        // Per-profile overrides on top of `vars`, keyed by profile id. This is
        // what makes one dialog able to run Dortmund on one profile and Essen
        // on the next, and what MCP's varsByProfile lands in.
        varsByProfile?: Record<string, AutomationVars>;
      } = {},
  ) {
    // `vars` applies to every profile; varsByProfile overrides it for one.
    const varsFor = (profile: ScoutProfile) => ({
      ...options.vars,
      ...options.varsByProfile?.[profile.id],
    });
    if (list.length === 0) {
      return {started: 0, failed: 0};
    }
    if (list.length === 1) {
      // One profile is not a batch: it keeps the live messages and the real
      // error dialog, which are more use than a summary counting to one.
      const single = await run(automation, list[0],
          {trigger: options.trigger, vars: varsFor(list[0])});
      return {started: single.ok ? 1 : 0, failed: single.ok ? 0 : 1};
    }
    toast.setMessage(
        `Running ${automation.name} on ${list.length} profiles · ${RUN_CONCURRENCY} at a time`);
    const ceiling = runWaitCeiling(automation.timeout_ms);
    let started = 0;
    const failures: string[] = [];
    await mapWithConcurrency(list, RUN_CONCURRENCY, async (profile) => {
      const result = await run(automation, profile,
          {trigger: options.trigger, vars: varsFor(profile), quiet: true});
      if (!result.ok) {
        failures.push(`${profile.name}: ${result.error}`);
        return;
      }
      started++;
      // Holds this queue slot until the run ends. Null means the ceiling was
      // reached rather than the run failing -- the slot is given away, but the
      // run itself is still going and still writes its own record, so counting
      // it as a failure here would be a lie.
      await waitForRun(result.runId, ceiling);
    });
    if (failures.length) {
      // One dialog for the batch, with every profile that could not start named
      // in the detail -- the per-run history has the rest.
      toast.fail(
          `${started} of ${list.length} runs started`,
          failures.join('\n'));
    } else {
      toast.notify(`${started} runs finished · ${automation.name}`, {tone: 'ok'});
    }
    return {started, failed: failures.length};
  }

  return {
    runs, attach, exampleAutomation, newAutomation, run, runMany, save, setPinned,
    setStarred, setTelegramPref, linkTelegram, unlinkTelegram, testTelegram,
    cancelRun,
    // Trash. `softDelete` is what Delete means everywhere now; `purge` and
    // `purgeAll` are permanent and only Trash offers them.
    softDelete, restore, purge, purgeAll, assignToFolder,
    lastRunProfileId: (automationId: string) => lastRunProfileIds.current[automationId] || null,
  };
}
