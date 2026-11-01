// Classic (non-module) script loaded from <head>: sets data-theme before the first paint, so a
// light-theme user never sees a dark flash while the module graph loads. Mirrors lib/appTheme.js's
// resolveScheme; test/appTheme.test.js holds the two together. See docs/architecture/frontend.md.
(function () {
  var pref = 'dark';
  try {
    pref = localStorage.getItem('odw:appTheme') || 'dark';
  } catch {
    /* storage blocked - stay dark */
  }
  var light = pref === 'light' || (pref === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
})();
