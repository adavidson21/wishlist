/*! Alexis Davidson brand 2.0.0, theme.js */
/* Brand light/dark theme and accent. One behavior for every app: Hints' round toggle in the top right corner, Workshop's API.

   Load it in <head> WITHOUT defer or async, so the saved theme is set before the page paints (no flash):
     <script src="https://tools.alexisdavidson.org/brand/v2/theme.js" data-accent="sapphire"></script>

   It sets data-theme="light|dark" on <html> from the saved choice, or leaves it off to follow the device until the
   person picks one. Then it adds the toggle button to <body>. Options, as attributes on the script tag:
     data-key="docket.theme"   localStorage key (default "theme", the same one Hints and LifeKit use)
     data-toggle="none"        do not add the button (an app that puts it in Settings or its own header)
     data-toggle-class="on-hero"  extra class for the button, e.g. on-hero when it sits on the wine band
     data-accent="sapphire"     the app's jewel accent (garnet, sapphire, tourmaline, amethyst); same as data-accent on <html>
   Any element with [data-theme-toggle] also flips the theme when clicked, wherever it was rendered.

   window.BrandTheme: current(), isDark(), set("light"|"dark"|"system"), toggle(), onChange(fn), toggleHtml(cls).
   A "themechange" event fires on document, with detail {theme}. Other tabs on the same site follow along. */
(function () {
  "use strict";
  var script = document.currentScript || {};
  var opt = function (n) { return script.getAttribute ? script.getAttribute(n) : null; };
  var KEY = opt("data-key") || "theme";
  var AUTO = opt("data-toggle") !== "none";
  var EXTRA = opt("data-toggle-class") || "";
  var ACCENT = opt("data-accent");
  // Page backgrounds, for the browser bar: meta theme-color tags without a media or data-keep attribute follow the theme.
  var SWATCH = { light: "#FAF6F1", dark: "#1A1517" };
  var root = document.documentElement;
  var media = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : { matches: false };
  var listeners = [];

  function saved() { try { var v = localStorage.getItem(KEY); return v === "light" || v === "dark" ? v : "system"; } catch (e) { return "system"; } }
  function save(v) { try { if (v === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, v); } catch (e) { /* private mode: this page only */ } }
  function current() { return root.dataset.theme || (media.matches ? "dark" : "light"); }
  function isDark() { return current() === "dark"; }

  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  function label() { return isDark() ? "Switch to light mode" : "Switch to dark mode"; }
  function toggleHtml(cls) {
    return '<button type="button" class="b-theme-toggle' + (cls ? " " + cls : "") + '" data-theme-toggle aria-label="' + label() + '" title="' + (isDark() ? "Light mode" : "Dark mode") + '">' + (isDark() ? MOON : SUN) + "</button>";
  }

  function paint() {
    var t = current();
    document.querySelectorAll('meta[name="theme-color"]:not([media]):not([data-keep])').forEach(function (m) { m.content = SWATCH[t]; });
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.innerHTML = t === "dark" ? MOON : SUN;
      b.setAttribute("aria-label", label());
      b.title = t === "dark" ? "Light mode" : "Dark mode";
    });
  }
  function apply() {
    var p = saved();
    if (p === "system") delete root.dataset.theme; else root.dataset.theme = p;
    paint();
    var t = current();
    listeners.forEach(function (fn) { try { fn(t); } catch (e) { console.error(e); } });
    try { document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: t } })); } catch (e) {}
    return t;
  }
  function set(v) { save(v === "light" || v === "dark" ? v : "system"); return apply(); }
  function toggle() { return set(isDark() ? "light" : "dark"); }
  function onChange(fn) { listeners.push(fn); }

  function mount() {
    paint();
    if (!AUTO || document.querySelector("[data-theme-toggle]")) return;
    var wrap = document.createElement("div");
    wrap.innerHTML = toggleHtml(EXTRA);
    document.body.appendChild(wrap.firstChild);
  }

  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest && e.target.closest("[data-theme-toggle]");
    if (b) { e.preventDefault(); toggle(); }
  });
  if (media.addEventListener) media.addEventListener("change", apply);
  window.addEventListener("storage", function (e) { if (e.key === KEY) apply(); });

  // Before first paint: only the attribute. The button and meta tags wait for the DOM.
  if (ACCENT && !root.dataset.accent) root.dataset.accent = ACCENT;
  var first = saved();
  if (first !== "system") root.dataset.theme = first;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();

  window.BrandTheme = { KEY: KEY, SWATCH: SWATCH, current: current, isDark: isDark, set: set, toggle: toggle, onChange: onChange, toggleHtml: toggleHtml, apply: apply };
})();
