// Light/dark toggle (same as tools.alexisdavidson.org's theme.js).
// Load it in <head> without defer: <script src="/theme.js"></script>
// It applies the saved choice before the page paints (data-theme="light|dark" on <html>; no
// attribute means follow the device), then adds the button to the top right corner.
// Pages style dark mode with :root[data-theme=dark] and
// @media (prefers-color-scheme: dark) { :root:not([data-theme=light]) ... }.
// The button uses the page's own color tokens. A page can move it down with --theme-top.
// Fires a "themechange" event on document when the theme changes.
(function () {
  var KEY = "theme", root = document.documentElement;
  var media = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : { matches: false };

  function get() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function set(v) { try { localStorage.setItem(KEY, v); } catch (e) {} }

  var saved = get();
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;

  function isDark() { return root.dataset.theme ? root.dataset.theme === "dark" : media.matches; }

  var css = [
    ".theme-toggle{position:absolute;z-index:20;top:var(--theme-top,calc(env(safe-area-inset-top,0px) + 16px));right:calc(env(safe-area-inset-right,0px) + 16px);",
    "width:38px;height:38px;display:grid;place-items:center;padding:0;margin:0;cursor:pointer;",
    "border:1px solid var(--line,#DCD4C6);border-radius:50%;background:var(--surface,var(--card,#fff));color:var(--muted,#68625F);",
    "transition:color .2s,border-color .2s,transform .2s;-webkit-tap-highlight-color:transparent}",
    ".theme-toggle:hover{color:var(--ink,#2B2829);border-color:color-mix(in srgb,var(--ink,#2B2829) 30%,var(--line,#E4E0DA))}",
    ".theme-toggle:active{transform:scale(.94)}",
    ".theme-toggle:focus-visible{outline:2px solid var(--accent,var(--brand,#4F6B78));outline-offset:3px}",
    ".theme-toggle svg{width:18px;height:18px;display:block;transition:transform .5s cubic-bezier(.34,1.56,.64,1)}",
    ".theme-toggle:hover svg{transform:rotate(-20deg)}",
    "@media (min-width:720px){.theme-toggle{top:var(--theme-top,20px);right:24px}}",
    "@media (prefers-reduced-motion:reduce){.theme-toggle,.theme-toggle svg{transition:none}}"
  ].join("");
  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  var btn;
  function paint() {
    if (!btn) return;
    var dark = isDark();
    btn.innerHTML = dark ? MOON : SUN;
    btn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
    btn.title = dark ? "Light mode" : "Dark mode";
  }
  function changed() {
    paint();
    try { document.dispatchEvent(new Event("themechange")); } catch (e) {}
  }

  function mount() {
    if (document.querySelector(".theme-toggle")) return;
    var style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    btn.onclick = function () {
      root.dataset.theme = isDark() ? "light" : "dark";
      set(root.dataset.theme);
      changed();
    };
    paint();
    document.body.appendChild(btn);
  }

  if (media.addEventListener) media.addEventListener("change", changed);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
