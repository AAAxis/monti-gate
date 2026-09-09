// The three dropdowns above a library table: status, tag, and assign-to-folder.
//
// All three were native <select>s, which made them the only place in the app
// where a status or a tag appears as plain text. Everywhere else -- the table
// row, the profile dialog, the tag input -- those values are drawn as coloured
// chips, so the control you filter with looked nothing like the thing you were
// filtering for. A <select> cannot hold a chip: its options are text.
//
// One file rather than three, and one FilterOption behind all of them, for the
// reason this codebase keeps citing about StatusPicker and PlatformSelect --
// three pickers standing in one row must not be three widgets. Adding a fourth
// filter belongs here too.
//
// Built on Popover, the app's one floating layer: outside-click, Escape, resize
// and scroll dismissal, and the flip-above-when-it-does-not-fit are already
// solved there and must not be re-solved per picker.
import {FolderInput, Hash} from 'lucide-react';
import {FilterOption} from './FilterOption';
import {Popover} from './Popover';
import {FolderGlyph} from './FolderGlyph';
import {StatusChip} from './StatusChip';
import {TagBadge, TagChip} from './TagChip';
import {tagKey, tagLabel, tagPresetFor} from '../../lib/tags';
import type {TagUsage} from '../../lib/tags';
import type {ScoutFolder} from '../../types';

const ALL_STATUSES = 'All statuses';

export function StatusFilter({value, options, onChange}: {
  // '' for no filter, which is also what the first row sets.
  value: string;
  options: string[];
  onChange: (status: string) => void;
}) {
  return (
    <Popover
      label={`Filter by status: ${value || ALL_STATUSES}`}
      panelClassName="filter-pop"
      triggerClassName="filter-trigger"
      width={216}
      trigger={
        <>
          {/* The chip itself, not its name: the trigger is where the filter is
              read back, and reading it back in a different vocabulary than the
              column it filters is the whole problem being fixed. */}
          {value ?
            <StatusChip status={value} /> :
            <span className="filter-trigger-label">{ALL_STATUSES}</span>}
        </>
      }
    >
      {(close) => (
        <div className="filter-pop-list" role="listbox" aria-label="Status">
          <FilterOption
            active={!value}
            label={ALL_STATUSES}
            onPick={() => {
              onChange('');
              close();
            }}
          >
            <span className="filter-pop-name">{ALL_STATUSES}</span>
          </FilterOption>
          {options.map((status) => (
            <FilterOption
              active={status === value}
              key={status}
              label={status}
              onPick={() => {
                onChange(status);
                close();
              }}
            >
              <StatusChip status={status} />
            </FilterOption>
          ))}
        </div>
      )}
    </Popover>
  );
}

const ALL_TAGS = 'All tags';

export function TagFilter({value, options, onChange}: {
  // A tagKey(), not a raw tag -- the filter matches on the normalized form and
  // the tabs keep it that way in their own state.
  value: string;
  // Every tag actually on a row, from useWorkspace().tagOptions. Deliberately
  // not the whole catalog: a dropdown listing twenty brands when the workspace
  // uses two of them is eighteen ways to empty the table.
  options: TagUsage[];
  onChange: (key: string) => void;
}) {
  // The window where a filter is set on a tag that has just stopped being in
  // use -- the last row carrying it was retagged or deleted, so it is gone from
  // `options` while `value` still holds it. The table is genuinely empty at that
  // point, and a trigger reading "All tags" over an empty table is the one thing
  // that must not happen: it says the filter is off. Fall back to the key, which
  // is what the user picked. (The <select> this replaced had the same gap and
  // resolved it the other way, by silently displaying its first option.)
  const selected = options.find((option) => tagKey(option.tag) === value);
  const shown = selected?.tag || value;

  return (
    <Popover
      label={`Filter by tag: ${shown ? tagLabel(shown) : ALL_TAGS}`}
      panelClassName="filter-pop"
      triggerClassName="filter-trigger"
      width={244}
      trigger={
        <>
          {shown ?
            <TagChip tag={shown} /> :
            <span className="filter-trigger-label">{ALL_TAGS}</span>}
        </>
      }
    >
      {(close) => (
        <div className="filter-pop-list" role="listbox" aria-label="Tag">
          <FilterOption
            active={!value}
            label={ALL_TAGS}
            onPick={() => {
              onChange('');
              close();
            }}
          >
            <span className="filter-pop-mark"><Hash size={12} strokeWidth={2.5} /></span>
            <span className="filter-pop-name">{ALL_TAGS}</span>
          </FilterOption>
          {options.map((option) => {
            const key = tagKey(option.tag);
            return (
              <FilterOption
                active={key === value}
                key={key}
                label={tagLabel(option.tag)}
                onPick={() => {
                  onChange(key);
                  close();
                }}
              >
                {/* A TagBadge -- the mark on its tinted plate -- rather than the
                    full chip the trigger shows. TagPicker's header comment
                    spells out why, and it holds here: a column of tinted pills
                    is a paint chart, and a list needs a steady left edge more
                    than each row needs to be its own colour. The plate still
                    carries the tag's tone, which is the part worth seeing. */}
                {tagPresetFor(option.tag) ?
                  <TagBadge tag={option.tag} /> :
                  <span className="filter-pop-mark"><Hash size={12} strokeWidth={2.5} /></span>}
                <span className="filter-pop-name">{tagLabel(option.tag)}</span>
                <span className="filter-pop-count">{option.count}</span>
              </FilterOption>
            );
          })}
        </div>
      )}
    </Popover>
  );
}

// Assign-to-folder, in the selection bar.
//
// An action rather than a filter, so the trigger has no value to preview and
// keeps its own words -- the same way the <select> it replaces carried a
// disabled "Assign to folder…" placeholder and reset itself after every use.
// What it gains over that select is the panel: a folder's colour and icon are
// how the user tells their folders apart everywhere else in the app, and the
// list of names alone made this the one place they had to read instead.
export function FolderSelect({folders, noFolderLabel, onPick}: {
  folders: ScoutFolder[];
  // What "out of every folder" is called in this library: All profiles, All
  // proxies, All cookie-sets. Maps to '' , the same value the select used.
  noFolderLabel: string;
  onPick: (folderId: string) => void;
}) {
  return (
    <Popover
      label="Assign to folder"
      panelClassName="filter-pop"
      // A ghost button, not the flat .filter-trigger the two real filters take.
      // This one lives in the selection toolbar among Check proxies, Import
      // cookies and Export selected -- it is an action, as the note above says,
      // and one borderless control in a row of five bordered ones reads as a
      // rendering fault rather than as a quieter kind of button.
      triggerClassName="ghost"
      width={244}
      trigger={
        <>
          <FolderInput size={15} strokeWidth={1.9} /> Assign to folder
        </>
      }
    >
      {(close) => (
        <div className="filter-pop-list" role="listbox" aria-label="Folder">
          <FilterOption
            active={false}
            label={noFolderLabel}
            onPick={() => {
              onPick('');
              close();
            }}
          >
            <FolderGlyph icon={undefined} color={undefined} size={13} small />
            <span className="filter-pop-name">{noFolderLabel}</span>
          </FilterOption>
          {folders.map((folder) => (
            <FilterOption
              active={false}
              key={folder.id}
              label={folder.name}
              onPick={() => {
                onPick(folder.id);
                close();
              }}
            >
              <FolderGlyph color={folder.color} icon={folder.icon} size={13} small />
              <span className="filter-pop-name">{folder.name}</span>
            </FilterOption>
          ))}
        </div>
      )}
    </Popover>
  );
}
