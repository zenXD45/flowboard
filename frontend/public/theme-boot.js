/**
 * Resolve the theme before the first paint.
 *
 * This lives in a file of its own rather than inline in index.html because the
 * API sends `script-src 'self'`, which blocks inline execution — the script
 * silently failed there, leaving `data-theme` unset until React mounted and
 * flashing the dark palette on every load for anyone who had chosen light.
 *
 * It is a classic (non-module) script in <head>, so it blocks parsing: by the
 * time <body> exists to be painted, `data-theme` is already on <html>. React is
 * a deferred module, so nothing can render ahead of it.
 *
 * Keep the logic dependency-free and synchronous; anything asynchronous moves
 * the resolution past first paint and reintroduces the flash it exists to stop.
 */
(function () {
  try {
    var preference = localStorage.getItem('flowboard:theme');
    var scheme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    var theme = preference === 'light' || preference === 'dark' ? preference : scheme;
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.style.colorScheme = theme;
  } catch {
    // localStorage can be unavailable (private mode, blocked cookies). Falling
    // back to the dark tokens keeps the page renderable rather than unstyled.
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
