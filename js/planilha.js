/*
  Leitor da planilha do SIMPA (Google Sheets).

  Baixa a planilha inteira em .xlsx direto do Google (a planilha precisa estar
  compartilhada como "Qualquer pessoa com o link: leitor") e monta os dados do site.
  Usamos .xlsx e não CSV porque só ele preserva os links embutidos nas células
  (título com link do artigo, "Apresentação" com link dos slides etc.).

  Regras de leitura:
  - Cada aba cujo nome tem um ano (ex.: "2025") vira uma edição.
  - A aba "Configuracao" (opcional) tem pares Campo | Conteúdo com os textos do site.
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
  // Segurança: só aceita links http(s). Descarta "javascript:", "data:" e outros esquemas
  // que alguém poderia colar na planilha.
  function urlSegura(u) {
    if (!u) return null;
    u = String(u).trim().replace(/\*+$/, "");
    try { var p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? p.href : null; }
    catch (e) { return null; }
  }
  function cellUrl(row, k) {
    if (k == null || !row[k]) return null;
    var c = row[k];
    return urlSegura(c.l) || urlSegura(/^https?:\/\/\S+$/.test(clean(c.v)) ? clean(c.v) : null);
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
  function minutos(s) { var m = /(\d{1,2})\s*[h:]\s*(\d{0,2})/.exec(s || ""); return m ? (+m[1]) * 60 + (+(m[2] || 0)) : null; }
  function fmtHora(min) { return Math.floor(min / 60) + "h" + ("0" + (min % 60)).slice(-2); }

  /*
    Lê uma aba de edição. A aba pode ter mais de um bloco lado a lado
    (Autor | Trabalho | Slides | Vídeo repetidos), por exemplo para duas salas:
    cada bloco é lido separadamente e usa a mesma coluna de sessão e horário.
  */
  function lerEdicao(aba, ano, avisos) {
    var L = aba.linhas, h = -1;
    for (var i = 0; i < L.length && h < 0; i++) {
      for (var k = 0; k < L[i].length; k++) if (/^autor/.test(norm(L[i][k] && L[i][k].v))) { h = i; break; }
    }
    if (h < 0) { avisos.push("Aba “" + aba.nome + "”: não encontrei a linha de cabeçalho com “Autor”. A aba foi ignorada."); return null; }
    var head = L[h], dados = L.slice(h + 1);

    // Blocos: um por coluna "Autor"
    var inicioBlocos = [];
    head.forEach(function (c, k) { if (/^autor/.test(norm(c && c.v))) inicioBlocos.push(k); });
    var global = {};
    var blocos = inicioBlocos.map(function (a, b) { return { autor: a, fim: b + 1 < inicioBlocos.length ? inicioBlocos[b + 1] : Infinity }; });
    head.forEach(function (c, k) {
      var n = norm(c && c.v);
      if (!n) return;
      if (/^sess/.test(n)) { if (global.sessao == null) global.sessao = k; return; }
      if (/^(horario|hora)/.test(n)) { if (global.hora == null) global.hora = k; return; }
      var bl = blocos.filter(function (x) { return k >= x.autor && k < x.fim; })[0];
      if (!bl) return;
      var chave = null;
      if (/^(trabalho|titulo)/.test(n)) chave = "titulo";
      else if (/^(apresenta|slide)/.test(n)) chave = "slides";
      else if (/^video/.test(n)) chave = "video";
      else if (/^coorden/.test(n)) chave = "coord";
      else if (/^(artigo|pdf)/.test(n)) chave = "artigo";
      if (chave && bl[chave] == null) bl[chave] = k;
    });
    blocos = blocos.filter(function (b) { return b.titulo != null; });
    if (!blocos.length) { avisos.push("Aba “" + aba.nome + "”: falta a coluna “Trabalho” (ou “Título”). A aba foi ignorada."); return null; }

    function detect(re, skip) {
      var best = null, bestN = 0, width = Math.max.apply(null, dados.map(function (r) { return r.length; }).concat([0]));
      for (var k = 0; k < width; k++) {
        if (skip.indexOf(k) >= 0) continue;
        var n = dados.filter(function (r) { return re.test(cellText(r, k)); }).length;
        if (n > bestN) { best = k; bestN = n; }
      }
      return best;
    }
    var ocupadas = [];
    blocos.forEach(function (b) { ocupadas.push(b.autor, b.titulo); });
    if (global.hora == null) global.hora = detect(/^\d{1,2}\s*h/i, ocupadas);
    if (global.sessao == null) global.sessao = detect(/^sess/i, ocupadas.concat([global.hora]));

    // Cabeçalho da aba: local, playlist e sala de cada bloco
    var local = null, playlist = null, salas = [];
    L.slice(0, h).forEach(function (r) {
      r.forEach(function (c, k) {
        if (!c) return;
        if (c.l && /youtube\.com\/playlist/.test(c.l)) playlist = urlSegura(c.l);
        String(c.v || "").split(/\n/).map(clean).forEach(function (line) {
          if (!line) return;
          if (/^sala\b/i.test(line)) { salas.push({ k: k, v: line }); return; }
          if (!/^SIMPA\s*\d{4}$/i.test(line) && !/^simp[oó]sio de administra/i.test(line) && !/^https?:/.test(line)) local = local || line;
        });
      });
    });
    blocos.forEach(function (b) {
      var cand = salas.filter(function (s) { return s.k <= b.autor; }).sort(function (x, y) { return y.k - x.k; })[0] || salas[0];
      b.sala = cand ? cand.v : null;
    });

    // Faixa de horário da aba (primeiro início e último término)
    var ini = null, fim = null;
    dados.forEach(function (r) {
      var t = cellText(r, global.hora);
      if (!/^\d{1,2}\s*h/i.test(t)) return;
      var partes = t.split(/\s+(?:às|as|a)\s+|\s*[-–]\s*/i);
      var a = minutos(partes[0]), z = minutos(partes[1] || partes[0]);
      if (a != null && (ini == null || a < ini)) ini = a;
      if (z != null && (fim == null || z > fim)) fim = z;
    });

    var ed = {
      ano: ano, nome: "SIMPA " + ano, local: local, playlist: playlist, abertura: null, sessoes: [],
      sala: blocos[0].sala || null, faixa: ini != null ? { inicio: fmtHora(ini), fim: fmtHora(fim) } : null
    };
    var porTurno = global.sessao == null;
    var nomeSessao = null, ordem = [];
    var porBloco = blocos.map(function () { return {}; });
    function grupoDe(hor) {
      var g = porTurno ? ((hora(hor) != null && hora(hor) >= 12) ? "Tarde" : "Manhã") : (nomeSessao || "Sessão");
      if (ordem.indexOf(g) < 0) { if (g === "Sessão") ordem.unshift(g); else ordem.push(g); }
      return g;
    }
    dados.forEach(function (r, idx) {
      var ses = cellText(r, global.sessao);
      if (/^sess/i.test(ses)) { nomeSessao = ses.replace(/^sess[aã]o\s*/i, "Sessão "); if (ordem.indexOf(nomeSessao) < 0) ordem.push(nomeSessao); }
      var hor = cellText(r, global.hora);
      var temHorario = /^\d{1,2}\s*h/i.test(hor);
      blocos.forEach(function (b, bi) {
        var autor = cellText(r, b.autor), tit = cellText(r, b.titulo);
        if (!autor && !tit) {
          // Horário reservado ainda sem trabalho: entra como "A definir"
          if (temHorario && (nomeSessao || porTurno)) {
            var gv = grupoDe(hor);
            (porBloco[bi][gv] = porBloco[bi][gv] || []).push({ horario: horario(hor), vago: true });
          }
          return;
        }
        if (autor === "-" || /in[ií]cio dos trabalhos/i.test(tit)) {
          if (!ed.abertura) ed.abertura = { horario: horario(hor), titulo: tit || "Início dos trabalhos", autor: autor === "-" ? cellText(r, b.coord) : autor, video: cellUrl(r, b.video) };
          return;
        }
        if (!tit) { avisos.push("Aba “" + aba.nome + "”, linha " + (h + idx + 2) + ": autor sem título do trabalho."); return; }
        var t = {
          horario: horario(hor),
          autor: clean(autor.replace(/\(remot[oa]\)/i, "")) || "Autor não informado",
          remoto: /\(remot[oa]\)/i.test(autor),
          titulo: titulo(tit),
          artigo: b.artigo != null ? cellUrl(r, b.artigo) : cellUrl(r, b.titulo),
          slides: cellUrl(r, b.slides),
          video: cellUrl(r, b.video),
          coordenacao: cellText(r, b.coord) || null
        };
        var g = grupoDe(hor);
        (porBloco[bi][g] = porBloco[bi][g] || []).push(t);
      });
    });
    if (porTurno) ordem = ["Manhã", "Tarde"].filter(function (g) { return ordem.indexOf(g) >= 0; });
    // Mais de uma sala: cada sessão aparece com uma coluna por sala
    var variasSalas = blocos.length > 1;
    ordem.forEach(function (g) {
      porBloco.forEach(function (pb, bi) {
        if (!pb[g]) return;
        ed.sessoes.push({ nome: g, bloco: bi, salaNome: blocos[bi].sala || null, sala: variasSalas ? (blocos[bi].sala || "Sala " + (bi + 1)) : null, trabalhos: pb[g] });
      });
    });
    return ed;
  }

  // ---------------------------------------------------------------- Aba de configuração
  // Aceita "Campo | Conteúdo" (aba Configuracao) e o modelo antigo "Chave | Valor" (aba Evento).
  var CHAVES = {
    nomeevento: "nomeEvento", ano: "ano", edicao: "ano", nome: "nome", resumo: "resumo",
    data: "data", datadoevento: "data", dataporextenso: "dataExtenso",
    horario: "periodo", periodo: "periodo",
    inicio: "inicio", abertura: "inicio", horariodeinicio: "inicio",
    termino: "horarioFim", fim: "horarioFim", horariodetermino: "horarioFim",
    local: "local", endereco: "endereco", sala: "sala", formato: "formato", quando: "quando",
    destaque: "destaqueSobre", subtitulo: "tituloSobre", resumosubtitulo: "textoSobre", complementoresumosubtitulo: "topicos",
    destaqueprogramacao: "destaqueProgramacao", programacao: "tituloProgramacao",
    destaquelocal: "destaqueLocal", subtitulo2: "tituloLocal",
    linkdatransmissao: "linkRemoto", transmissao: "linkRemoto", googlemeet: "linkRemoto",
    assistiradistancia: "remoto", assistirremotamente: "remoto",
    tituloanais: "tituloAnais", edicoesanteriores: "tituloAnais", destaqueanais: "destaqueAnais", textoanais: "textoAnais",
    botaoprincipal: "botao1", botao1: "botao1", botaosecundario: "botao2", botao2: "botao2",
    organizacao: "organizacao",
    salas: "salas", quantidadedesalas: "salas", numerodesalas: "salas", qtdsalas: "salas",
    playlist: "playlist", responsaveispelaabertura: "responsaveis", responsaveis: "responsaveis"
  };
  var MESES = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
  function serialParaISO(n) { return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10); }
  function dataISO(c) {
    if (!c) return null;
    if (c.n != null && !isNaN(c.n) && c.n > 30000 && c.n < 80000) return serialParaISO(c.n);
    var s = clean(c.v), m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return m[3] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    m = /(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/.exec(norm(s));
    if (m && MESES[m[2]]) return m[3] + "-" + ("0" + MESES[m[2]]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
    return null;
  }
  function horaTexto(c) {
    if (!c) return null;
    if (c.n != null && !isNaN(c.n) && c.n > 0 && c.n < 1) return fmtHora(Math.round(c.n * 1440));
    return clean(c.v).replace(/^(\d{1,2}):(\d{2})$/, "$1h$2") || null;
  }
  // Mantém as quebras de linha (parágrafos e listas)
  function textoMultilinha(c) {
    return String(c.v || "").replace(/\r/g, "").split("\n").map(function (l) { return l.replace(/\s+/g, " ").trim(); }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function lerConfig(aba) {
    var ev = {}, presentes = {};
    aba.linhas.forEach(function (r) {
      var key = CHAVES[norm(r[0] && r[0].v).replace(/[\s:_\-.]/g, "")];
      if (!key) return;
      presentes[key] = true;
      var c = r[1];
      if (!c || (!clean(c.v) && !c.l)) { ev[key] = null; return; }
      if (key === "data") {
        // aceita {ano} na data (ex.: "Sábado, 12 de dezembro de {ano}")
        var dc = c.n != null ? c : { v: clean(c.v).replace(/\{\s*ano\s*\}/gi, ev.ano || new Date().getFullYear()), n: null };
        ev.data = dataISO(dc);
        if (c.n == null && !/^\d/.test(clean(dc.v))) ev.dataExtenso = clean(dc.v);
      }
      else if (key === "inicio" || key === "horarioFim") ev[key] = horaTexto(c);
      else if (key === "ano") ev.ano = parseInt(clean(c.v), 10) || null;
      else if (key === "salas") { var ns = parseInt(clean(c.v), 10); ev.salas = ns === 1 || ns === 2 ? ns : null; }
      else if (key === "linkRemoto" || key === "playlist") ev[key] = urlSegura(c.l) || urlSegura(/^https?:/.test(clean(c.v)) ? clean(c.v) : null);
      else if (key === "remoto") {
        // "Assistir à distância": um link vira o botão da transmissão; um texto vira o aviso
        var u = urlSegura(c.l) || urlSegura(/^https?:\/\/\S+$/.test(clean(c.v)) ? clean(c.v) : null);
        if (u) ev.linkRemoto = u; else ev.textoRemoto = clean(c.v);
      }
      else if (key === "textoSobre" || key === "topicos" || key === "organizacao") ev[key] = textoMultilinha(c);
      else ev[key] = clean(c.v);
    });
    ev._presentes = presentes;
    return ev;
  }
  function extenso(iso) {
    var d = new Date(iso + "T12:00:00-03:00");
    var s = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "America/Sao_Paulo" });
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  function diaMes(iso) {
    return new Date(iso + "T12:00:00-03:00").toLocaleDateString("pt-BR", { day: "numeric", month: "long", timeZone: "America/Sao_Paulo" });
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

  /*
    Abas de configuração: uma por ano, "Configuracao_2026", "Configuracao_2027"...
    (também aceita "Configuracao" sem ano, usada para qualquer ano sem aba própria).
    - Página principal: usa a configuração do ano corrente; se não houver, a do ano mais recente.
    - Página de um ano (/2026/): usa a Configuracao_2026.
  */
  function ehConfig(a) { return /^(config|evento)/.test(norm(a.nome)); }
  function anoDaAba(a) { var m = /(\d{4})/.exec(a.nome); return m ? +m[1] : null; }
  function escolherConfig(abas, anoPagina) {
    var cfgs = abas.filter(ehConfig);
    var semAno = cfgs.filter(function (a) { return anoDaAba(a) == null; })[0] || null;
    var comAno = cfgs.filter(function (a) { return anoDaAba(a) != null; });
    if (anoPagina) return comAno.filter(function (a) { return anoDaAba(a) === anoPagina; })[0] || semAno;
    var corrente = new Date().getFullYear();
    var doAno = comAno.filter(function (a) { return anoDaAba(a) === corrente; })[0];
    if (doAno) return doAno;
    comAno.sort(function (x, y) { return anoDaAba(y) - anoDaAba(x); });
    return comAno[0] || semAno;
  }

  function montar(abas, cfg) {
    var avisos = [], anoPagina = cfg.anoPagina || null;
    var abaCfg = escolherConfig(abas, anoPagina);
    var ev = abaCfg ? lerConfig(abaCfg) : { _presentes: {} };
    // Ano da edição: o da página (/2026/), senão o da configuração, senão o do nome da aba, senão o ano corrente
    var anoEd = anoPagina || ev.ano || (abaCfg && anoDaAba(abaCfg)) || new Date().getFullYear();
    // Os textos padrão do site (data/simpa-2026.js) só valem para o ano deles
    var padrao = cfg.eventoPadrao || {};
    var atual = JSON.parse(JSON.stringify(padrao.ano === anoEd ? padrao : { local: padrao.local, endereco: padrao.endereco, formato: null, abertura: { titulo: "Início dos trabalhos" } }));
    if (!abaCfg) avisos.push("Não há aba “Configuracao_" + anoEd + "”. Usando os textos padrão do site.");
    var tem = ev._presentes;
    Object.keys(ev).forEach(function (k) { if (k !== "_presentes" && ev[k] != null) atual[k] = ev[k]; });
    // Se não existir aba do ano (ou ela estiver vazia), o site mostra que a programação ainda não foi publicada.
    atual.ano = anoEd;
    atual.abaConfig = abaCfg ? abaCfg.nome : null;
    atual.nome = ev.nome || "SIMPA " + atual.ano;
    if (ev.data && !ev.dataExtenso) atual.dataExtenso = extenso(ev.data);
    if (tem.data && !ev.data) avisos.push("Não entendi a data da configuração. Use, por exemplo, “Sábado, 12 de dezembro de 2026” ou 12/12/2026.");
    atual.abertura = atual.abertura || { titulo: "Início dos trabalhos" };
    if (ev.inicio) atual.abertura.horario = ev.inicio;
    if (ev.responsaveis) atual.abertura.autor = ev.responsaveis;
    // Campo "Programacao" presente e vazio = ainda não mostrar a programação
    atual.mostrarProgramacao = !(tem.tituloProgramacao && !ev.tituloProgramacao);
    // Campo de tópicos presente e vazio = esconder a lista
    if (tem.topicos && !ev.topicos) atual.topicos = null;

    var historico = [], abasLidas = [], edAtual = null;
    abas.forEach(function (a) {
      if (ehConfig(a)) { abasLidas.push({ nome: a.nome, tipo: a === abaCfg ? "Configuração em uso" : "Configuração de outro ano" }); return; }
      var m = /(\d{4})/.exec(a.nome);
      if (!m) { abasLidas.push({ nome: a.nome, tipo: "Ignorada (o nome não tem ano)" }); return; }
      var ano = +m[1], ed = lerEdicao(a, ano, avisos);
      if (!ed) { abasLidas.push({ nome: a.nome, tipo: "Com erro" }); return; }
      var n = ed.sessoes.reduce(function (s, x) { return s + x.trabalhos.filter(function (t) { return !t.vago; }).length; }, 0);
      if (ano === atual.ano) { edAtual = ed; abasLidas.push({ nome: a.nome, tipo: "Edição atual", trabalhos: n, sessoes: ed.sessoes.length }); }
      // Edições anteriores: só anos antes da edição exibida (a página de 2026 não mostra 2027)
      else if (ano < atual.ano) { if (n) historico.push(ed); abasLidas.push({ nome: a.nome, tipo: "Histórico", trabalhos: n, sessoes: ed.sessoes.length }); }
      else abasLidas.push({ nome: a.nome, tipo: "Edição futura (não exibida)", trabalhos: n });
    });

    atual.temAbaDoAno = !!edAtual;
    if (!edAtual) avisos.push("Não há aba “" + atual.ano + "”. A programação aparece como “ainda não publicada” até a aba ser criada.");
    // Completa com a aba do ano, sem sobrepor o que a configuração já define
    if (edAtual) {
      // Salas: 1 = só o primeiro bloco da aba (CA302); 2 = os dois blocos lado a lado.
      // Vazio = automático (quantos blocos houver na aba).
      var blocosNaAba = edAtual.sessoes.reduce(function (m, s) { return Math.max(m, (s.bloco || 0) + 1); }, 0);
      var salas = ev.salas || blocosNaAba || 1;
      if (ev.salas === 2 && blocosNaAba < 2) avisos.push("A configuração pede 2 salas, mas a aba “" + atual.ano + "” só tem um bloco Autor | Trabalho. Mostrando uma sala.");
      edAtual.sessoes = edAtual.sessoes.filter(function (s) { return (s.bloco || 0) < salas; }).map(function (s) {
        return Object.assign({}, s, { sala: salas > 1 && blocosNaAba > 1 ? (s.salaNome || "Sala " + ((s.bloco || 0) + 1)) : null });
      });
      atual.salas = Math.min(salas, Math.max(blocosNaAba, 1));
      // Com duas salas e o campo Sala vazio, "Como chegar" mostra as duas
      if (!ev.sala && atual.salas > 1) {
        var nomes = [];
        edAtual.sessoes.forEach(function (s) { if (s.salaNome && nomes.indexOf(s.salaNome) < 0) nomes.push(s.salaNome); });
        if (nomes.length > 1) edAtual.sala = nomes.join(" e ");
      }
      atual.sessoes = edAtual.sessoes;
      if (edAtual.abertura) atual.abertura = Object.assign({}, atual.abertura, edAtual.abertura, { horario: ev.inicio || edAtual.abertura.horario || atual.abertura.horario });
      if (!ev.sala && edAtual.sala) atual.sala = edAtual.sala;
      if (!ev.playlist && edAtual.playlist) atual.playlist = edAtual.playlist;
      if (edAtual.faixa) {
        if (!ev.periodo) atual.periodo = edAtual.faixa.inicio + " às " + edAtual.faixa.fim;
        if (!ev.horarioFim) atual.horarioFim = edAtual.faixa.fim;
        if (!ev.inicio && !(edAtual.abertura && edAtual.abertura.horario)) atual.abertura.horario = edAtual.faixa.inicio;
      }
    }
    atual.sessoes = atual.sessoes || [];
    if (!ev.destaqueProgramacao) atual.destaqueProgramacao = atual.data ? diaMes(atual.data) : "SIMPA " + atual.ano;
    if (!tem.tituloProgramacao) atual.tituloProgramacao = "Programação " + atual.ano;
    historico.sort(function (a, b) { return b.ano - a.ano; });

    // Etiquetas nos textos: {ano}, {data}, {dia}, {inicio}, {fim}, {local}, {primeiroAno}, {ultimoAno}
    var anos = historico.map(function (e) { return e.ano; });
    var tags = {
      ano: atual.ano, data: atual.dataExtenso || "", dia: atual.data ? diaMes(atual.data) : "",
      inicio: (atual.abertura && atual.abertura.horario || "").split("–")[0], fim: atual.horarioFim || "",
      local: atual.local || "",
      primeiroano: anos.length ? Math.min.apply(null, anos) : "", ultimoano: anos.length ? Math.max.apply(null, anos) : ""
    };
    Object.keys(atual).forEach(function (k) {
      if (typeof atual[k] === "string" && k !== "data") {
        atual[k] = atual[k].replace(/\{\s*([a-zA-ZçÇ]+)\s*\}/g, function (m, t) { var v = tags[norm(t)]; return v != null && v !== "" ? String(v) : m; });
      }
    });
    return { atual: atual, historico: historico, avisos: avisos, abas: abasLidas, lidoEm: new Date().toISOString() };
  }

  window.SIMPA_PLANILHA = { carregar: carregar, lerXlsx: lerXlsx, montar: montar };
})();
