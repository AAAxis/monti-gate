import {useRef, useState} from 'react';
import {
  Activity, AtSign, Cookie, Fingerprint, Folder, Globe, KeyRound, Link2, LogIn, Network,
  Rocket, SlidersHorizontal, StickyNote, Tag, Terminal, Trash2, UserCheck, UserRound, Workflow,
} from 'lucide-react';
import {Assignee} from '../ui/Assignee';
import {AvatarPicker} from '../ui/AvatarPicker';
import {BookmarkFavicon} from '../ui/BookmarkFavicon';
import {BusyButton} from '../ui/BusyButton';
import {ColorPicker} from '../ui/ColorPicker';
import {CookieSetLabel} from '../ui/CookieSetLabel';
import {EditorHead} from '../ui/EditorHead';
import {Field} from '../ui/Field';
import {FieldPicker} from '../ui/FieldPicker';
import {FolderLabel} from '../ui/FolderLabel';
import {FormGroup} from '../ui/FormGroup';
import {NotesPanel} from '../ui/NotesPanel';
import {InfoHint} from '../ui/InfoHint';
import {Modal} from '../ui/Modal';
import {ProfileAvatar} from '../ui/ProfileAvatar';
import {RotateButton} from '../ui/RotateButton';
import {SecretInput} from '../ui/SecretInput';
import {StatusChip, StatusPicker} from '../ui/StatusChip';
import {TagInput} from '../ui/TagInput';
import {AutomationMark} from '../automations/AutomationMark';
import {ProfileAutomationValues} from '../automations/ProfileAutomationValues';
import {FingerprintDatalists, FingerprintFields} from './FingerprintFields';
import {TimezoneOverrideModal} from './ConfirmModals';
import {ProfileSummary} from './ProfileSummary';
import {assigneeName} from '../../lib/assignees';
import {randomFingerprintPatch} from '../../lib/fingerprintPresets';
import {normalizeBookmarkUrl} from '../../lib/bookmarks';
import {proxyOptionLabel, parseProxyLink} from '../../lib/proxies';
import {timezoneMismatch} from '../../lib/proxyGeo';
import {MAX_PROFILE_TAGS} from '../../lib/tags';
import {draftFromProfile, profileFromDraft, tagsFromDraft} from '../../drafts';
import {useAsyncAction} from '../../useAsyncAction';
import {useOrg} from '../../org';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {CellOption} from '../ui/CellControls';
import type {SummaryTarget} from './ProfileSummary';
import type {ProfileDraft, ProxyDraft} from '../../drafts';
import type {TimezoneOverrideRequest} from './ConfirmModals';

// Stable ids so the Summary panel's per-group Edit actions can lead back to the
// block they describe. The proxy field already needed one for its datalist.
//
// The Profile group lands on the Account card rather than on a single control:
// the name it used to focus is in the sticky header now, which is on screen
// whatever the form is scrolled to and so cannot be scrolled back to.
const ACCOUNT_GROUP_ID = 'profile-account-group';
const PROXY_FIELD_ID = 'profile-proxy-input';

export type ProfileModalProps = {
  draft: ProfileDraft;
  onChange: (draft: ProfileDraft) => void;
  onClose: () => void;
  onNewStatus: () => void;
  onPickCookies: () => void;
  // Opens the proxy dialog seeded from the profile's "create new proxy" field,
  // so the new proxy comes back assigned to this draft.
  onCreateProxy: (seed: ProxyDraft) => void;
  onRequestDelete: (profileIds: string[], label: string) => void;
  // Open with the fingerprint section already expanded. Set when the dialog was
  // raised from the Profiles table's Browser or Screen cell, which show those
  // values but deliberately do not set them -- a screen chosen on its own would
  // contradict the platform preset that re-rolls it alongside the GPU and CPU.
  openFingerprint?: boolean;
};

export function ProfileModal({
  draft,
  onChange,
  onClose,
  onNewStatus,
  onPickCookies,
  onCreateProxy,
  onRequestDelete,
  openFingerprint = false,
}: ProfileModalProps) {
  const {data, toast, profiles, shared, statusOptions, tagOptions, reload} = useWorkspace();
  const org = useOrg();
  const orgId = org.orgId;
  const state = data.state;
  // Live ones only: this feeds the "run on launch" picker and the per-profile
  // parameter values below it, and neither should offer something in Trash.
  const automations = state.automations.filter((automation) => !automation.deleted_at);
  const {run, isPending} = useAsyncAction();
  // An initialiser, not an effect: the dialog is unmounted between opens, so
  // there is never a mounted instance whose prop changes under it.
  const [fingerprintOpen, setFingerprintOpen] = useState(openFingerprint);
  // Proxy and Cookies edit in nested dialogs of their own, the way the
  // fingerprint does: the Summary panel is where their values live, and its
  // pencil is the way in.
  const [proxyOpen, setProxyOpen] = useState(false);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  // While the proxy combobox has focus it shows what the user is typing; when
  // it does not, it shows the assigned proxy's label.
  const [proxyPickerFocused, setProxyPickerFocused] = useState(false);

  const set = (patch: Partial<ProfileDraft>) => onChange({...draft, ...patch});
  const rotate = () => set(randomFingerprintPatch(draft.fingerprint_os));

  // Whether Save has anything to do. A new profile always does -- there is no
  // stored row to be identical to -- so this only answers the question for one
  // that exists.
  //
  // Compared draft-to-draft rather than draft-to-profile: profileFromDraft
  // trims, defaults and drops empty fields, so a draft that has not been touched
  // does not round-trip to something equal to itself. Rebuilding the draft the
  // dialog would have opened with puts both sides in the same shape.
  //
  // proxy_search and proxy_link are excluded because they are not the profile:
  // one holds what is being typed into the combobox and the other is a paste
  // buffer for creating a proxy, and neither is saved.
  function dirty() {
    const stored = state.profiles.find((item) => item.id === draft.id);
    if (!draft.saved || !stored) {
      return true;
    }
    const strip = ({proxy_search, proxy_link, ...rest}: ProfileDraft) => rest;
    return JSON.stringify(strip(draftFromProfile(stored))) !== JSON.stringify(strip(draft));
  }

  // A timezone that contradicts the proxy is confirmed once, then remembered for
  // as long as this dialog is open, so re-picking a zone the user already stood
  // behind does not ask again. Keyed by zone and proxy together: change either
  // and the old consent no longer describes the situation it was given for.
  const acknowledgedTimezones = useRef(new Set<string>());
  const [pendingTimezone, setPendingTimezone] = useState<TimezoneOverrideRequest | null>(null);

  function assignedProxy() {
    return state.proxies.find((item) => item.id === draft.proxy_id) || null;
  }

  // The three pickers' rows. Each renders the thing's own mark, so the option
  // list and the closed control show the same object -- which is the whole
  // reason these are not <select>s any more.

  // Yourself first and named "You", the word the Assignee chip uses. Mirrors
  // assigneeOptions() in tables/profileColumns.tsx, and deliberately: a profile
  // must not read "Anna" in the table and "anna.k" in its own editor.
  function assigneeOptions(): CellOption[] {
    const rows = state.members.map((member) => ({
      value: member.user_id,
      // The || is unreachable -- assigneeName only returns undefined for a
      // missing id, and this one came out of the roster -- but the signature
      // allows it because the sort comparators depend on that.
      label: member.user_id === org.userId ?
        'You' :
        assigneeName(member.user_id, state.members) || member.email,
      searchText: `${member.display_name || ''} ${member.email}`.toLowerCase(),
      render: <Assignee key={member.user_id} userId={member.user_id} />,
      hint: member.email,
    }));
    return [
      ...rows.filter((row) => row.value === org.userId),
      ...rows.filter((row) => row.value !== org.userId),
    ];
  }

  function folderOptions(): CellOption[] {
    return state.folders.map((folder) => ({
      value: folder.id,
      label: folder.name,
      render: <FolderLabel key={folder.id} folder={folder} fallback="All profiles" />,
    }));
  }

  function automationOptions(): CellOption[] {
    return automations.map((automation) => ({
      value: automation.id,
      label: automation.name,
      render: (
        <span className="picker-mark-row" key={automation.id}>
          <AutomationMark icon={automation.icon} color={automation.color} size={18} />
          {automation.name}
        </span>
      ),
    }));
  }

  // The attached automation, drawn the way the option row draws it. A plain
  // word when nothing is attached: "Nothing" is the absence of a choice and
  // should not arrive wearing a mark.
  function automationTrigger() {
    const attached = automations.find((item) => item.id === draft.automation_id);
    if (!attached) {
      return <span className="cell-muted">Nothing</span>;
    }
    return (
      <span className="picker-mark-row">
        <AutomationMark icon={attached.icon} color={attached.color} size={18} />
        {attached.name}
      </span>
    );
  }

  function requestTimezone(value: string) {
    const mismatch = timezoneMismatch(value, assignedProxy());
    const key = `${value}|${draft.proxy_id}`;
    if (!mismatch || acknowledgedTimezones.current.has(key)) {
      set({fingerprint_timezone: value});
      return;
    }
    setPendingTimezone(mismatch);
  }

  function confirmTimezone() {
    if (!pendingTimezone) {
      return;
    }
    acknowledgedTimezones.current.add(`${pendingTimezone.chosen}|${draft.proxy_id}`);
    set({fingerprint_timezone: pendingTimezone.chosen});
    setPendingTimezone(null);
  }

  function proxyFieldValue() {
    if (proxyPickerFocused || draft.proxy_search) {
      return draft.proxy_search;
    }
    const proxy = state.proxies.find((item) => item.id === draft.proxy_id);
    return proxy ? proxyOptionLabel(proxy) : 'Proxy required';
  }

  function matchProxy(value: string) {
    return state.proxies.find((proxy) =>
      proxyOptionLabel(proxy) === value ||
      proxy.id === value ||
      `${proxy.host}:${proxy.port}` === value);
  }

  function filteredProxies() {
    const query = draft.proxy_search.trim().toLowerCase();
    if (!query) {
      return state.proxies;
    }
    return state.proxies.filter((proxy) =>
      [proxy.name, proxy.host, proxy.type, String(proxy.port), proxy.username]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query));
  }

  function createProxyFromLink() {
    const value = draft.proxy_link.trim();
    if (!value) {
      onCreateProxy({name: '', type: 'socks5', host: '', port: '', username: '', password: ''});
      return;
    }
    const parsed = parseProxyLink(value);
    if (!parsed) {
      toast.setMessage('Proxy link is invalid. Use http://user:pass@host:port, socks5://user:pass@host:port, or http:host:port:user:pass');
      return;
    }
    onCreateProxy({
      name: '',
      type: parsed.type || 'http',
      host: parsed.host,
      port: String(parsed.port),
      username: parsed.username || '',
      password: parsed.password || '',
    });
  }

  // Trashed sets are not offerable: assigning one would put a profile back on
  // cookies the user has already thrown away, and the launch path refuses to
  // resolve it anyway. Same filter CookiePickerModal applies.
  function cookieOptions(): CellOption[] {
    return state.cookies.filter((cookie) => !cookie.deleted_at).map((cookie) => {
      const folder = state.cookie_folders.find((item) => item.id === cookie.folder_id);
      return {
        value: cookie.id,
        label: cookie.name,
        searchText: `${cookie.name} ${folder?.name || ''}`.toLowerCase(),
        render: (
          <CookieSetLabel cookie={cookie} folders={state.cookie_folders} key={cookie.id} />
        ),
        // The folder, because two sets called "cookies.txt" are only told apart
        // by where they were filed -- the same line the library dialog shows.
        hint: [folder?.name, cookie.count ? `${cookie.count} cookies` : '']
            .filter(Boolean).join(' · '),
      };
    });
  }

  // The attached set, with its mark and the count it has always shown. A set
  // the workspace no longer holds falls back to the bare id: the profile still
  // points at something, and blanking the field would read as "no cookies".
  function cookieTrigger() {
    if (draft.cookie_mode !== 'saved' || !draft.cookie_id) {
      return <span className="cell-muted">No cookies</span>;
    }
    const cookie = state.cookies.find((item) => item.id === draft.cookie_id);
    if (!cookie) {
      return <span>{draft.cookie_id}</span>;
    }
    return (
      <CookieSetLabel
        cookie={cookie}
        folders={state.cookie_folders}
        text={cookie.count ? `${cookie.name} (${cookie.count} cookies)` : cookie.name}
      />
    );
  }

  // Where a Summary group's Edit button lands: each opens the nested dialog
  // that owns those values.
  function editSummaryGroup(target: SummaryTarget) {
    if (target === 'fingerprint') {
      setFingerprintOpen(true);
    } else if (target === 'proxy') {
      setProxyOpen(true);
    } else if (target === 'cookies') {
      setCookiesOpen(true);
    }
  }

  async function save() {
    const name = draft.name.trim();
    if (!name) {
      toast.setMessage('Profile name is required');
      return;
    }
    if (draft.proxy_mode === 'assigned' &&
        (!draft.proxy_id || !state.proxies.some((proxy) => proxy.id === draft.proxy_id))) {
      toast.setMessage('Proxy is required, or pick Direct / Free Proxy instead.');
      return;
    }
    const createdAt = draft.saved ?
      state.profiles.find((item) => item.id === draft.id)?.created_at :
      new Date().toISOString();
    const profile = profileFromDraft(draft, createdAt);
    // A row written before the cap existed -- by an import or the API -- can
    // arrive here with more tags than the editor will keep. profileFromDraft
    // trims it either way; saying so is the difference between a rule and a
    // tag quietly going missing.
    const dropped = tagsFromDraft(draft.tags).length - (profile.tags?.length || 0);
    // What the row holds now, read before the save: for an existing profile the
    // stored value, for a new one the auth.uid() default the insert is about to
    // apply. Both are "where assignment will land if we do nothing".
    const assignedNow = draft.saved ?
      state.profiles.find((item) => item.id === draft.id)?.assigned_to || '' :
      org.userId || '';
    // On failure withDb has already surfaced the real error; don't overwrite it
    // with a false "saved" toast, and keep the dialog open so edits aren't lost.
    if (!await profiles.save(profile)) {
      return;
    }
    // A second call rather than a field on the save, because profileToRow omits
    // assigned_to on purpose -- it is owned by set_assignee so a stale edit
    // cannot silently unassign a row somebody else just claimed. Only when it
    // actually changed: an unrelated rename should not rewrite the assignment,
    // and for a new profile the column default has already done this job.
    //
    // After the save, never before: set_assignee is an UPDATE, and on a profile
    // being created for the first time there is no row yet to update.
    if (draft.assigned_to !== assignedNow && orgId) {
      await shared.setAssignee(
          orgId, 'profile', profile.id, draft.assigned_to || null, reload);
    }
    onClose();
    toast.setMessage(dropped > 0 ?
      `${profile.name} saved — kept the first ${MAX_PROFILE_TAGS} tags` :
      `${profile.name} saved`);
  }

  return (
    <>
      <Modal
        // `editor-modal` carries the sticky header and the repositioned close
        // X, shared with the automation editor; `profile-editor-modal` is what
        // fills this dialog's Save, which the automation bar deliberately does
        // not do -- see editor-head.css.
        className="editor-modal profile-editor-modal"
        onClose={onClose}
        // One header instead of a header and a footer, the arrangement the
        // automation editor already uses. The avatar and the name were the
        // third and first fields of the Account card; they are the heading
        // now, so the thing you are editing is named at the top of the dialog
        // rather than found halfway down it.
        header={
          <EditorHead
            mark={<ProfileAvatar profile={{name: draft.name, color: draft.color, avatar: draft.avatar}} />}
            markLabel={`Change the picture and colour for ${draft.name.trim() || 'this profile'}`}
            markPop={
              <>
                <Field
                  label="Avatar"
                  hint="A picture or a site's logo, shown beside the name in the profiles list."
                  group
                >
                  <AvatarPicker
                    color={draft.color}
                    name={draft.name}
                    onChange={(avatar) => set({avatar})}
                    onError={(message) => toast.setMessage(message)}
                    onUpload={(file) => profiles.uploadAvatar(draft.id, file)}
                    value={draft.avatar}
                  />
                </Field>
                <Field
                  label="Colour"
                  // Says where it lands, because with a picture or a logo set
                  // it is no longer behind the mark -- the colour is what an
                  // empty avatar falls back to.
                  hint="The plate behind the initials, when there is no picture."
                  group
                >
                  <ColorPicker value={draft.color} onChange={(color) => set({color})} />
                </Field>
              </>
            }
            noun="profile"
            name={draft.name}
            onNameChange={(name) => set({name})}
            // Status and folder: the two things that place a profile, on the
            // line under its name. Both are still editable in the Account card
            // -- this is the header saying what it is, not a second control.
            meta={
              <>
                <StatusChip status={draft.status || 'Ready'} />
                <FolderLabel
                  folder={state.folders.find((item) => item.id === draft.folder_id)}
                  fallback="All profiles"
                />
              </>
            }
            actions={
              <div className="editor-head-actions-end">
                {draft.saved && (
                  <button
                    className="ghost danger"
                    type="button"
                    onClick={() => onRequestDelete([draft.id], draft.name)}
                  >
                    <Trash2 size={16} /> Delete
                  </button>
                )}
                <button className="ghost" type="button" onClick={onClose}>Cancel</button>
                <BusyButton
                  busy={isPending('save-profile')}
                  busyLabel="Saving…"
                  disabled={!dirty()}
                  title={dirty() ? undefined : 'No changes to save'}
                  onClick={() => void run('save-profile', save)}
                >
                  {draft.saved ? 'Save changes' : 'Create profile'}
                </BusyButton>
              </div>
            }
          />
        }
      >
        <div className="profile-editor-layout">
          <div className="profile-form profile-editor-main">
            {/* Six titled sections rather than seventeen fields in a row.
              * Unsectioned, this form gave no answer to "where do I change the
              * proxy" short of reading every label top to bottom -- and the two
              * things people actually come here to change, the proxy and the
              * cookies, were separated by nine fields that have nothing to do
              * with either. The order is the order the questions get asked:
              * who is this, how does it connect, what does it look like, what
              * is it carrying, what happens on launch, and what should the next
              * person know. */}
            <FormGroup
              hint="How you find this profile again in a table of forty."
              icon={<UserRound size={14} />}
              id={ACCOUNT_GROUP_ID}
              title="Account"
            >
              <Field label="Status" icon={<Activity size={14} />} wide group>
                <StatusPicker
                  status={statusOptions.includes(draft.status) ? draft.status : 'Ready'}
                  options={statusOptions}
                  onChange={(status) => set({status})}
                  onNewStatus={onNewStatus}
                />
              </Field>
              <Field
                label="Tags"
                icon={<Tag size={14} />}
                hint={`Up to ${MAX_PROFILE_TAGS}. Click a suggestion, or type your own — Enter or ` +
                  'comma adds it. Tags filter and search the profiles list.'}
                wide
                // Same reason the Status field is a group: the suggestion row and
                // the chips' remove buttons sit inside this field, and a <label>
                // wrapping them fires its implicit activation of the text input
                // instead of the button that was actually clicked.
                group
              >
                <TagInput
                  options={tagOptions}
                  placeholder="warmup, client-a"
                  value={tagsFromDraft(draft.tags)}
                  onChange={(tags) => set({tags: tags.join(', ')})}
                />
              </Field>
              {/* A picker rather than a <select>, so the folder keeps the glyph
                  and colour it is drawn with everywhere else. Same for the two
                  below it -- see FieldPicker. */}
              <Field label="Folder" icon={<Folder size={14} />} wide group>
                <FieldPicker
                  label="Move this profile to a folder"
                  noneLabel="All profiles"
                  onPick={(folder_id) => set({folder_id})}
                  options={folderOptions()}
                  searchPlaceholder="Search folders…"
                  trigger={
                    <FolderLabel
                      folder={state.folders.find((item) => item.id === draft.folder_id)}
                      fallback="All profiles"
                    />
                  }
                  value={draft.folder_id}
                />
              </Field>
              {/* Only once there is somebody to assign to. A one-person workspace
                  gets a picker whose every option is "you", which is the same
                  reason the Assigned column is teamOnly. */}
              {state.members.length > 1 && (
                <Field
                  label="Assigned to"
                  icon={<UserCheck size={14} />}
                  hint="Who's looking after this profile. Everyone on the team can still open it — this is a label, not a lock."
                  wide
                  group
                >
                  <FieldPicker
                    label="Assign this profile to a teammate"
                    noneLabel="Unassigned"
                    onPick={(assigned_to) => set({assigned_to})}
                    options={assigneeOptions()}
                    searchPlaceholder="Search teammates…"
                    // The Assigned column's own chip, so the person you picked
                    // looks the same here as in the table you picked them for.
                    trigger={<Assignee userId={draft.assigned_to || null} />}
                    value={draft.assigned_to}
                  />
                </Field>
              )}
            </FormGroup>

            {/* Its own card, not the tail of Account.
              *
              * These three are the only fields in this dialog that EasyDeck itself
              * never acts on, and the only ones that are dangerous to
              * misunderstand -- so the block needs a heading that says what
              * they are and a hint that says what they are not. Buried under
              * Folder and Assigned-to, "Account password" read as though the
              * app would use it. */}
            <FormGroup
              hint="The login this profile is signed into, kept beside it so whoever picks the profile up has it."
              icon={<KeyRound size={14} />}
              info={
                <InfoHint label="Credentials">
                  <p>
                    <strong>EasyDeck does not fill these in.</strong> Nothing is typed into a page
                    when the profile launches, and they are never sent to the browser. They are
                    here so the login travels with the profile instead of in someone&apos;s head.
                  </p>
                  <p>
                    An <strong>automation</strong> can use them: a Type step resolves{' '}
                    <code>{'{{profile.email}}'}</code> and <code>{'{{profile.password}}'}</code>,
                    and a Go-to step resolves <code>{'{{profile.login_url}}'}</code> — so one
                    sign-in workflow can run against every profile at its own address.
                  </p>
                  <p>
                    Stored with your cloud data <strong>in plaintext</strong> — anyone with
                    access to the organization can read them, and so can an agent connected over
                    MCP.
                  </p>
                </InfoHint>
              }
              title="Credentials"
            >
              {/* Side by side, not one per row: they are one credential in two
                  boxes, and stacked full-width they read as two unrelated
                  settings that happen to be adjacent. */}
              <Field label="Account email" icon={<AtSign size={14} />}>
                <input
                  type="email"
                  placeholder="you@example.com"
                  value={draft.email}
                  onChange={(event) => set({email: event.target.value})}
                />
              </Field>
              {/* Revealable. A write-only box guards nothing here: the profiles
                  table already shows the email in a column, the value is stored
                  in plaintext, and the whole point of the field is that whoever
                  has the profile can read the login. */}
              <Field label="Account password" icon={<KeyRound size={14} />}>
                <SecretInput
                  value={draft.password}
                  onChange={(password) => set({password})}
                />
              </Field>
              <Field
                label="Login URL"
                icon={<LogIn size={14} />}
                hint="The sign-in page these belong to. A note for whoever opens this profile —
                  and the address an automation reads as {{profile.login_url}}."
                wide
              >
                <input
                  type="text"
                  placeholder="https://example.com/login"
                  value={draft.login_url}
                  onChange={(event) => set({login_url: event.target.value})}
                />
              </Field>
            </FormGroup>

            <FormGroup
              hint="What happens when you press Launch."
              icon={<Rocket size={14} />}
              title="Launch"
            >
              <Field label="Start page" icon={<Globe size={14} />} wide>
                <input
                  type="text"
                  placeholder="Leave empty for shared bookmarks home"
                  value={draft.start_url}
                  onChange={(event) => set({start_url: event.target.value})}
                />
                <StartPageChips value={draft.start_url} onPick={(start_url) => set({start_url})} />
              </Field>
              <Field
                label="Run on launch"
                icon={<Workflow size={14} />}
                hint={draft.automation_id ?
                  'Opens a DevTools port for this launch only, so the workflow can drive it.' :
                  'Runs an automation automatically once this profile is open.'}
                wide
                group
              >
                <FieldPicker
                  label="Choose what runs when this profile launches"
                  noneLabel="Nothing"
                  empty="No automations yet"
                  onPick={(automation_id) => set({automation_id})}
                  options={automationOptions()}
                  searchPlaceholder="Search automations…"
                  trigger={automationTrigger()}
                  value={draft.automation_id}
                />
              </Field>
              {/* Directly under the picker, because the first question after
                  "which automation" is "with what". `group`, not a label: the
                  block is a set of controls and a <label> around them would fire
                  its implicit activation on the first one. */}
              <Field
                label="Automation values"
                icon={<SlidersHorizontal size={14} />}
                hint="What this profile answers when an automation asks. One workflow can
                  then run a different city, group or account per profile."
                wide
                group
              >
                <ProfileAutomationValues
                  automations={automations}
                  attachedId={draft.automation_id}
                  value={draft.automation_vars}
                  onChange={(automation_vars) => set({automation_vars})}
                />
              </Field>
              <Field
                label="Command line switches"
                icon={<Terminal size={14} />}
                info={
                  <InfoHint label="Command line switches">
                    <p>
                      Extra Chromium flags, passed to the browser when this profile launches.
                      One per line.
                    </p>
                    <p>
                      Use the full <code>--flag</code> or <code>--flag=value</code> form, for
                      example <code>--lang=en-US</code> or{' '}
                      <code>--disable-features=ExampleFeature</code>.
                    </p>
                    <p>
                      A flag that contradicts the fingerprint above wins — the browser applies
                      what it is given, so a bad switch here can undo the identity settings.
                    </p>
                  </InfoHint>
                }
                wide
              >
                <textarea
                  placeholder="--disable-features=ExampleFeature&#10;--lang=en-US"
                  value={draft.command_line_switches}
                  onChange={(event) => set({command_line_switches: event.target.value})}
                />
              </Field>
            </FormGroup>

            {/* Saved profiles only: a note is a row keyed on a profile id, and
              * a profile being created does not have one in the database yet.
              * Last, because it is the section you come back to rather than the
              * one you fill in -- everything above is set once. */}
            {draft.saved && (
              <FormGroup
                hint="Why this profile exists, and anything worth knowing before using it. Everyone in the workspace can read and add; only the author can change their own."
                icon={<StickyNote size={14} />}
                title="Notes"
              >
                <div className="form-group-full">
                  <NotesPanel profileId={draft.id} />
                </div>
              </FormGroup>
            )}
          </div>

          <ProfileSummary draft={draft} onRotate={rotate} onEdit={editSummaryGroup} />
        </div>

        <FingerprintDatalists />
      </Modal>

      {fingerprintOpen && (
        <Modal
          nested
          className="fingerprint-modal"
          onClose={() => setFingerprintOpen(false)}
          title="Edit fingerprint"
          subtitle="Profile-level browser identity settings stored with cloud data."
          footer={
            <>
              <RotateButton onRotate={rotate}>Rotate fingerprint</RotateButton>
              <button onClick={() => setFingerprintOpen(false)}>Done</button>
            </>
          }
        >
          <div className="profile-form">
            <FingerprintFields
              draft={draft}
              onChange={onChange}
              requestTimezone={requestTimezone}
              timezoneWarning={timezoneMismatch(draft.fingerprint_timezone, assignedProxy())}
            />
          </div>
        </Modal>
      )}

      {proxyOpen && (
        <Modal
          nested
          className="fingerprint-modal"
          onClose={() => setProxyOpen(false)}
          title="Edit proxy"
          subtitle="How this profile reaches the internet. Everything it opens goes out this way."
          footer={<button onClick={() => setProxyOpen(false)}>Done</button>}
        >
          <div className="profile-form">
            <FormGroup
              hint="How this profile reaches the internet. Everything it opens goes out this way."
              icon={<Network size={14} />}
              title="Proxy"
            >
              {/* The three modes each needed a sentence of explanation. They used
                * to be two conditional .field-hint paragraphs that appeared and
                * disappeared under the control, moving the rest of the form. */}
              <Field
                label="Proxy mode"
                icon={<Network size={14} />}
                info={
                  <InfoHint label="Proxy mode">
                    <p>
                      <strong>Assigned proxy</strong> routes this profile through one proxy from
                      your library. Saving or launching needs one picked.
                    </p>
                    <p>
                      <strong>Direct</strong> sends traffic straight out with no proxy and no
                      fallback extension — your own IP.
                    </p>
                    <p>
                      <strong>Free Proxy</strong> loads the bundled FoxyWall Proxy extension
                      instead of assigning one, and connects through it.
                    </p>
                  </InfoHint>
                }
                wide
                group
              >
                <div className="choice-chips" role="radiogroup" aria-label="Proxy mode">
                  {(['assigned', 'direct', 'free_proxy'] as const).map((mode) => (
                    <button
                      aria-checked={draft.proxy_mode === mode}
                      className={draft.proxy_mode === mode ? 'choice-chip active' : 'choice-chip'}
                      key={mode}
                      onClick={() => set({proxy_mode: mode})}
                      role="radio"
                      type="button"
                    >
                      {mode === 'assigned' ? 'Assigned proxy' : mode === 'direct' ? 'Direct' : 'Free Proxy'}
                    </button>
                  ))}
                </div>
              </Field>
              {/* One field per row rather than the two-up grid these used to share:
                * the search box and the connection-string box looked like one
                * control split in half, and Create new proxy was wedged in beside
                * the second of them. */}
              {draft.proxy_mode === 'assigned' && (
                <>
                  <Field label="Proxy" icon={<Network size={14} />} wide>
                    <input
                      type="text"
                      id={PROXY_FIELD_ID}
                      list="profile-proxy-options"
                      placeholder="Search and select proxy"
                      value={proxyFieldValue()}
                      onFocus={() => {
                        setProxyPickerFocused(true);
                        set({proxy_search: ''});
                      }}
                      onChange={(event) => {
                        const value = event.target.value;
                        if (!value.trim() || value === 'Direct connection') {
                          set({proxy_search: ''});
                          return;
                        }
                        set({proxy_id: matchProxy(value)?.id || '', proxy_search: value});
                      }}
                      onBlur={() => {
                        setProxyPickerFocused(false);
                        const value = draft.proxy_search.trim();
                        if (!value || value === 'Direct connection') {
                          set({proxy_search: ''});
                          return;
                        }
                        const matched = matchProxy(value);
                        if (matched) {
                          set({proxy_id: matched.id, proxy_search: ''});
                        }
                      }}
                    />
                    <datalist id="profile-proxy-options">
                      {filteredProxies().map((proxy) => (
                        <option value={proxyOptionLabel(proxy)} key={proxy.id} />
                      ))}
                    </datalist>
                  </Field>
                  <Field
                    label="Or add a new proxy"
                    icon={<Link2 size={14} />}
                    info={
                      <InfoHint label="Adding a proxy">
                        <p>
                          Paste a connection string to create the proxy and assign it to this
                          profile in one step. It joins your proxy library, so other profiles can
                          pick it afterwards.
                        </p>
                        <p>
                          Both shapes are accepted: <code>socks5://user:pass@host:port</code> and
                          the vendor form <code>socks5://host:port:user:pass</code>.
                        </p>
                      </InfoHint>
                    }
                    wide
                  >
                    <div className="stacked-action">
                      <input
                        type="text"
                        placeholder="http://user:pass@host:port or socks5://host:port:user:pass"
                        value={draft.proxy_link}
                        onChange={(event) => set({proxy_link: event.target.value})}
                      />
                      <button className="ghost" type="button" onClick={createProxyFromLink}>
                        Create new proxy
                      </button>
                    </div>
                  </Field>
                </>
              )}
            </FormGroup>
          </div>
        </Modal>
      )}

      {cookiesOpen && (
        <Modal
          nested
          className="fingerprint-modal"
          onClose={() => setCookiesOpen(false)}
          title="Edit cookies"
          subtitle="What this profile launches with. Files are cloud-synced to the whole workspace."
          footer={<button onClick={() => setCookiesOpen(false)}>Done</button>}
        >
          <div className="profile-form">
            <FormGroup
              hint="Upload a JSON or Netscape cookies.txt file to cloud sync and import it when this profile launches."
              icon={<Cookie size={14} />}
              info={
                <InfoHint label="Cookie import">
                  <p>
                    Takes a JSON export or a Netscape <code>cookies.txt</code>. Both are what
                    the usual browser cookie-export extensions produce.
                  </p>
                  <p>
                    The file is uploaded to cloud sync, so every machine in the organization
                    launches this profile with the same cookies.
                  </p>
                  <p>
                    They are seeded at launch through a temporary generated extension in the
                    profile directory, not written into the cookie database directly.
                  </p>
                </InfoHint>
              }
              title="Cookies"
            >
              {/* The library as a dropdown, like the other three things this
                  form picks -- and for the same reason: a cookie-set has a
                  colour, so choosing one should show the mark it will be
                  recognised by afterwards rather than a filename. Uploading a
                  new file is not one of the options, so it rides the footer and
                  still opens the library dialog, which owns that path. */}
              <Field label="Cookie set" icon={<Cookie size={14} />} wide group>
                <FieldPicker
                  label="Choose the cookies this profile launches with"
                  noneLabel="No cookies"
                  empty="No cookie-sets saved yet"
                  onPick={(cookie_id) => set({
                    cookie_mode: cookie_id ? 'saved' : 'paste',
                    cookie_id,
                    // Clearing the set clears the imported file with it. All
                    // five fields go together -- see AGENTS.md on cookie
                    // clearing -- or the card shows a set and a file at once.
                    ...(cookie_id ? {} : {
                      cookie_import_path: '',
                      cookie_import_url: '',
                      cookie_import_name: '',
                      cookie_import_count: 0,
                    }),
                  })}
                  options={cookieOptions()}
                  searchPlaceholder="Search cookie-sets…"
                  trigger={cookieTrigger()}
                  value={draft.cookie_mode === 'saved' ? draft.cookie_id : ''}
                  footer={(close) => (
                    <button
                      className="ghost"
                      type="button"
                      onClick={() => {
                        close();
                        onPickCookies();
                      }}
                    >Upload new…</button>
                  )}
                />
              </Field>
              {/* A file imported straight into this profile rather than picked
                  from the library -- what the importer and the older upload
                  path produce. It is not one of the picker's options, because
                  it is not in the library to be offered, so it keeps a row of
                  its own and its own way of being cleared. */}
              {draft.cookie_mode !== 'saved' &&
                (draft.cookie_import_path || draft.cookie_import_url) && (
                <div className="file-row wide">
                  <span>
                    {draft.cookie_import_count || 0} cookies · {draft.cookie_import_name ||
                      (draft.cookie_import_url ? 'Cloud cookie file' : draft.cookie_import_path)}
                  </span>
                  <button
                    className="icon-button danger-icon"
                    type="button"
                    aria-label="Clear cookie import"
                    onClick={() => set({
                      cookie_import_path: '',
                      cookie_import_url: '',
                      cookie_import_name: '',
                      cookie_import_count: 0,
                    })}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </FormGroup>
          </div>
        </Modal>
      )}
      {pendingTimezone && (
        <TimezoneOverrideModal
          request={pendingTimezone}
          onCancel={() => setPendingTimezone(null)}
          onConfirm={confirmTimezone}
        />
      )}
    </>
  );
}

// The shared bookmarks, as one-click values for the start page. Hidden when the
// workspace has none rather than rendering a lone "home" chip that explains
// nothing.
function StartPageChips({value, onPick}: {value: string; onPick: (url: string) => void}) {
  const {data} = useWorkspace();
  const bookmarks = data.state.shared_bookmarks;
  if (!bookmarks.length) {
    return null;
  }
  const current = normalizeBookmarkUrl(value);
  return (
    <div className="bookmark-chips">
      <button
        className={value.trim() ? 'bookmark-chip' : 'bookmark-chip active'}
        onClick={() => onPick('')}
        type="button"
      >
        <span>Shared bookmarks home</span>
      </button>
      {bookmarks.map((bookmark) => (
        <button
          className={current && current === normalizeBookmarkUrl(bookmark.url) ?
            'bookmark-chip active' :
            'bookmark-chip'}
          key={bookmark.id || bookmark.url}
          onClick={() => onPick(bookmark.url)}
          title={`${bookmark.title || bookmark.url} — ${bookmark.url}`}
          type="button"
        >
          <BookmarkFavicon bookmark={bookmark} />
          <span>{bookmark.title || bookmark.url}</span>
        </button>
      ))}
    </div>
  );
}
