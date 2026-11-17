/*
  Site do SIMPA: monta a página com os dados da planilha do Google.

  Ordem de carregamento:
  1. Mostra na hora a última leitura salva neste navegador (ou a cópia de
     segurança em data/historico.js, se for a primeira visita).
  2. Consulta a planilha e redesenha quando os dados novos chegam.
  3. Se a planilha não responder, continua com a cópia e avisa discretamente.
*/
(function () {
  "use strict";

  var CFG = window.SIMPA_CONFIG || {};
  var CACHE_KEY = "simpa-planilha-v1";
  var data = null;           // { atual, historico, lidoEm, origem }
  var selecionado = null;    // ano da aba aberta nos anais

  // ---------------------------------------------------------------- utilidades
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return n;
  }
  function $(id) { return document.getElementById(id); }
  function countWorks(ed) { return (ed.sessoes || []).reduce(function (s, x) { return s + (x.trabalhos || []).length; }, 0); }
  function norm(s) { return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function highlight(text, q) {
    var frag = document.createDocumentFragment();
    if (!q) { frag.appendChild(document.createTextNode(text)); return frag; }
    var nt = norm(text), nq = norm(q), i = 0, idx;
    while ((idx = nt.indexOf(nq, i)) !== -1) {
      frag.appendChild(document.createTextNode(text.slice(i, idx)));
      frag.appendChild(el("span", { "class": "hl", text: text.slice(idx, idx + nq.length) }));
      i = idx + nq.length;
    }
    frag.appendChild(document.createTextNode(text.slice(i)));
    return frag;
  }

  // Ícones (traço, herdam a cor do link)
  var ICONES = {
    "Artigo": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    "Slides": '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M12 16v4M8 20h8"/><path d="M7 12l3-3 2 2 4-4"/>',
    "Vídeo": '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9.5v5l4.5-2.5z" fill="currentColor"/>'
  };
  function icone(label) {
    var span = document.createElement("span");
    span.className = "ico";
    span.setAttribute("aria-hidden", "true");
    span.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + ICONES[label] + "</svg>";
    return span;
  }
  function linkOrOff(label, url, title) {
    if (!url) return null;
    return el("a", { href: url, target: "_blank", rel: "noopener", "class": "mat", "aria-label": label + " (abre em nova aba): " + title }, [icone(label), el("span", { text: label })]);
  }
  // Três posições fixas (Artigo, Slides, Vídeo) para os ícones ficarem alinhados em coluna
  function linksOf(t) {
    var ls = [linkOrOff("Artigo", t.artigo, t.titulo), linkOrOff("Slides", t.slides, t.titulo), linkOrOff("Vídeo", t.video, t.titulo)];
    if (!ls.some(Boolean)) return [el("span", { "class": "none", text: "Materiais não publicados" })];
    return ls.map(function (a) { return a || el("span", { "class": "slot", "aria-hidden": "true" }); });
  }

  function workItem(t, opts) {
    opts = opts || {};
    var titleSpan = el("span", { "class": "title" });
    if (opts.year) titleSpan.appendChild(el("span", { "class": "year", text: opts.year }));
    titleSpan.appendChild(highlight(t.titulo, opts.q));
    var author = el("span", { "class": "author" });
    author.appendChild(highlight(t.autor, opts.q));
    if (t.remoto) author.appendChild(el("span", { "class": "tag", text: "remoto" }));
    titleSpan.appendChild(author);
    return el("li", null, [
      el("span", { "class": "time", text: t.horario || "" }),
      titleSpan,
      el("span", { "class": "links" }, linksOf(t))
    ]);
  }

  function renderEdition(ed, container) {
    container.innerHTML = "";
    container.appendChild(el("div", { "class": "edition-head" }, [
      el("strong", { text: ed.nome }),
      el("span", { text: countWorks(ed) + " trabalhos" }),
      ed.local ? el("span", { text: ed.local }) : null,
      ed.playlist ? el("a", { href: ed.playlist, target: "_blank", rel: "noopener", text: "Playlist no YouTube" }) : null
    ]));
    if (ed.abertura && ed.abertura.horario) {
      container.appendChild(el("ul", { "class": "toc" }, [el("li", null, [
        el("span", { "class": "time", text: ed.abertura.horario || "" }),
        el("span", { "class": "title open" }, [(ed.abertura.titulo || "Início dos trabalhos") + (ed.abertura.autor ? ", " + ed.abertura.autor : "")]),
        el("span", { "class": "links" }, [linkOrOff("Vídeo", ed.abertura.video, ed.abertura.titulo)])
      ])]));
    }
    (ed.sessoes || []).forEach(function (s) {
      var ul = el("ul", { "class": "toc" });
      (s.trabalhos || []).forEach(function (t) { ul.appendChild(workItem(t)); });
      container.appendChild(el("div", { "class": "session" }, [el("h3", { text: s.nome }), ul]));
    });
  }

  // ---------------------------------------------------------------- horários (Brasília, UTC−3)
  function horaBRT(dataIso, texto, padrao) {
    var m = /(\d{1,2})\s*[h:]\s*(\d{0,2})/.exec(texto || "") || /(\d{1,2})h(\d{0,2})/.exec(padrao);
    var hh = ("0" + m[1]).slice(-2), mm = m[2] ? ("0" + m[2]).slice(-2) : "00";
    return new Date(dataIso + "T" + hh + ":" + mm + ":00-03:00");
  }
  function inicioTexto(a) { return (a.abertura && a.abertura.horario ? a.abertura.horario.split("–")[0] : "") || "8h00"; }
  function utcStamp(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function icsEscape(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }

  // ---------------------------------------------------------------- contador
  var cdTimer = null;
  function startCountdown(a) {
    var box = $("countdown");
    clearInterval(cdTimer);
    if (!box || !a || !a.data) { if (box) box.hidden = true; return; }
    var alvo = horaBRT(a.data, inicioTexto(a), "8h00").getTime();
    if (isNaN(alvo)) return;
    var fim = alvo + 10 * 3600000;
    var ids = ["cd-d", "cd-h", "cd-m", "cd-s"].map($);
    var label = $("cd-label"), sr = $("cd-sr"), grid = box.querySelector(".cd-grid");
    var pad = function (n) { return n < 10 ? "0" + n : String(n); };
    box.hidden = false; grid.hidden = false; box.classList.remove("done"); label.textContent = "Começa em"; sr.textContent = "";
    function tick() {
      var agora = Date.now(), resta = alvo - agora;
      if (resta <= 0) {
        clearInterval(cdTimer);
        grid.hidden = true; box.classList.add("done");
        label.textContent = agora < fim ? "Acontecendo agora" : "Evento realizado";
        sr.textContent = label.textContent;
        return;
      }
      var s = Math.floor(resta / 1000);
      var v = [Math.floor(s / 86400), Math.floor(s % 86400 / 3600), Math.floor(s % 3600 / 60), s % 60];
      ids[0].textContent = v[0];
      for (var i = 1; i < 4; i++) ids[i].textContent = pad(v[i]);
      if (v[3] === 59 || !sr.textContent) sr.textContent = "Começa em " + v[0] + " dias, " + v[1] + " horas e " + v[2] + " minutos";
    }
    tick();
    cdTimer = setInterval(tick, 1000);
  }

  // ---------------------------------------------------------------- evento atual
  function setText(id, v) { var n = $(id); if (n && v) n.textContent = v; }

  function renderAtual(a) {
    setText("ev-data", a.dataExtenso);
    setText("ev-periodo", a.periodo);
    setText("ev-local", a.local);
    setText("ev-formato", a.formato);
    // títulos que levam o ano
    document.querySelectorAll("[data-ano]").forEach(function (n) { n.textContent = a.ano; });
    $("prog-title").textContent = "Programação " + a.ano;
    startCountdown(a);

    var box = $("prog-2026");
    box.innerHTML = "";
    if (countWorks(a) === 0) {
      box.appendChild(el("div", { "class": "empty" }, [
        el("p", { html: "<strong>A programação ainda não foi publicada.</strong>" }),
        el("p", { text: "Ela é publicada aqui assim que os professores montarem as sessões." }),
        el("p", null, [el("a", { href: "#anais", text: "Ver os trabalhos das edições anteriores" })])
      ]));
    } else {
      renderEdition(a, box);
    }
  }

  function renderLocal(a) {
    if (!a || !a.data) return;
    var ini = horaBRT(a.data, inicioTexto(a), "8h00");
    var fim = horaBRT(a.data, a.horarioFim, "18h00");
    if (isNaN(ini) || isNaN(fim)) return;
    var lugar = [a.sala, a.local, a.endereco].filter(Boolean).join(", ");
    var detalhes = "Seminário final da disciplina Escrita Acadêmica Eficiente e Eficaz (PPGA-UTFPR). Programação: " + location.origin + location.pathname + "#programacao" +
      (a.linkRemoto ? "\nTransmissão: " + a.linkRemoto : "");
    setText("lc-endereco", [a.local, a.endereco].filter(Boolean).join(", "));
    $("lc-sala").textContent = a.sala || "A confirmar. A sala é divulgada aqui antes do evento.";
    setText("lc-quando", (a.dataExtenso || a.data) + ", das " + inicioTexto(a) + " às " + (a.horarioFim || "18h00"));
    var r = $("lc-remoto"); r.textContent = "";
    if (a.linkRemoto) r.appendChild(el("a", { href: a.linkRemoto, target: "_blank", rel: "noopener", text: "Entrar na transmissão" }));
    else r.textContent = "O link da transmissão é publicado aqui no dia do evento.";

    var q = encodeURIComponent([a.local, a.endereco].filter(Boolean).join(", "));
    $("btn-maps").href = "https://www.google.com/maps/search/?api=1&query=" + q;
    var mapSrc = "https://www.google.com/maps?q=" + q + "&z=16&output=embed";
    if ($("mapa").getAttribute("src") !== mapSrc) $("mapa").src = mapSrc;

    $("btn-gcal").href = "https://calendar.google.com/calendar/render?action=TEMPLATE" +
      "&text=" + encodeURIComponent(a.nome || "SIMPA") +
      "&dates=" + utcStamp(ini) + "/" + utcStamp(fim) +
      "&details=" + encodeURIComponent(detalhes) +
      "&location=" + encodeURIComponent(lugar) +
      "&ctz=America/Sao_Paulo";
    icsAtual = { a: a, ini: ini, fim: fim, lugar: lugar, detalhes: detalhes };
  }
  var icsAtual = null;
  $("btn-ics").addEventListener("click", function () {
    if (!icsAtual) return;
    var a = icsAtual.a;
    var ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//SIMPA PPGA-UTFPR//PT-BR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:simpa-" + a.ano + "@ppga-utfpr",
      "DTSTAMP:" + utcStamp(new Date()),
      "DTSTART:" + utcStamp(icsAtual.ini),
      "DTEND:" + utcStamp(icsAtual.fim),
      "SUMMARY:" + icsEscape(a.nome),
      "DESCRIPTION:" + icsEscape(icsAtual.detalhes),
      "LOCATION:" + icsEscape(icsAtual.lugar),
      a.linkRemoto ? "URL:" + a.linkRemoto : null,
      "BEGIN:VALARM", "TRIGGER:-P1D", "ACTION:DISPLAY", "DESCRIPTION:" + icsEscape(a.nome + " é amanhã"), "END:VALARM",
      "END:VEVENT", "END:VCALENDAR"
    ].filter(Boolean).join("\r\n");
    var link = el("a", { href: URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" })), download: "simpa-" + a.ano + ".ics" });
    document.body.appendChild(link); link.click(); link.remove();
  });

  // ---------------------------------------------------------------- anais
  var tabs = $("tabs"), conteudo = $("anais-conteudo"), busca = $("busca");
  var limpar = $("busca-limpar"), buscaStatus = $("busca-status"), statusTimer;

  function historico() { return (data && data.historico) || []; }

  function renderTabs() {
    var h = historico();
    tabs.innerHTML = "";
    h.forEach(function (ed) {
      var b = el("button", { role: "tab", type: "button", id: "tab-" + ed.ano, "aria-selected": String(ed.ano === selecionado), "aria-controls": "anais-conteudo", text: String(ed.ano) });
      b.tabIndex = ed.ano === selecionado ? 0 : -1;
      b.addEventListener("click", function () { selecionado = ed.ano; busca.value = ""; renderTabs(); renderAnais(); });
      b.addEventListener("keydown", function (e) {
        var i = h.indexOf(ed);
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          var n = h[(i + (e.key === "ArrowRight" ? 1 : -1) + h.length) % h.length];
          selecionado = n.ano; busca.value = ""; renderTabs(); renderAnais();
          $("tab-" + n.ano).focus();
        }
      });
      tabs.appendChild(b);
    });
  }

  function renderAnais() {
    var h = historico(), q = busca.value.trim();
    limpar.hidden = !busca.value;
    conteudo.setAttribute("role", q ? "region" : "tabpanel");
    if (q) conteudo.setAttribute("aria-label", "Resultados da busca"); else conteudo.setAttribute("aria-labelledby", "tab-" + selecionado);
    if (!h.length) {
      conteudo.innerHTML = "";
      conteudo.appendChild(el("p", { "class": "search-count", text: "Nenhuma edição anterior encontrada na planilha." }));
      return;
    }
    if (!q) {
      clearTimeout(statusTimer); buscaStatus.textContent = "";
      var ed = h.filter(function (e) { return e.ano === selecionado; })[0];
      if (ed) renderEdition(ed, conteudo);
      return;
    }
    conteudo.innerHTML = "";
    var nq = norm(q), results = [];
    h.forEach(function (ed) {
      (ed.sessoes || []).forEach(function (s) {
        (s.trabalhos || []).forEach(function (t) {
          if (norm(t.titulo).indexOf(nq) !== -1 || norm(t.autor).indexOf(nq) !== -1) results.push({ ed: ed, t: t });
        });
      });
    });
    var msg = results.length ? results.length + (results.length === 1 ? " trabalho encontrado" : " trabalhos encontrados") + " para “" + q + "”" : "Nenhum trabalho com “" + q + "” no título ou no nome do autor. Tente outra palavra.";
    conteudo.appendChild(el("p", { "class": "search-count", text: msg }));
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () { buscaStatus.textContent = msg; }, 700);
    var ul = el("ul", { "class": "toc" });
    results.forEach(function (r) { ul.appendChild(workItem(r.t, { q: q, year: String(r.ed.ano) })); });
    conteudo.appendChild(ul);
  }

  busca.addEventListener("input", renderAnais);
  limpar.addEventListener("click", function () { busca.value = ""; renderAnais(); busca.focus(); });

  // ---------------------------------------------------------------- origem dos dados
  function renderFonte() {
    var n = $("fonte-dados");
    if (!n || !data) return;
    var quando = data.lidoEm ? new Date(data.lidoEm).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : null;
    var txt = {
      planilha: "Dados lidos da planilha do SIMPA" + (quando ? " em " + quando : "") + ".",
      cache: "Mostrando a última leitura da planilha" + (quando ? " (" + quando + ")" : "") + ". Atualizando…",
      copia: "Carregando dados da planilha…",
      erro: "Não foi possível ler a planilha agora. Mostrando " + (quando ? "a leitura de " + quando : "a cópia salva no site") + "."
    }[data.origem] || "";
    n.textContent = txt;
    n.className = "fonte-dados" + (data.origem === "erro" ? " fonte-erro" : "");
    document.documentElement.toggleAttribute("data-carregando", data.origem === "copia" || data.origem === "cache");
  }

  function stat() {
    var h = historico(), n = $("stat-historico");
    if (!n || !h.length) return;
    var total = h.reduce(function (s, e) { return s + countWorks(e); }, 0);
    var anos = h.map(function (e) { return e.ano; }).sort();
    n.textContent = "Desde " + anos[0] + ", " + total + " trabalhos foram apresentados no SIMPA em " + h.length + (h.length === 1 ? " edição." : " edições.");
  }

  // ---------------------------------------------------------------- desenhar tudo
  function render(novo, origem) {
    var mesmo = data && JSON.stringify(data.atual) === JSON.stringify(novo.atual) && JSON.stringify(data.historico) === JSON.stringify(novo.historico);
    data = { atual: novo.atual, historico: novo.historico, lidoEm: novo.lidoEm, origem: origem };
    renderFonte();
    if (mesmo) return;
    var h = historico();
    if (!h.some(function (e) { return e.ano === selecionado; })) selecionado = h.length ? h[0].ano : null;
    renderAtual(data.atual);
    renderLocal(data.atual);
    renderTabs();
    renderAnais();
    stat();
  }

  // ---------------------------------------------------------------- cópia de segurança e cache
  function copiaDoSite() {
    var a = clone(window.SIMPA_2026 || {});
    a.sessoes = a.sessoes || [];
    return { atual: a, historico: clone(window.SIMPA_HISTORICO || []).sort(function (x, y) { return y.ano - x.ano; }), lidoEm: null };
  }
  function lerCache() { try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); } catch (e) { return null; } }
  function salvarCache(d) { try { localStorage.setItem(CACHE_KEY, JSON.stringify({ atual: d.atual, historico: d.historico, lidoEm: d.lidoEm })); } catch (e) { /* sem espaço ou modo privado */ } }

  var cache = lerCache();
  render(cache || copiaDoSite(), cache ? "cache" : "copia");

  var fresco = cache && cache.lidoEm && (Date.now() - new Date(cache.lidoEm).getTime()) < (CFG.cacheMinutos || 0) * 60000;
  if (fresco) { data.origem = "planilha"; renderFonte(); }
  else if (window.SIMPA_PLANILHA && CFG.planilhaId) {
    window.SIMPA_PLANILHA.carregar({ planilhaId: CFG.planilhaId, tempoLimite: CFG.tempoLimite, eventoPadrao: window.SIMPA_2026 })
      .then(function (d) { salvarCache(d); render(d, "planilha"); })
      .catch(function (e) {
        if (window.console) console.warn("SIMPA: falha ao ler a planilha:", e);
        data.origem = "erro"; renderFonte();
      });
  }

  // ---------------------------------------------------------------- voltar ao topo
  var toTop = $("to-top");
  if (toTop) {
    var onScroll = function () {
      var nearEnd = window.scrollY + window.innerHeight > document.documentElement.scrollHeight - 240;
      toTop.hidden = window.scrollY < 1400 || nearEnd;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
})();
