/*
  Configuração do site.

  O conteúdo vem da planilha do Google a cada visita. Para trocar de planilha,
  mude só o planilhaId (o trecho entre /d/ e /edit no endereço da planilha).
  A planilha precisa estar em "Compartilhar > Qualquer pessoa com o link > Leitor".
*/
window.SIMPA_CONFIG = {
  planilhaId: "1Hc1Y1oZVLDT2uDsLz4nbvKcnO3owSiS4Gln-QQtxlwo",
  // 0 = consulta a planilha em toda visita (a última leitura aparece na hora e é
  // atualizada quando a nova chega). Use 5, 10... para consultar menos vezes.
  cacheMinutos: 0,
  // Tempo máximo esperando o Google responder
  tempoLimite: 20000
};
