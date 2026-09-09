// "Who is this workspace for?" -- asked once, on the first run of a workspace
// nobody has answered for.
//
// The desktop half of the website's /onboarding page. Both exist because both
// can create an account: the website has signup, and the launcher's sign-in
// screen also creates one on first code ("No password needed -- entering your
// email creates your account"). Whichever one a person arrives through, the
// question is asked once and the answer is the same row.
//
// The two are deliberately NOT a shared component -- separate repos, different
// React versions, different styling systems -- but they are the same two steps
// in the same order, they write the same columns, and they use the same gate
// (organizations.onboarded_at). Change one, change the other.
//
// What it does NOT do: gate anything. Every field except the first question is
// optional, "Not now" is always available, and nothing here changes a limit or a
// price. A workspace that skips it is a workspace with nulls in six columns, not
// a degraded one.
//
// Two modes, one component. `onboard` is the original: a workspace already
// exists and nobody has said what it is for. `create` is the same two questions
// asked before there is a workspace at all, for the "Create workspace" entry in
// the sidebar switcher. They share every field, both write the same columns, and
// splitting them would be two dialogs to keep in step for the sake of one extra
// text input -- so the differences are called out inline instead. There are four:
// the name field, the footer button, `autoNamed`, and what save() writes to.
import {useMemo, useRef, useState} from 'react';
import {Building2, ImageUp, User} from 'lucide-react';
import {Modal} from '../ui/Modal';
import {countryChoices} from '../../data/folderIcons';
import * as db from '../../db';
import {describeDbError} from '../../db/errors';
import {LOGO_MAX_BYTES, uploadOrgLogo} from '../../db/orgLogo';
import type {OrgType} from '../../types';

export function WorkspaceSetupModal({mode = 'onboard', orgId, orgName, onDone, onCancel}: {
  mode?: 'onboard' | 'create';
  // Null in create mode: the workspace does not exist until save() makes it.
  orgId: string | null;
  orgName: string;
  // Called with the workspace this answered for -- the existing one in onboard
  // mode, the new one in create mode. In onboard mode it also fires when the
  // user declines, because the prompt does not come back either way: both paths
  // stamp onboarded_at.
  onDone: (orgId: string) => void;
  // Create mode only, and required there. Onboard mode has no cancel -- "Not
  // now" is an answer, and it is recorded as one.
  onCancel?: () => void;
}) {
  const creating = mode === 'create';
  const countries = useMemo(() => countryChoices(), []);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Whether the workspace still carries the name bootstrap_org derived from the
  // signup address ("gmail.com team"), captured at mount.
  //
  // In a useState initialiser, not a render-time expression, because `save`
  // writes `name` and the answer has to be the one from BEFORE that write --
  // otherwise editing the business name a second time would re-adopt it over a
  // workspace name the user had since chosen.
  //
  // Mount is a safe moment to read it: App only renders this component once
  // org.ready is true, so `orgName` is the real row rather than the undefined of
  // a first fetch.
  //
  // Always false in create mode. The whole question is "may the business name
  // overwrite the workspace name", and in create mode the workspace name is one
  // the user typed into the field below thirty seconds ago -- so the answer is
  // never. Without this, naming a workspace "Acme" and the business behind it
  // "Acme Holdings Ltd" would silently rename the workspace to the second.
  const [autoNamed] = useState(() => (creating ? false : looksAutoNamed(orgName)));

  const [step, setStep] = useState<'type' | 'details'>('type');
  // Create mode only. What the workspace is called, as distinct from the company
  // behind it -- see the note on legal_name in ScoutOrg.
  const [name, setName] = useState('');
  const named = name.trim().length > 0;
  const [legalName, setLegalName] = useState('');
  const [country, setCountry] = useState('');
  const [website, setWebsite] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(orgType: OrgType, details: boolean) {
    setBusy(true);
    setError('');
    try {
      const company = legalName.trim();

      if (creating) {
        // One statement makes the organization, the owner membership and the
        // active-workspace row, and stamps onboarded_at because the type was
        // just answered. So a failure anywhere after this leaves a named,
        // usable workspace rather than a half-built one that reopens this
        // dialog on the next launch.
        const newId = await db.orgs.createWorkspace(name.trim(), orgType);
        if (details && (company || country || website)) {
          // Best effort, and separate on purpose: the workspace exists and is
          // correct without these, so a failure here must not read as "creating
          // the workspace failed". The user is already in it by then.
          try {
            await db.orgs.updateProfile(newId, {
              legal_name: company || null,
              country: country || null,
              website: normalizeWebsite(website) || null,
            });
          } catch (caught) {
            console.warn('workspace details', caught);
          }
        }
        onDone(newId);
        return;
      }

      await db.orgs.updateProfile(orgId as string, {
        org_type: orgType,
        // A solo workspace leaves these null rather than writing empty strings,
        // so "not asked" and "asked and skipped" stay different in the data.
        legal_name: details ? company || null : null,
        country: details ? country || null : null,
        website: details ? normalizeWebsite(website) || null : null,
        logo_url: details ? logoUrl || null : null,
        onboarded_at: new Date().toISOString(),
        // Adopt the business name as the workspace name, but only while the
        // workspace still has the one derived from the email address -- the
        // "gmail.com team" default. A workspace somebody deliberately renamed is
        // never overwritten by a form about the company behind it.
        ...(details && company && autoNamed ? {name: company} : {}),
      });
      onDone(orgId as string);
    } catch (caught) {
      // describeDbError rather than caught.message: create_workspace raises
      // owned_workspace_limit_reached, which has to arrive here as a sentence
      // about the cap rather than as the token.
      setError(describeDbError(caught, 'Could not save. Please try again.'));
      setBusy(false);
    }
  }

  // Recorded as answered even when they decline, and deliberately: the prompt
  // has no second entry point, so re-asking on every launch is the only
  // alternative and that is nagging. Settings has the same fields for anyone who
  // changes their mind.
  //
  // Onboard mode only. In create mode `orgId` is the workspace the user is
  // currently in -- very often somebody else's -- and stamping onboarded_at on
  // it because they backed out of making a new one would answer a question about
  // the wrong company. dismiss() below routes create mode to onCancel instead.
  async function notNow() {
    setBusy(true);
    setError('');
    try {
      await db.orgs.updateProfile(orgId as string, {onboarded_at: new Date().toISOString()});
      onDone(orgId as string);
    } catch (caught) {
      setError(describeDbError(caught, 'Could not save. Please try again.'));
      setBusy(false);
    }
  }

  function dismiss() {
    if (creating) {
      onCancel?.();
      return;
    }
    void notNow();
  }

  async function pickLogo(file: File | undefined) {
    // orgId is non-null wherever this is reachable -- the logo row renders in
    // onboard mode only, for exactly this reason.
    if (!file || !orgId) {
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setError('That image is larger than 2 MB. Pick a smaller one.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setLogoUrl(await uploadOrgLogo(orgId, file));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not upload that image.');
    } finally {
      setBusy(false);
      // Same file twice in a row fires onChange only if the value is cleared,
      // so a failed upload could not otherwise be retried with that file.
      if (fileRef.current) {
        fileRef.current.value = '';
      }
    }
  }

  if (step === 'type') {
    return (
      <Modal
        className="small-modal"
        onClose={dismiss}
        title={creating ? 'Create a workspace' : 'Who is this workspace for?'}
        subtitle={creating ?
          'A separate workspace with its own profiles, proxies and team. ' +
          'It starts on the Free plan and is billed on its own.' :
          'It helps us understand who we build for. It does not change your plan.'}
        footer={
          <button className="ghost" disabled={busy} onClick={dismiss} type="button">
            {creating ? 'Cancel' : 'Not now'}
          </button>
        }
      >
        {/* Create mode only. A workspace called "New workspace" is useless in a
            list of ten, so both choices below stay disabled until this is
            filled -- the database would otherwise accept the default. */}
        {creating && (
          <label className="field setup-name">
            <span>Workspace name</span>
            <input
              autoFocus
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              placeholder="Client accounts"
              type="text"
              value={name}
            />
          </label>
        )}
        <div className="setup-choices">
          <button
            className="setup-choice"
            disabled={busy || (creating && !named)}
            onClick={() => void save('solo', false)}
            type="button"
          >
            <User size={20} strokeWidth={1.75} />
            <strong>Just me</strong>
            <span>I work on my own account, as a freelancer or independently.</span>
          </button>
          <button
            className="setup-choice"
            disabled={busy || (creating && !named)}
            onClick={() => {
              setError('');
              setStep('details');
            }}
            type="button"
          >
            <Building2 size={20} strokeWidth={1.75} />
            <strong>A business</strong>
            <span>I work for a company or an agency, or I run one.</span>
          </button>
        </div>
        {error && <p className="setup-error">{error}</p>}
      </Modal>
    );
  }

  return (
    <Modal
      className="small-modal"
      onClose={dismiss}
      title="Tell us about your business"
      subtitle={creating ?
        'All optional. You can add a logo in Settings once the workspace exists.' :
        'All optional. The name and logo appear here and on the Team tab.'}
      footer={
        <>
          <button className="ghost" disabled={busy} onClick={() => setStep('type')} type="button">
            Back
          </button>
          <button disabled={busy} onClick={() => void save('business', true)} type="button">
            {busy ?
              (creating ? 'Creating…' : 'Saving…') :
              (creating ? 'Create workspace' : 'Save')}
          </button>
        </>
      }
    >
      {/* .field is the app's own label+control primitive (styles.css:5849) --
          it carries the label weight, the gap and the 36px control height that
          every other dialog uses, so these rows match the profile editor and
          Settings without a second set of form styles to keep in step. */}
      <div className="setup-fields">
        <label className="field">
          <span>Business name</span>
          <input
            autoFocus
            maxLength={120}
            onChange={(event) => setLegalName(event.target.value)}
            placeholder="Acme Ltd"
            type="text"
            value={legalName}
          />
        </label>

        <label className="field">
          <span>Country</span>
          <select onChange={(event) => setCountry(event.target.value)} value={country}>
            <option value="">Select a country…</option>
            {countries.map((choice) => (
              <option key={choice.code} value={choice.code}>{choice.name}</option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Website</span>
          <input
            maxLength={200}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder="acme.com"
            type="text"
            value={website}
          />
        </label>

        {/* Onboard mode only. uploadOrgLogo writes to org-logos/<orgId>/, and in
            create mode there is no id until save() runs -- so the choice is
            either to create the workspace on entering this step, or to leave the
            logo to Settings. The second keeps "Create workspace" one atomic
            press, and the logo is the one field here with a natural second home;
            the subtitle above says where. */}
        {!creating && (
        <div className="field setup-logo">
          <span>Logo</span>
          <div className="setup-logo-row">
            {logoUrl ?
              <img alt="" className="setup-logo-preview" src={logoUrl} /> :
              <span className="setup-logo-preview is-empty" aria-hidden="true" />}
            <input
              accept="image/png,image/jpeg,image/webp"
              className="visually-hidden"
              onChange={(event) => void pickLogo(event.target.files?.[0])}
              ref={fileRef}
              type="file"
            />
            <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()} type="button">
              <ImageUp size={15} /> {logoUrl ? 'Change' : 'Upload'}
            </button>
            {logoUrl && (
              <button className="ghost" disabled={busy} onClick={() => setLogoUrl('')} type="button">
                Remove
              </button>
            )}
          </div>
        </div>
        )}
      </div>
      {error && <p className="setup-error">{error}</p>}
    </Modal>
  );
}

// Whether this is still the name bootstrap_org derived from the signup address.
//
// Matched by pattern rather than asserted: bootstrap_org lives only in the
// database, not in this repo, so this recognises the shape it produces --
// "gmail.com team", "acme.co.uk team" -- and errs toward leaving `name` alone
// when it does not match. Mirrors looksAutoNamed in landing/lib/org-profile.ts;
// the two must agree or the same account gets different behaviour on the two
// surfaces.
function looksAutoNamed(name: string | null | undefined): boolean {
  if (!name?.trim()) {
    return true;
  }
  return /^[^\s@]+\.[a-z]{2,}\s+team$/i.test(name.trim());
}

// Someone typing their own site writes "acme.com". The column's CHECK requires a
// scheme, so supply the one they meant rather than refusing the answer over
// punctuation.
function normalizeWebsite(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}
