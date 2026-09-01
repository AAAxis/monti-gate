// Add or edit a connector. The form is GENERATED from the preset catalogue --
// src/data/connectors.ts declares each kind's fields, this renders whatever it
// finds there. Adding a connector kind is a catalogue entry and a send adapter
// in the main process; this file does not change.
//
// Creating starts on a kind picker (two headed groups, AI and messaging) and
// only then shows the form. The kind is locked once saved: changing it under
// an existing config would leave the old kind's keys orphaned inside `config`,
// and "delete it and add the right one" is honest about what that is.
import {useEffect, useState} from 'react';
import {ArrowLeft, Check, ExternalLink, X} from 'lucide-react';
import {BusyButton} from '../ui/BusyButton';
import {Field} from '../ui/Field';
import {Modal} from '../ui/Modal';
import {SecretInput} from '../ui/SecretInput';
import {ConnectorMark} from '../automations/ConnectorsView';
import {native} from '../../native';
import {
  CONNECTOR_PRESETS, presetFor, runtimeConnector, validateConnectorConfig,
} from '../../data/connectors';
import {useWorkspace} from '../../workspace/WorkspaceProvider';
import type {ConnectorField} from '../../data/connectors';
import type {MontiConnector} from '../../types';

// One value, not two booleans: `ok` picks the tone and `message` is the
// service's own sentence, which is the only diagnostic worth showing.
type TestResult = {ok: boolean; message: string};

export function ConnectorModal({connector, exists, onClose}: {
  connector: MontiConnector;
  exists: boolean;
  onClose: () => void;
}) {
  const {data, connectors, toast} = useWorkspace();
  const [draft, setDraft] = useState<MontiConnector>(connector);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState('');
  // What the endpoint says it serves, once asked. null = never loaded (the
  // model box is free text); a list turns the box into a real choice, with
  // `manualModel` as the escape hatch back to typing -- gateways route ids
  // their /models listing does not admit to.
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsError, setModelsError] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [manualModel, setManualModel] = useState(false);

  const preset = presetFor(draft.kind);
  // Creating and no kind picked yet -> the picker is the whole dialog.
  const picking = !exists && !draft.kind;

  // The listing can be asked for once the endpoint resolves and the key -- on
  // the kinds that demand one -- is present. The local runtimes need nothing.
  const needsKey = Boolean(preset?.fields.some(
      (field) => field.key === 'api_key' && field.required));
  const canLoadModels = preset?.category === 'ai' &&
    Boolean(runtimeConnector(draft).base_url) &&
    (!needsKey || Boolean((draft.config.api_key || '').trim()));

  async function loadModels() {
    setLoadingModels(true);
    setModelsError('');
    const answer = await native?.listConnectorModels?.(runtimeConnector(draft));
    setLoadingModels(false);
    if (!answer) {
      setModelsError('Loading models needs the desktop app.');
      return;
    }
    if (!answer.ok || !answer.models?.length) {
      setModels(null);
      setModelsError(answer.error || 'Could not load the model list.');
      return;
    }
    setModels(answer.models);
    setManualModel(false);
    // A blank model box picks up the endpoint's first offering -- the one
    // choice that is always wrong is an empty string.
    if (!(draft.config.model || '').trim()) {
      setConfig('model', answer.models[0]);
    }
  }

  // Fetch by itself as soon as it can: on opening an existing connector (its
  // key is already there) and shortly after a key or endpoint is pasted into
  // a new one. Debounced so typing a key asks once, not per keystroke; a
  // failed attempt shows its reason under the box and the Refresh button
  // retries.
  const keyValue = draft.config.api_key || '';
  const baseValue = draft.config.base_url || '';
  useEffect(() => {
    if (!canLoadModels) {
      return undefined;
    }
    const timer = setTimeout(() => {
      void loadModels();
    }, 700);
    return () => clearTimeout(timer);
    // Re-asks when what the request is built from changes -- not when the
    // model selection does, which loadModels itself writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kind, keyValue, baseValue]);

  function pick(kind: string) {
    const picked = presetFor(kind);
    if (!picked) {
      return;
    }
    setDraft({
      ...draft,
      kind,
      category: picked.category,
      // Seeded, not forced: a name the user already typed survives switching
      // their mind about the kind.
      name: draft.name.trim() || picked.label,
      config: picked.suggestedModel ? {model: picked.suggestedModel} : {},
      // The first connector in its category becomes the default -- a lone
      // connector that is not the default makes every step authored without
      // naming one fail for no reason the user can see.
      is_default: !data.state.connectors.some((item) => item.category === picked.category),
    });
    setTest(null);
    setError('');
    setModels(null);
    setModelsError('');
    setManualModel(false);
  }

  function setConfig(key: string, value: string) {
    setDraft((current) => ({...current, config: {...current.config, [key]: value}}));
  }

  const problems: string[] = [];
  if (!draft.name.trim()) {
    problems.push('Name is required');
  }
  problems.push(...validateConnectorConfig(draft.kind, draft.config));

  // Tests the DRAFT, unsaved edits included -- the thing you are about to
  // save is the thing worth proving, not whatever the last save wrote.
  async function runTest() {
    setTesting(true);
    setTest(null);
    const answer = await native?.testConnector?.(runtimeConnector(draft));
    setTesting(false);
    setTest(answer ?
      {
        ok: answer.ok,
        message: answer.ok ?
          (draft.category === 'message' ? 'Message sent — check the channel.' : 'Replied ok.') :
          answer.error || 'The test did not run.',
      } :
      {ok: false, message: 'Testing needs the desktop app.'});
  }

  // Back to the picker, dropping whatever this kind's form held: its keys
  // belong to the kind, and carrying them into another one would orphan them
  // inside config.
  function back() {
    setDraft({...draft, kind: '', config: {}});
    setTest(null);
    setError('');
    setModels(null);
    setModelsError('');
    setManualModel(false);
  }

  async function save() {
    setSaving(true);
    const failure = await connectors.save(
        {...draft, name: draft.name.trim()}, exists);
    setSaving(false);
    if (failure) {
      setError(failure);
      return;
    }
    toast.setMessage(`Saved "${draft.name.trim()}"`);
    onClose();
  }

  function control(field: ConnectorField) {
    const value = draft.config[field.key] || '';
    if (field.secret) {
      return (
        <SecretInput
          value={value}
          placeholder={field.placeholder}
          onChange={(next) => setConfig(field.key, next)}
        />
      );
    }
    if (field.kind === 'select') {
      return (
        <select value={value} onChange={(event) => setConfig(field.key, event.target.value)}>
          {(field.options || []).map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      );
    }
    return (
      <input
        type={field.kind === 'number' ? 'number' : 'text'}
        value={value}
        placeholder={field.placeholder}
        autoComplete="off"
        onChange={(event) => setConfig(field.key, event.target.value)}
      />
    );
  }

  if (picking) {
    return (
      <Modal
        className="small-modal connector-modal"
        onClose={onClose}
        title="New connector"
        subtitle="What should your automations be able to reach?"
      >
        {(['ai', 'message'] as const).map((category) => (
          <section className="connector-pick-group" key={category}>
            <h3>{category === 'ai' ? 'AI models' : 'Messaging'}</h3>
            <div className="connector-pick-grid">
              {CONNECTOR_PRESETS.filter((entry) => entry.category === category).map((entry) => (
                <button
                  className="connector-pick-tile"
                  key={entry.kind}
                  onClick={() => pick(entry.kind)}
                  type="button"
                >
                  <ConnectorMark kind={entry.kind} preset={entry} size={18} />
                  <span>{entry.label}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </Modal>
    );
  }

  const keyField = (preset?.fields || []).find((field) => field.secret);

  return (
    <Modal
      className="small-modal connector-modal"
      onClose={onClose}
      title={exists ? `Edit ${connector.name || 'connector'}` : `New ${preset?.label || draft.kind} connector`}
      subtitle={preset ?
        (preset.category === 'message' ?
          'Automations send messages through this.' :
          'AI steps ask this model.') :
        `This version of EasyDeck doesn't recognise "${draft.kind}", so its fields can't be edited here.`}
      footer={
        <>
          {!exists && (
            <button className="ghost connector-modal-back" onClick={back} type="button">
              <ArrowLeft size={14} /> Different service
            </button>
          )}
          <BusyButton
            busy={testing}
            busyLabel="Testing"
            className="ghost"
            disabled={problems.length > 0}
            onClick={() => void runTest()}
            title={problems.length > 0 ?
              problems.join('. ') :
              (draft.category === 'message' ?
                'Sends a real test message' :
                'Asks the model for a one-word reply')}
          >Test</BusyButton>
          <button className="ghost" onClick={onClose} type="button">Cancel</button>
          <BusyButton
            busy={saving}
            busyLabel="Saving…"
            disabled={problems.length > 0}
            onClick={() => void save()}
            title={problems.length > 0 ? problems.join('. ') : 'Save this connector'}
          >Save</BusyButton>
        </>
      }
    >
      <div className="connector-form">
        <Field label="Name" hint="What steps and dropdowns call it.">
          <input
            type="text"
            value={draft.name}
            placeholder={preset?.label || 'Connector name'}
            onChange={(event) => setDraft({...draft, name: event.target.value})}
          />
        </Field>

        {(preset?.fields || []).map((field) => {
          // The model box, once the endpoint has been asked, is a choice of
          // what it actually serves rather than a string typed from memory --
          // with "Type a model id…" as the way out for gateways that route
          // ids their listing omits. Until then (no key yet, listing failed)
          // it stays the plain input.
          if (preset?.category === 'ai' && field.key === 'model') {
            const currentModel = draft.config.model || '';
            // The hint is the state machine's narration: before the key it
            // says what will happen, after the load it goes back to being
            // about the value.
            const modelHint = models ? field.hint :
              canLoadModels ? 'Models are loading from the endpoint…' :
                needsKey ?
                  'Paste the API key above and the model list loads by itself.' :
                  'Enter the endpoint and the model list loads by itself.';
            return (
              <Field key={field.key} label={`${field.label} *`} hint={modelHint}>
                {models && !manualModel ? (
                  <select
                    value={currentModel}
                    onChange={(event) => {
                      if (event.target.value === '__manual') {
                        setManualModel(true);
                        return;
                      }
                      setConfig('model', event.target.value);
                    }}
                  >
                    {/* The stored model, kept even when the listing omits it
                        -- a saved choice must not silently snap to another. */}
                    {currentModel && !models.includes(currentModel) && (
                      <option value={currentModel}>{currentModel}</option>
                    )}
                    {models.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                    <option value="__manual">Type a model id…</option>
                  </select>
                ) : control(field)}
                <div className="connector-models-row">
                  {/* The title lives on the wrapper: Chromium suppresses
                      tooltips on a disabled control, so the one moment the
                      explanation is needed is the one moment a title on the
                      button itself never shows -- the Run button's lesson. */}
                  <span title={canLoadModels ?
                    'Ask the endpoint what models it serves' :
                    (needsKey ? 'Enter the API key first.' : 'Enter the endpoint first.')}>
                    <BusyButton
                      busy={loadingModels}
                      busyLabel="Loading"
                      className="ghost small"
                      disabled={!canLoadModels}
                      onClick={() => void loadModels()}
                    >
                      {models ? 'Refresh models' : 'Load models'}
                    </BusyButton>
                  </span>
                  {models && manualModel && (
                    <button
                      className="link-button"
                      onClick={() => setManualModel(false)}
                      type="button"
                    >Back to the list</button>
                  )}
                </div>
                {modelsError && (
                  <p className="connector-card-test is-bad">
                    <X size={13} /><span>{modelsError}</span>
                  </p>
                )}
              </Field>
            );
          }
          return (
            <Field
              key={field.key}
              label={field.required ? `${field.label} *` : field.label}
              hint={field.hint}
            >
              {control(field)}
              {/* "Get one" sits beside the field it fills, in the user's own
                  browser -- never a profile window; those stay anonymous. */}
              {field.secret && field.key === keyField?.key && preset?.keyUrl && (
                <button
                  className="link-button"
                  onClick={() => void native?.openExternal?.(preset.keyUrl as string)}
                  type="button"
                >
                  Get one <ExternalLink size={12} />
                </button>
              )}
            </Field>
          );
        })}

        {test && (
          <p className={`connector-card-test ${test.ok ? 'is-ok' : 'is-bad'}`}>
            {test.ok ? <Check size={13} /> : <X size={13} />}
            <span>{test.message}</span>
          </p>
        )}
        {error && <p className="connector-card-test is-bad"><X size={13} /><span>{error}</span></p>}
      </div>
    </Modal>
  );
}
