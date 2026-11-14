/**
 * Manual theme (UI-13, v0.62) — pure helpers, no React, no IPC.
 *
 * Before this, light/dark followed `prefers-color-scheme` only. Now the
 * user picks System / Light / Dark / Paper in Settings → General; the choice is
 * stored in localStorage (`open-bot:theme`) and applied as a
 * `data-theme` attribute on `<html>`:
 *
 * - `dark`  → `:root[data-theme="dark"]` forces the dark variables.
 * - `light` → `:root[data-theme="light"]` forces light (the dark media
 *   query no longer matches because the attribute is present).
 * - `paper` → `:root[data-theme="paper"]` forces the warm Paper variables.
 * - `system` (default) → no attribute; the existing
 *   `@media (prefers-color-scheme: dark)` rules apply.
 *
 * Kept DOM-free except for the tiny `applyThemeMode` seam (it takes the
 * root element + the current media-query result as arguments, so the
 * rules are unit-testable with a fake root).
 *
 * v1.07 (Team T5 — Paper theme, after OpenHands v1.38): a fourth
 * mode, `paper` — a warm, airy light theme (paper background,
 * warm text, soft brown accent) for long reading / writing
 * sessions. It is a first-class mode, not a variant of light: it
 * sets `data-theme="paper"` like light/dark do, and `resolveTheme`
 * returns it unchanged.
 */
export type ThemeMode = 'system' | 'light' | 'dark' | 'paper';

/** localStorage key for the manual theme choice. */
export const THEME_STORAGE_KEY = 'open-bot:theme';

export const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark', 'paper'];

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark' || value === 'paper';
}

export type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Read the stored choice; anything missing/invalid means "system". */
export function readThemeMode(storage: ThemeStorage | null | undefined): ThemeMode {
  if (!storage) return 'system';
  try {
    const raw = storage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(raw) ? raw : 'system';
  } catch {
    return 'system';
  }
}

/** Persist the choice. Never throws (storage may be unavailable). */
export function saveThemeMode(storage: ThemeStorage | null | undefined, mode: ThemeMode): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Storage unavailable — the theme still applies for this session.
  }
}

/** Effective theme for a mode: `system` follows the OS preference. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): 'light' | 'dark' | 'paper' {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return 'dark';
  if (mode === 'paper') return 'paper';
  return prefersDark ? 'dark' : 'light';
}

export interface ThemeRoot {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/**
 * Apply a mode to the root element: `system` removes the attribute (the
 * CSS media query takes over), anything else sets `data-theme`. Never
 * throws — a missing root just means the theme is not applied.
 */
export function applyThemeMode(mode: ThemeMode, root: ThemeRoot | null | undefined): void {
  if (!root) return;
  try {
    if (mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', mode);
  } catch {
    // A fake/strict root — the app still works, just in system theme.
  }
}
