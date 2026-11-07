# ADR 0004: Orçamentos de busca e de contexto em tokens, não em contagem de resultados

- **Status:** Proposta
- **Data:** 07/11/2026
- **Relacionados:** `improvements.md` G1-06, G1-17; `vane-vs-perplexity.md` §2.4

## Contexto

O Vane decide quanto ler por contagem, em constantes espalhadas:
- 30 resultados por chamada de `web_search`, divididos entre as consultas (`baseSearch.ts:43,204-207`);
- no máximo 20 resultados depois da dedup (`baseSearch.ts:76`);
- 2 páginas lidas no balanced (`effort.ts:24`), 2 trechos de 200 tokens por página, até 40 trechos pontuados (`baseSearch.ts:84-89`);
- no quality, 3 páginas, até 100 mil caracteres por página, pedaços de 4.000 tokens (`baseSearch.ts:98-104,684-697`).

Só no fim, `fitWriterSources` compara o total com a janela do modelo e corta fontes inteiras, com mínimo de 300 tokens por fonte (`writerContext.ts:45-75`, `context/compact.ts:155-203`). A janela vem do env, do provedor ou do padrão de 32k (`context/budget.ts:6,38`). A estimativa usa cl100k × 1,2 (`budget.ts:13`). O redator e o pesquisador não têm teto de saída, apesar das reservas de `budget.ts:22-25`.

Consequências de hoje: um snippet de 2 linhas e um trecho de 2 páginas valem "1 resultado"; com 262k de janela (o caso medido), nada é cortado e o redator pode receber dezenas de milhares de tokens; com 32k, fontes inteiras somem no fim depois de terem sido buscadas, lidas e embutidas.

A Perplexity expressa isso em tokens no ponto da busca: `max_tokens_per_page`, `max_tokens` por chamada (no `low`, 4.000 no total e por página; `fetch_url` com 10.000) e `max_results` dividido entre as queries ([web-search], [effort], [search-qs]).

## Opções

### A. Manter contagens
- Prós: nada muda; o eval atual vale.
- Contras: o tamanho do contexto depende da página e do motor; o custo de leitura não tem teto previsível.

### B. Só ajustar as contagens por modo
- Prós: mudança mínima.
- Contras: continua sem relação com o tamanho real do texto.

### C. Orçamento em tokens no preset, aplicado na busca e na leitura
- Prós: contexto previsível por modo e independente da janela; a leitura de página para quando o orçamento da página acaba; o corte final de `fitWriterSources` vira rede de segurança; casa com o teto de saída (G1-06).
- Contras: mexe em ranking, chunking e contexto ao mesmo tempo; a contagem de tokens custa CPU (já existe `getTokenCount`); precisa de calibração por modo.

### D. Orçamento proporcional à janela do modelo
- Prós: usa mais contexto em modelos grandes.
- Contras: com 262k, o redator local recebe contexto demais e fica lento; a qualidade não cresce com o tamanho do contexto em modelos pequenos.

## Decisão proposta

**C**, com valores fixos por modo e um teto pela janela (o menor dos dois):
1. `EffortPreset` (`effort.ts:10-26`) ganha `maxTokensPerPage`, `maxTokensPerSearch` e `maxWriterSourceTokens`.
2. Os trechos de cada página entram em ordem de pontuação até `maxTokensPerPage`; os resultados entram até `maxTokensPerSearch`; a contagem `RESULTS_PER_SEARCH_CALL` continua só como teto de pedido ao motor.
3. `fitWriterSources` usa `min(maxWriterSourceTokens, orçamento da janela)`.
4. Valores iniciais a partir da medição (G1-01), não copiados da Perplexity; os 4.000 do `low` são só ponto de partida.
5. Uma mudança por vez: primeiro o redator (3), depois a página (2), depois a busca.

## Consequências

- **Positivas:** tamanho de contexto e tempo de prefill previsíveis; menos trabalho jogado fora no corte final; base para expor o preset na interface.
- **Negativas:** snapshots e o eval de referência mudam; um orçamento baixo demais tira evidência de perguntas de várias fontes.
- **A medir:** tokens de fonte por resposta, fontes descartadas por `fitWriterSources`, TTFT do redator, nota do eval por grupo de pergunta (fatos simples x várias fontes).
- **Gate:** eval da Fase 5 a cada passo (toca contexto, chunking e ranking).

[web-search]: https://docs.perplexity.ai/docs/agent-api/tools/web-search.md
[effort]: https://docs.perplexity.ai/docs/agent-api/effort.md
[search-qs]: https://docs.perplexity.ai/docs/search/quickstart.md
