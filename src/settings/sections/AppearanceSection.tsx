// Appearance: the theme, chosen from a picture of itself.
//
// The old control was three words in a segmented button. A preview shows what
// "System" actually resolves to on this machine, which words cannot.
import {Check} from 'lucide-react';
import {THEME_OPTIONS, useTheme} from '../../theme';
import type {ThemePreference} from '../../theme';
import {SettingsGroup, SettingsRow} from '../rows';

// The one place in this app allowed to name colours instead of reading tokens:
// a preview of the *light* theme has to stay light while the app around it is
// dark, so var(--surface) is exactly the wrong thing here. Values are copied
// from the token blocks at the top of styles.css -- if the palette moves, these
// move with it.
const SWATCHES: Record<'light' | 'dark', {rail: string; body: string; line: string; dot: string}> = {
  // --paper / --surface / --border / --accent, light block (styles.css:10).
  light: {rail: '#f5f2f0', body: '#f7f7f6', line: '#e4dfdc', dot: '#1a1a19'},
  // the same four from the dark block (styles.css:116).
  dark: {rail: '#171615', body: '#1c1b19', line: '#34312e', dot: '#f2f0ed'},
};

function Preview({preference, resolvedSystem}: {preference: ThemePreference; resolvedSystem: 'light' | 'dark'}) {
  // "System" is drawn split down the middle -- half light, half dark -- which is
  // the clearest way to say "whichever the Mac is using".
  if (preference === 'system') {
    return (
      <span className="theme-preview split" aria-hidden="true">
        <Panel tone="light" />
        <Panel tone="dark" />
        <span className="theme-preview-resolved">{resolvedSystem === 'dark' ? 'Dark now' : 'Light now'}</span>
      </span>
    );
  }
  return (
    <span className="theme-preview" aria-hidden="true">
      <Panel tone={preference} />
    </span>
  );
}

function Panel({tone}: {tone: 'light' | 'dark'}) {
  const swatch = SWATCHES[tone];
  return (
    <span className="theme-preview-panel" style={{background: swatch.body}}>
      <span className="theme-preview-rail" style={{background: swatch.rail}}>
        <i style={{background: swatch.line}} />
        <i style={{background: swatch.line}} />
        <i style={{background: swatch.line}} />
      </span>
      <span className="theme-preview-body">
        <i style={{background: swatch.line}} />
        <i style={{background: swatch.line, width: '60%'}} />
        <i style={{background: swatch.dot, borderRadius: 999, height: 6, width: 6}} />
      </span>
    </span>
  );
}

export function AppearanceSection() {
  const {preference, resolved, setPreference} = useTheme();

  return (
    <SettingsGroup>
      <SettingsRow
        label="Theme"
        description="How Scout Web looks on this computer. System follows your macOS appearance and switches as it does."
        wide
      >
        <div className="theme-choices" role="radiogroup" aria-label="Theme">
          {THEME_OPTIONS.map((option) => (
            <button
              aria-checked={preference === option.value}
              className={preference === option.value ? 'theme-choice active' : 'theme-choice'}
              key={option.value}
              onClick={() => setPreference(option.value)}
              role="radio"
              type="button"
            >
              <Preview preference={option.value} resolvedSystem={resolved} />
              <span className="theme-choice-label">
                {preference === option.value && <Check size={13} strokeWidth={2.5} />}
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </SettingsRow>
    </SettingsGroup>
  );
}
