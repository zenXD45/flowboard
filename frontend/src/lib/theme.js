/**
 * Theme is resolved to a concrete "dark" or "light" and written to
 * `<html data-theme>`, rather than left to a CSS media query. A media query can
 * only ever express the *system* preference, so an explicit choice of dark on a
 * light desktop (or the reverse) could not be honoured — the data attribute
 * lets one rule win for both cases.
 *
 * `system` is not a value we render; it is a preference we resolve at apply
 * time, which is why matchMedia is consulted here and not in the stylesheet.
 */

const STORAGE_KEY = 'flowboard:theme';

export const THEMES = ['system', 'dark', 'light'];

const prefersLight = () => window.matchMedia('(prefers-color-scheme: light)').matches;

export function storedTheme() {
  const value = window.localStorage.getItem(STORAGE_KEY);
  return THEMES.includes(value) ? value : 'system';
}

export function resolveTheme(preference) {
  if (preference === 'dark' || preference === 'light') return preference;
  return prefersLight() ? 'light' : 'dark';
}

export function applyTheme(preference) {
  const resolved = resolveTheme(preference);
  const root = document.documentElement;
  root.setAttribute('data-theme', resolved);
  // Keeps native widgets (scrollbars, form controls) in the same scheme as the
  // page, which `color-scheme` on its own would only do from the media query.
  root.style.colorScheme = resolved;
}

export function storeTheme(preference) {
  if (preference === 'system') window.localStorage.removeItem(STORAGE_KEY);
  else window.localStorage.setItem(STORAGE_KEY, preference);
  applyTheme(preference);
}

export function watchSystemTheme(onChange) {
  const query = window.matchMedia('(prefers-color-scheme: light)');
  const handler = () => onChange();
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
