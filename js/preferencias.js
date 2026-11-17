/* Aplica tema, alto contraste e tamanho do texto salvos, antes de desenhar a página.
   Fica num arquivo (e não embutido no HTML) para a política de segurança (CSP) poder
   proibir scripts embutidos. */
try {
  var p = JSON.parse(localStorage.getItem("simpa-a11y") || "{}"), d = document.documentElement;
  if (p.theme) d.dataset.theme = p.theme;
  if (p.contrast) d.dataset.contrast = "high";
  if (p.zoom) d.style.setProperty("--zoom", p.zoom);
} catch (e) { /* modo privado ou sem armazenamento */ }
