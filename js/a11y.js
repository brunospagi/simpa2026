/* Barra de acessibilidade: tamanho do texto, alto contraste, modo escuro e leitura em voz alta.
   As preferências ficam salvas neste navegador. O VLibras é carregado no index.html. */
(function () {
  "use strict";
  var KEY = "simpa-a11y";
  var root = document.documentElement;
  var status = document.getElementById("a11y-status");
  var ZOOMS = [0.875, 1, 1.125, 1.25, 1.5];

  function load() { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; } }
  function save(p) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch (e) { /* modo privado */ } }
  function say(msg) { if (status) { status.textContent = ""; setTimeout(function () { status.textContent = msg; }, 50); } }
  var prefs = load();

  // ---------- Tamanho do texto ----------
  function applyZoom(z) {
    if (z === 1) { root.style.removeProperty("--zoom"); delete prefs.zoom; }
    else { root.style.setProperty("--zoom", z); prefs.zoom = z; }
    save(prefs);
  }
  Array.prototype.forEach.call(document.querySelectorAll("[data-zoom]"), function (b) {
    b.addEventListener("click", function () {
      var cur = prefs.zoom || 1, i = ZOOMS.indexOf(cur); if (i < 0) i = 1;
      var d = +b.dataset.zoom;
      var z = d === 0 ? 1 : ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, i + d))];
      applyZoom(z);
      say("Texto em " + Math.round(z * 100) + "%");
    });
  });

  // ---------- Alto contraste ----------
  var bC = document.getElementById("btn-contraste");
  function syncContrast() { if (bC) bC.setAttribute("aria-pressed", String(root.dataset.contrast === "high")); }
  if (bC) bC.addEventListener("click", function () {
    var on = root.dataset.contrast !== "high";
    if (on) { root.dataset.contrast = "high"; prefs.contrast = true; } else { delete root.dataset.contrast; delete prefs.contrast; }
    save(prefs); syncContrast(); syncTheme();
    say(on ? "Alto contraste ativado" : "Alto contraste desativado");
  });

  // ---------- Modo escuro ----------
  var bT = document.getElementById("btn-tema");
  var mq = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function isDark() { return root.dataset.theme ? root.dataset.theme === "dark" : !!(mq && mq.matches); }
  function syncTheme() {
    if (!bT) return;
    bT.setAttribute("aria-pressed", String(isDark()));
    bT.disabled = root.dataset.contrast === "high";
  }
  if (bT) bT.addEventListener("click", function () {
    var dark = !isDark();
    root.dataset.theme = dark ? "dark" : "light"; prefs.theme = root.dataset.theme;
    save(prefs); syncTheme();
    say(dark ? "Modo escuro ativado" : "Modo claro ativado");
  });
  if (mq && mq.addEventListener) mq.addEventListener("change", syncTheme);

  // ---------- Leitura em voz alta ----------
  var bO = document.getElementById("btn-ouvir");
  var synth = window.speechSynthesis;
  if (bO && !synth) bO.hidden = true;
  if (bO && synth) {
    var reading = false, queue = [], current = null;
    var pickVoice = function () {
      var vs = synth.getVoices();
      return vs.filter(function (v) { return /pt[-_]BR/i.test(v.lang); })[0] || vs.filter(function (v) { return /^pt/i.test(v.lang); })[0] || null;
    };
    // Lê o texto selecionado; sem seleção, lê o conteúdo principal, bloco a bloco
    var collect = function () {
      var sel = window.getSelection && String(window.getSelection()).trim();
      if (sel) return [{ el: null, text: sel }];
      var nodes = document.querySelectorAll("main h1, main h2, main h3, main p, main li, main dt, main dd");
      var out = [];
      Array.prototype.forEach.call(nodes, function (n) {
        if (n.closest("[hidden], .sr-only, [aria-hidden='true']") || !n.offsetParent) return;
        if (n.tagName !== "LI" && n.closest("li")) return; // evita ler duas vezes
        var t = (n.innerText || "").replace(/\s+/g, " ").trim();
        if (t) out.push({ el: n, text: t });
      });
      return out;
    };
    var mark = function (el) {
      if (current) current.classList.remove("reading");
      current = el;
      if (el) { el.classList.add("reading"); el.scrollIntoView({ block: "center", behavior: "smooth" }); }
    };
    var next = function () {
      if (!reading) return;
      var item = queue.shift();
      if (!item) { stop(); say("Leitura concluída"); return; }
      mark(item.el);
      var u = new SpeechSynthesisUtterance(item.text);
      u.lang = "pt-BR"; var v = pickVoice(); if (v) u.voice = v;
      u.rate = 1;
      u.onend = next; u.onerror = next;
      synth.speak(u);
    };
    var stop = function () {
      reading = false; queue = []; synth.cancel(); mark(null);
      bO.setAttribute("aria-pressed", "false"); bO.textContent = "Ouvir a página";
    };
    bO.addEventListener("click", function () {
      if (reading) { stop(); say("Leitura interrompida"); return; }
      queue = collect(); if (!queue.length) return;
      reading = true; bO.setAttribute("aria-pressed", "true"); bO.textContent = "Parar leitura";
      synth.cancel(); next();
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && reading) stop(); });
    window.addEventListener("pagehide", function () { synth.cancel(); });
  }

  syncContrast(); syncTheme();
})();
