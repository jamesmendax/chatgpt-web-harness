/* 灵光 · appearance before first paint. A separate file because the CSP forbids inline scripts.
   The choice ("system" | "light" | "dark") lives only in this renderer's local storage. */
(function () {
  "use strict";
  var choice = "system";
  try { choice = localStorage.getItem("wh.aura.theme") || "system"; } catch (_) { /* storage unavailable: follow the system */ }
  if (choice !== "light" && choice !== "dark") choice = "system";
  var dark = choice === "dark" || (choice === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themeChoice = choice;
})();
