// A profile's answers to the automations it runs, in the profile editor.
//
// Only the automations you add, not every parameterised one in the workspace.
// A list that grows with the org is a list nobody reads: with thirty
// automations the two this profile actually runs would be lost among
// twenty-eight empty blocks, and the section would push everything below it off
// the screen for a profile that answers nothing.
//
// The exception is the on-launch automation: picking one in `Run on launch` is
// already the statement "this profile runs that", so its block appears without
// being asked for, and cannot be removed while it stays picked.
import {Plus, X} from 'lucide-react';
import {ParamValueFields} from './ParamValueFields';
import type {ScoutAutomation} from '../../types';

export type ProfileVarsDraft = Record<string, Record<string, string>>;

export function ProfileAutomationValues({automations, attachedId, value, onChange}: {
  automations: ScoutAutomation[];
  // The profile's `Run on launch` pick, or '' -- pinned here so its block is
  // present and undismissable.
  attachedId: string;
  value: ProfileVarsDraft;
  onChange: (next: ProfileVarsDraft) => void;
}) {
  const parameterised = automations.filter(
      (automation) => (automation.parameters || []).length > 0);
  const attached = parameterised.find((automation) => automation.id === attachedId);

  // Order: the on-launch automation first, then whatever was added, in the
  // workspace's own order rather than insertion order -- a map has no reliable
  // one, and a section that reshuffles itself between opens reads as a bug.
  const shown = [
    ...(attached ? [attached] : []),
    ...parameterised.filter(
        (automation) => automation.id !== attachedId && automation.id in value),
  ];
  const addable = parameterised.filter(
      (automation) => automation.id !== attachedId && !(automation.id in value));

  function add(id: string) {
    if (id) {
      onChange({...value, [id]: value[id] || {}});
    }
  }

  function remove(id: string) {
    const next = {...value};
    delete next[id];
    onChange(next);
  }

  if (parameterised.length === 0) {
    return null;
  }

  return (
    <div className="profile-automation-values">
      {shown.map((automation) => (
        <div className="profile-automation-values-block" key={automation.id}>
          <div className="profile-automation-values-head">
            <span className="profile-automation-values-name">{automation.name}</span>
            {automation.id === attachedId ? (
              <span className="profile-automation-values-note">runs on launch</span>
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-label={`Stop holding values for ${automation.name}`}
                title="Remove these values"
                onClick={() => remove(automation.id)}
              ><X size={14} /></button>
            )}
          </div>
          <ParamValueFields
            parameters={automation.parameters || []}
            values={value[automation.id] || {}}
            onChange={(next) => onChange({...value, [automation.id]: next})}
            // A required value missing here is not an error yet -- this profile
            // may never run this automation, and the Run dialog is where it
            // becomes a block. Flagged all the same, because finding out at the
            // moment you press Run is the worse of the two.
            showMissing
          />
        </div>
      ))}

      {addable.length > 0 && (
        <label className="profile-automation-values-add">
          <Plus size={14} />
          {/* A select rather than a button-plus-popover: the list is short, it
              is a pick and not a search, and <select> gets keyboard and
              touch behaviour for free. Reset to '' after each pick so the
              control keeps reading as an action. */}
          <select
            value=""
            onChange={(event) => add(event.target.value)}
          >
            <option value="">Add values for an automation…</option>
            {addable.map((automation) => (
              <option key={automation.id} value={automation.id}>{automation.name}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
