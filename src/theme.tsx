// Light/dark theming for the launcher.
//
// Mirrors the landing site's next-themes setup (attribute="class",
// defaultTheme="system") without pulling the dependency in: the launcher is a
// plain Vite/React renderer, so a ~60-line context does the same job. The
// resolved theme is stamped onto <html data-theme>, which is the only hook
// styles.css needs -- every colour there resolves through a var().

import React, {createContext, useCallback, useContext, useEffect, useMemo, useState} from 'react';
import {native} from './native';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'scout.theme';

export const THEME_OPTIONS: Array<{value: ThemePreference; label: string}> = [
  {value: 'system', label: 'System'},
  {value: 'light', label: 'Light'},
  {value: 'dark', label: 'Dark'},
];

export function readStoredPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  } catch {
    // Private mode / storage disabled -- fall through to the default.
  }
  return 'system';
}

function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function resolve(preference: ThemePreference): ResolvedTheme {
  if (preference === 'system') {
    return prefersDark() ? 'dark' : 'light';
  }
  return preference;
}

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference(next: ThemePreference): void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({children}: {children: React.ReactNode}) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolve(readStoredPreference()));

  // Re-resolve whenever the preference changes, and -- while on "system" --
  // whenever macOS itself switches appearance, so the app follows live rather
  // than only at startup.
  useEffect(() => {
    const apply = () => setResolved(resolve(preference));
    apply();
    if (preference !== 'system') {
      return;
    }
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [preference]);

  // The single hook the stylesheet reads.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  // The main process gets the preference rather than the resolved theme, so it
  // can leave nativeTheme.themeSource on 'system' and keep prefers-color-scheme
  // live in here. See the scout:set-theme handler in electron/main.cjs.
  useEffect(() => {
    void native?.setTheme?.(preference);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisting is survivable; the session still themes correctly.
    }
  }, []);

  const value = useMemo(
      () => ({preference, resolved, setPreference}),
      [preference, resolved, setPreference],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error('useTheme must be used inside <ThemeProvider>');
  }
  return value;
}
