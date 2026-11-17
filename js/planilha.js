/*
  Leitor da planilha do SIMPA (Google Sheets).

  Baixa a planilha inteira em .xlsx direto do Google (a planilha precisa estar
  compartilhada como "Qualquer pessoa com o link: leitor") e monta os dados do site.
  Usamos .xlsx e não CSV porque só ele preserva os links embutidos nas células
  (título com link do artigo, "Apresentação" com link dos slides etc.).

  Regras de leitura:
  - Cada aba cujo nome tem um ano (ex.: "2025") vira uma edição.
  - A aba "Evento" (opcional) tem pares Chave | Valor com os dados da edição atual.
  - Em cada aba de edição, a linha de cabeçalho é a que contém "Autor".
    Colunas reconhecidas pelo nome: Sessão, Horário, Autor, Trabalho/Título,
    Artigo, Apresentação/Slides, Vídeo, Coordenadores.
    O horário e a sessão também são detectados sem cabeçalho.
  - Links: vale o link embutido na célula ou uma URL escrita na própria célula.

  Sem dependências: o .xlsx é descompactado com DecompressionStream do navegador.
*/
(function () {
  "use strict";

  // ---------------------------------------------------------------- ZIP
  async function unzip(buffer) {
    var dv = new DataView(buffer), u8 = new Uint8Array(buffer);
    var eocd = -1;
    for (var i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("Arquivo .xlsx inválido (fim do zip não encontrado).");
    var count = dv.getUint16(eocd + 10, true), p = dv.getUint32(eocd + 16, true);
    var entries = {}, dec = new TextDecoder();
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      var method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true);
      var nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      var off = dv.getUint32(p + 42, true);
      var name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
      entries[name] = { method: method, size: size, off: off };
      p += 46 + nl + xl + cl;
    }
    return {
      has: function (name) { return !!entries[name]; },
      text: async function (name) {
        var e = entries[name];
        if (!e) return null;
        var lnl = dv.getUint16(e.off + 26, true), lxl = dv.getUint16(e.off + 28, true);
        var start = e.off + 30 + lnl + lxl, data = u8.subarray(start, start + e.size);
        if (e.method === 0) return dec.decode(data);
        if (e.method !== 8) throw new Error("Compressão não suportada em " + name);
        var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
        return await new Response(stream).text();
      }
    };
  }

  // ---------------------------------------------------------------- XLSX
  var parser = new DOMParser();
  function xml(s) { return parser.parseFromString(s, "application/xml"); }
  function textOf(node) {
    // junta <t> de texto simples e de texto rico, ignorando a transcrição fonética
    var ts = node.getElementsByTagName("t"), out = "";
    for (var i = 0; i < ts.length; i++) if (!ts[i].closest || !ts[i].closest("rPh")) out += ts[i].textContent;
    return out;
  }
  function colIndex(ref) {
    var m = /^([A-Z]+)/.exec(ref), n = 0;
    for (var i = 0; i < m[1].length; i++) n = n * 26 + (m[1].charCodeAt(i) - 64);
    return n - 1;
  }
  function rowIndex(ref) { return parseInt(/(\d+)$/.exec(ref)[1], 10) - 1; }
  function dirOf(path) { return path.slice(0, path.lastIndexOf("/") + 1); }
  function resolve(base, target) {
    if (target.charAt(0) === "/") return target.slice(1);
    var parts = (dirOf(base) + target).split("/"), out = [];
    parts.forEach(function (p) { if (p === "..") out.pop(); else if (p !== ".") out.push(p); });
    return out.join("/");
  }
  async function rels(zip, path) {
    var r = {}, relPath = dirOf(path) + "_rels/" + path.slice(path.lastIndexOf("/") + 1) + ".rels";
    var s = await zip.text(relPath);
    if (!s) return r;
    var list = xml(s).getElementsByTagName("Relationship");
    for (var i = 0; i < list.length; i++) r[list[i].getAttribute("Id")] = { target: list[i].getAttribute("Target"), mode: list[i].getAttribute("TargetMode") };
    return r;
  }

  // Devolve [{ nome, linhas: [[{v, l}]] }]
  async function lerXlsx(buffer) {
    var zip = await unzip(buffer);
    var wbPath = "xl/workbook.xml";
    var wb = xml(await zip.text(wbPath)), wbRels = await rels(zip, wbPath);
    var shared = [];
    var ssText = await zip.text("xl/sharedStrings.xml");
    if (ssText) {
      var si = xml(ssText).getElementsByTagName("si");
      for (var i = 0; i < si.length; i++) shared.push(textOf(si[i]));
    }
    var sheets = wb.getElementsByTagName("sheet"), out = [];
    for (var s = 0; s < sheets.length; s++) {
      var rid = sheets[s].getAttribute("r:id");
      var path = resolve(wbPath, wbRels[rid].target);
      var doc = xml(await zip.text(path)), shRels = await rels(zip, path);
      var grid = [];
      var cells = doc.getElementsByTagName("c");
      for (var c = 0; c < cells.length; c++) {
        var cell = cells[c], ref = cell.getAttribute("r"), t = cell.getAttribute("t");
        var v = cell.getElementsByTagName("v")[0], f = cell.getElementsByTagName("f")[0], val = "";
        if (t === "s" && v) val = shared[parseInt(v.textContent, 10)] || "";
        else if (t === "inlineStr") val = textOf(cell);
        else if (v) val = v.textContent;
        var link = null;
        if (f && /HYPERLINK/i.test(f.textContent)) { var m = /"(https?:\/\/[^"]+)"/.exec(f.textContent); if (m) link = m[1]; }
        var r = rowIndex(ref), k = colIndex(ref);
        (grid[r] = grid[r] || [])[k] = { v: val, l: link, n: !t && v ? Number(val) : null };
      }
      var hl = doc.getElementsByTagName("hyperlink");
      for (var h = 0; h < hl.length; h++) {
        var ref2 = hl[h].getAttribute("ref").split(":")[0], id = hl[h].getAttribute("r:id");
        if (!id || !shRels[id]) continue;
        var rr = rowIndex(ref2), kk = colIndex(ref2);
        grid[rr] = grid[rr] || [];
        grid[rr][kk] = grid[rr][kk] || { v: "", l: null, n: null };
        grid[rr][kk].l = shRels[id].target;
      }
      for (var g = 0; g < grid.length; g++) grid[g] = grid[g] || [];
      out.push({ nome: sheets[s].getAttribute("name"), linhas: grid });
    }
    return out;
  }

  // ---------------------------------------------------------------- Interpretação
  function norm(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim(); }
  function clean(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
  function cellText(row, k) { return k == null || !row[k] ? "" : clean(row[k].v); }
  function cellUrl(row, k) {
    if (k == null || !row[k]) return null;
    var c = row[k], u = c.l || (/^https?:\/\/\S+$/.test(clean(c.v)) ? clean(c.v) : null);
    return u ? u.replace(/\*+$/, "") : null;
  }

  var SIGLAS = /^(MTM|UTFPR|AHP|UTAUT2|RAG|IA|TI|RUS|IES|MQL|CO2|VANETS|LEI|PPGA|STN|ESG|ODS|EAD|TCC|ERP|IOT|API|LLM|PR|SC|SP|RJ|BR)$/;
  var MINUSC = { a:1,o:1,e:1,de:1,da:1,"do":1,das:1,dos:1,em:1,na:1,no:1,nas:1,nos:1,para:1,por:1,com:1,um:1,uma:1,"à":1,ao:1,as:1,os:1,sob:1,sobre:1,entre:1,face:1,del:1,la:1,el:1,y:1 };
  // Converte títulos escritos todos em maiúsculas
  function titulo(s) {
    if (s !== s.toUpperCase() || !/[A-ZÀ-Ú]{4}/.test(s)) return s;
    var prev = "";
    return s.split(" ").map(function (w, i) {
      var core = w.replace(/[:,;.()“”"]/g, "");
      var out;
      if (SIGLAS.test(core)) out = w;
      else {
        var lw = w.toLowerCase();
        out = i > 0 && MINUSC[lw.replace(/[:,]/g, "")] && !/:$/.test(prev) ? lw : lw.charAt(0).toUpperCase() + lw.slice(1);
      }
      prev = w; return out;
    }).join(" ");
  }
  function horario(s) { return clean(s).replace(/\s+(?:às|as|a)\s+|\s*[-–]\s*/i, "–"); }
  function hora(s) { var m = /(\d{1,2})\s*h/.exec(s || ""); return m ? +m[1] : null; }

  function lerEdicao(aba, ano, avisos) {
    var L = aba.linhas, h = -1;
    for (var i = 0; i < L.length && h < 0; i++) {
      for (var k = 0; k < L[i].length; k++) if (/^autor/.test(norm(L[i][k] && L[i][k].v))) { h = i; break; }
    }
    if (h < 0) { avisos.push("Aba “" + aba.nome + "”: não encontrei a linha de cabeçalho com “Autor”. A aba foi ignorada."); return null; }
    var head = L[h], col = {};
    head.forEach(function (c, k) {
      var n = norm(c && c.v);
      if (!n) return;
      if (/^autor/.test(n)) col.autor = k;
      else if (/^(trabalho|titulo)/.test(n)) col.titulo = k;
      else if (/^(apresenta|slide)/.test(n)) col.slides = k;
      else if (/^video/.test(n)) col.video = k;
      else if (/^coorden/.test(n)) col.coord = k;
      else if (/^(artigo|pdf)/.test(n)) col.artigo = k;
      else if (/^sess/.test(n)) col.sessao = k;
      else if (/^(horario|hora)/.test(n)) col.hora = k;
    });
    if (col.titulo == null) { avisos.push("Aba “" + aba.nome + "”: falta a coluna “Trabalho” (ou “Título”). A aba foi ignorada."); return null; }
    var dados = L.slice(h + 1);
    function detect(re, skip) {
      var best = null, bestN = 0, width = Math.max.apply(null, dados.map(function (r) { return r.length; }).concat([0]));
      for (var k = 0; k < width; k++) {
        if (skip.indexOf(k) >= 0) continue;
        var n = dados.filter(function (r) { return re.test(cellText(r, k)); }).length;
        if (n > bestN) { best = k; bestN = n; }
      }
      return best;
    }
    if (col.hora == null) col.hora = detect(/^\d{1,2}\s*h/i, [col.autor, col.titulo]);
    if (col.sessao == null) col.sessao = detect(/^sess/i, [col.autor, col.titulo, col.hora]);

    // Cabeçalho da aba: local e playlist
    var local = null, playlist = null;
    L.slice(0, h).forEach(function (r) {
      r.forEach(function (c) {
        if (!c) return;
        if (c.l && /youtube\.com\/playlist/.test(c.l)) playlist = c.l;
        String(c.v || "").split(/\n/).map(clean).forEach(function (line) {
          if (line && !/^SIMPA\s*\d{4}$/i.test(line) && !/^simp[oó]sio de administra/i.test(line) && !/^https?:/.test(line)) local = local || line;
        });
      });
    });

    var ed = { ano: ano, nome: "SIMPA " + ano, local: local, playlist: playlist, abertura: null, sessoes: [] };
    var cur = null, porTurno = col.sessao == null;
    var turnos = { "Manhã": { nome: "Manhã", trabalhos: [] }, "Tarde": { nome: "Tarde", trabalhos: [] } };
    dados.forEach(function (r, idx) {
      var ses = cellText(r, col.sessao);
      if (/^sess/i.test(ses)) {
        cur = { nome: ses.replace(/^sess[aã]o\s*/i, "Sessão "), trabalhos: [] };
        ed.sessoes.push(cur);
      }
      var autor = cellText(r, col.autor), tit = cellText(r, col.titulo), hor = cellText(r, col.hora);
      if (!autor && !tit) return;
      if (autor === "-" || /in[ií]cio dos trabalhos/i.test(tit)) {
        ed.abertura = { horario: horario(hor), titulo: tit || "Início dos trabalhos", autor: autor === "-" ? cellText(r, col.coord) : autor, video: cellUrl(r, col.video) };
        return;
      }
      if (!tit) { avisos.push("Aba “" + aba.nome + "”, linha " + (h + idx + 2) + ": autor sem título do trabalho."); return; }
      var remoto = /\(remot[oa]\)/i.test(autor);
      var t = {
        horario: horario(hor),
        autor: clean(autor.replace(/\(remot[oa]\)/i, "")) || "Autor não informado",
        remoto: remoto,
        titulo: titulo(tit),
        artigo: col.artigo != null ? cellUrl(r, col.artigo) : cellUrl(r, col.titulo),
        slides: cellUrl(r, col.slides),
        video: cellUrl(r, col.video),
        coordenacao: cellText(r, col.coord) || null
      };
      if (porTurno) {
        var hh = hora(hor);
        turnos[hh != null && hh >= 12 ? "Tarde" : "Manhã"].trabalhos.push(t);
      } else {
        if (!cur) { cur = { nome: "Sessão", trabalhos: [] }; ed.sessoes.push(cur); }
        cur.trabalhos.push(t);
      }
    });
    if (porTurno) ed.sessoes = [turnos["Manhã"], turnos["Tarde"]].filter(function (s) { return s.trabalhos.length; });
    return ed;
  }

  // Aba "Evento": Chave | Valor
  var CHAVES = {
    "ano": "ano", "edicao": "ano", "nome": "nome", "data": "data", "data do evento": "data",
    "data por extenso": "dataExtenso", "horario": "periodo", "periodo": "periodo",
    "inicio": "inicio", "abertura": "inicio", "horario de inicio": "inicio",
    "termino": "horarioFim", "fim": "horarioFim", "horario de termino": "horarioFim",
    "local": "local", "endereco": "endereco", "sala": "sala", "formato": "formato",
    "prazo de submissao": "prazoSubmissao", "prazo": "prazoSubmissao",
    "link da transmissao": "linkRemoto", "transmissao": "linkRemoto", "google meet": "linkRemoto",
    "playlist": "playlist", "responsaveis pela abertura": "responsaveis", "responsaveis": "responsaveis"
  };
  function serialParaISO(n) {
    var d = new Date(Math.round((n - 25569) * 86400000));
    return d.toISOString().slice(0, 10);
  }
  function dataISO(c) {
    if (!c) return null;
    if (c.n != null && !isNaN(c.n) && c.n > 30000 && c.n < 80000) return serialParaISO(c.n);
    var s = clean(c.v), m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }
  function horaTexto(c) {
    if (!c) return null;
    if (c.n != null && !isNaN(c.n) && c.n > 0 && c.n < 1) { var min = Math.round(c.n * 1440); return Math.floor(min / 60) + "h" + ("0" + (min % 60)).slice(-2); }
    return clean(c.v).replace(/^(\d{1,2}):(\d{2})$/, "$1h$2") || null;
  }
  function lerEvento(aba) {
    var ev = {};
    aba.linhas.forEach(function (r) {
      var key = CHAVES[norm(r[0] && r[0].v).replace(/[:]/g, "")];
      if (!key || !r[1]) return;
      var c = r[1];
      if (key === "data" || key === "prazoSubmissao") ev[key] = dataISO(c);
      else if (key === "inicio" || key === "horarioFim") ev[key] = horaTexto(c);
      else if (key === "ano") ev.ano = parseInt(clean(c.v), 10) || null;
      else if (key === "linkRemoto" || key === "playlist") ev[key] = c.l || (/^https?:/.test(clean(c.v)) ? clean(c.v) : null);
      else ev[key] = clean(c.v) || null;
    });
    return ev;
  }
  function extenso(iso) {
    var d = new Date(iso + "T12:00:00-03:00");
    var s = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ---------------------------------------------------------------- API
  async function carregar(cfg) {
    var url = "https://docs.google.com/spreadsheets/d/" + cfg.planilhaId + "/export?format=xlsx";
    var ctrl = new AbortController(), timer = setTimeout(function () { ctrl.abort(); }, cfg.tempoLimite || 20000);
    var res;
    try { res = await fetch(url, { cache: "no-store", signal: ctrl.signal, credentials: "omit" }); }
    finally { clearTimeout(timer); }
    if (!res.ok) throw new Error("A planilha respondeu " + res.status + ". Ela está compartilhada como “Qualquer pessoa com o link”?");
    var buf = await res.arrayBuffer();
    if (new Uint8Array(buf, 0, 2)[0] !== 0x50) throw new Error("O Google não devolveu um .xlsx. Confira o compartilhamento da planilha.");
    var abas = await lerXlsx(buf);
    return montar(abas, cfg);
  }

  function montar(abas, cfg) {
    var avisos = [], base = JSON.parse(JSON.stringify(cfg.eventoPadrao || {}));
    var abaEvento = abas.filter(function (a) { return /^(evento|config)/.test(norm(a.nome)); })[0];
    var ev = abaEvento ? lerEvento(abaEvento) : {};
    if (!abaEvento) avisos.push("Não há aba “Evento”. Usando os dados padrão do evento definidos em data/simpa-2026.js.");
    var atual = Object.assign(base, Object.keys(ev).reduce(function (o, k) { if (ev[k] != null) o[k] = ev[k]; return o; }, {}));
    atual.ano = atual.ano || new Date().getFullYear();
    if (ev.ano && !ev.nome) atual.nome = "SIMPA " + atual.ano;
    if (ev.data && !ev.dataExtenso) atual.dataExtenso = extenso(atual.data);
    atual.abertura = atual.abertura || { titulo: "Início dos trabalhos" };
    if (ev.inicio) atual.abertura.horario = ev.inicio;
    if (ev.responsaveis) atual.abertura.autor = ev.responsaveis;

    var historico = [], abasLidas = [];
    abas.forEach(function (a) {
      if (a === abaEvento) { abasLidas.push({ nome: a.nome, tipo: "Evento" }); return; }
      var m = /(\d{4})/.exec(a.nome);
      if (!m) { abasLidas.push({ nome: a.nome, tipo: "Ignorada (o nome não tem ano)" }); return; }
      var ano = +m[1], ed = lerEdicao(a, ano, avisos);
      if (!ed) { abasLidas.push({ nome: a.nome, tipo: "Com erro" }); return; }
      var n = ed.sessoes.reduce(function (s, x) { return s + x.trabalhos.length; }, 0);
      if (ano === atual.ano) {
        atual.sessoes = ed.sessoes;
        if (ed.abertura) atual.abertura = Object.assign({}, atual.abertura, ed.abertura, { horario: ed.abertura.horario || atual.abertura.horario });
        if (ed.playlist && !atual.playlist) atual.playlist = ed.playlist;
        abasLidas.push({ nome: a.nome, tipo: "Edição atual", trabalhos: n, sessoes: ed.sessoes.length });
      } else {
        historico.push(ed);
        abasLidas.push({ nome: a.nome, tipo: ano > atual.ano ? "Edição futura (aparece no histórico)" : "Histórico", trabalhos: n, sessoes: ed.sessoes.length });
      }
    });
    atual.sessoes = atual.sessoes || [];
    historico.sort(function (a, b) { return b.ano - a.ano; });
    return { atual: atual, historico: historico, avisos: avisos, abas: abasLidas, lidoEm: new Date().toISOString() };
  }

  window.SIMPA_PLANILHA = { carregar: carregar, lerXlsx: lerXlsx, montar: montar };
})();
