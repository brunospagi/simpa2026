/*
  DADOS PADRÃO DO EVENTO (cópia de segurança).

  O site agora lê tudo da planilha do Google: a aba "Evento" substitui estes
  campos e a aba do ano (ex.: "2026") traz as sessões. Este arquivo só é usado
  quando a planilha não tem a aba "Evento", quando falta algum campo nela, ou
  quando a planilha não responde.

  Instruções antigas (edição manual, não é mais necessário):
  1. Para cada artigo aceito, suba o PDF (e depois os slides) no Google Drive
     com acesso "Qualquer pessoa com o link" e copie o link.
  2. Adicione um objeto em "trabalhos" da sessão correspondente, no formato:

     {
       horario: "8h20–8h32",
       autor: "Nome Completo",
       remoto: false,              // true se a apresentação for remota
       titulo: "Título do artigo",
       artigo: "https://drive.google.com/...",   // ou null
       slides: null,                              // preencha depois da apresentação
       video: null                                // link do YouTube depois do evento
     }

  3. Salve o arquivo e recarregue o site. Nada mais precisa ser alterado.
*/
window.SIMPA_2026 = {
  ano: 2026,
  nome: "SIMPA 2026",
  data: "2026-12-12",
  dataExtenso: "Sábado, 12 de dezembro de 2026",
  periodo: "Manhã e tarde",
  local: "UTFPR Câmpus Curitiba",
  // Usado na seção "Como chegar", no mapa e na agenda
  endereco: "Av. Sete de Setembro, 3165, Rebouças, Curitiba, PR, 80230-901",
  sala: null,                 // ex.: "Sala CA303, sede Centro" (deixe null enquanto não confirmar)
  horarioFim: "18h00",        // término previsto, usado no convite da agenda
  linkRemoto: null,           // link do Google Meet para quem assiste a distância
  formato: "Presencial, com participação remota para quem não está em Curitiba",
  // Preencha quando os professores definirem o prazo, ex.: "2026-11-30"
  prazoSubmissao: null,
  playlist: null,
  abertura: {
    horario: "8h10",
    titulo: "Início dos trabalhos",
    autor: "Profs. Alexandre Graeml e Jurandir Peinado",
    video: null
  },
  sessoes: [
    // Exemplo:
    // { nome: "Sessão 1", trabalhos: [ { ... }, { ... } ] },
  ]
};
