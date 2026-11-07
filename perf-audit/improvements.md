# Melhorias para o Vane inspiradas na Perplexity (Fase 3 da auditoria)

Data: 07/11/2026. Base: `master` em `30e2e72` (código de `78f19ff`). Entradas: `vane-vs-perplexity.md`, `perplexity-study.md`, `architecture.md`, `llm-inventory.md`, `upstream.md` e `auditoria-desempenho/benchmark-2026-11-07.md`. As referências `arquivo:linha` foram conferidas no código; os caminhos curtos seguem a convenção de `vane-vs-perplexity.md`.

## Como ler

- **Regras do usuário que valem para todo item.** Nada é otimizado sem medição de antes e depois. Mudança em prompt, modelo, fontes, contexto, chunking ou ranking passa pelo eval da Fase 5 (`perf-audit/eval`, regra de `eval-plan.md` §3). Mudanças pequenas e isoladas, fáceis de manter no fork. Perguntar antes de mudar modelo padrão, schema do banco, contrato de API, dependência principal, ou de acrescentar provedor pago, funcionalidade nova ou refatoração grande.
- **Campos.** Esforço: P (1 PR curto), M (alguns dias), G (semanas). "Eval" diz se o item toca prompt, modelo, fontes, contexto, chunking ou ranking. "Aprovação" aponta qual das regras acima o item aciona; "não" quer dizer que cabe na auditoria sem pergunta nova.
- **Grupo 1** alimenta o `findings.md` da Fase 11. **Grupo 2** é sempre opcional: o Vane continua rodando 100% local sem ele. **Grupo 3** é roadmap e não entra sem aprovação.

## Grupo 1: desempenho e qualidade (cabem nesta auditoria)

| ID | Item | Impacto principal | Esforço | Eval | Aprovação |
|---|---|---|---|---|---|
| G1-01 | Medir latência, tokens de raciocínio e custo por tarefa no eval | pré-requisito | M | não | não |
| G1-02 | Controlar o raciocínio nas chamadas estruturadas, por provedor | latência (a maior) | M | sim | sim (comportamento do modelo) |
| G1-03 | Tirar os vetores de embedding dos blocos, eventos e banco | memória, rede, disco | P | não | não |
| G1-04 | Falha do classificador, do seletor ou de ferramenta não derruba a resposta | robustez | P | não (só o caminho de falha) | não |
| G1-05 | Página ou ferramenta que falhou não vira fonte citável | qualidade, custo | P | sim | não |
| G1-06 | Teto de saída no pesquisador e no redator | latência, custo | P | sim | não |
| G1-07 | Prefixo estável no prompt do pesquisador (cache de prefixo) | latência | P | sim | não |
| G1-08 | Não ler nem embutir a mesma página duas vezes na pesquisa | latência | P | sim (leve) | não |
| G1-09 | Limitador global do extrator e abandono real no prazo | estabilidade, latência | P/M | não | não |
| G1-10 | Quality: ranquear pedaços antes do extrator | latência, custo | M | sim | não |
| G1-11 | Seletor do quality com entrada enxuta | custo, qualidade | P | sim | não |
| G1-12 | Redator recebe a pergunta reescrita | qualidade | P | sim | não |
| G1-13 | Stream: texto em delta, reconexão por snapshot, keepalive | rede, CPU, robustez | M | não | sim (contrato do stream) |
| G1-14 | Cancelamento com `AbortSignal` | custo, carga | M | não | sim (rota nova) |
| G1-15 | `$schema` e `json_schema` compatíveis com servidores estritos | robustez | P | sim (smoke) | não |
| G1-16 | Embeddings: prazo próprio, uploads no limitador, modelo registrado | robustez | P/M | não | não |
| G1-17 | Orçamentos em tokens em vez de contagem de resultados | qualidade, contexto | M | sim | não (ADR 0004) |
| G1-18 | Cache persistente de páginas por URL | latência | M/G | sim | sim (schema) |
| G1-19 | Paridade entre o redator da API e o da UI | qualidade, medição | P | sim | não |
| G1-20 | Avisar quando um filtro (`site:`) é descartado | qualidade | P | sim | não |
| G1-21 | Temperatura padrão coerente entre provedores | qualidade | P | sim | sim (parâmetro padrão) |

Ordem da tabela: valor esperado sobre esforço, com G1-01 primeiro porque nenhuma outra mudança pode ser julgada sem ele. Todo item do Grupo 1 **precisa de medição antes/depois**; a coluna "Medição" de cada item diz o quê.

### G1-01 Medir latência, tokens e custo por tarefa
- **Problema.** O `run.ts` grava tempo total e número de chamadas (`perf-audit/eval/run.ts:230`), mas não tokens de raciocínio, tempo até o 1º token nem custo. O benchmark mede tokens (`benchmark/analyze.ts:59,185`), mas só pelo caminho da API (`llm-inventory.md` §4.27). Com os vetores zerados do LM Studio, o ranking ficou sem sinal semanas sem ninguém notar (`benchmark-2026-11-07.md` §1).
- **Inspiração.** `search_evals`: hash da configuração na pasta da rodada, retomada por tarefa, "falhas contam zero / excluídas", custo de agente e de grader separados ([search-evals]); o Fast Search foi aceito com retriever pior porque a nota final não mudou e o custo caiu 68% ([photon]).
- **Como.** No `run.ts`, envolver o LLM com o `InstrumentedLLM` do benchmark (`benchmark/instrument.ts:98`) e gravar por tarefa: TTFT, tokens de entrada, saída e raciocínio, chamadas por etapa, bytes do stream. Pasta `runs/<rótulo>-<hash da config>`; `summary.json` com as duas médias de falha. No benchmark, um achado `bug` quando `simMax == simMin` em todas as consultas.
- **Arquivos.** `perf-audit/eval/run.ts`, `perf-audit/eval/lib/*`, `perf-audit/eval/compare.ts`, `src/lib/benchmark/analyze.ts`.
- **Impacto.** Torna os outros itens decidíveis. **Risco:** baixo (só `perf-audit` e um achado novo). **Pago:** não. **Medição:** é o próprio instrumento; rodar 3 referências para medir o ruído.

### G1-02 Controlar o raciocínio nas chamadas estruturadas
- **Problema.** Raciocínio = 86% dos tokens gerados; classificador com 43 s em média, 49 s para calcular 15% de 2.340 (`benchmark-2026-11-07.md` §2). Só o Ollama desliga (`ollamaLLM.ts:44-53,118`), por substring do nome; OpenAI, LM Studio, Gemini, Groq, Lemonade e Bifrost não recebem nada (`llm-inventory.md` §0). O teto de 8.192 do `generateObject` inclui o pensamento (`openaiLLM.ts:262-265`).
- **Inspiração.** `reasoning: none` no nível `fast` e `minimal` no `low`; extração com modelo pequeno ([effort]).
- **Como.** Campo opcional `reasoning?: 'off' | 'low' | 'default'` em `GenerateObjectInput` e `GenerateTextInput` (`models/types.ts:52-75`). Cada provedor traduz: Ollama `think: false` (lista vira configurável); OpenAI `reasoning_effort` só sem ferramentas (upstream #1173); LM Studio/llama.cpp `chat_template_kwargs.enable_thinking=false` ou `/no_think` no Qwen3; Gemini e Groq `reasoning_effort` (suporte exato a confirmar por provedor). Ligar por etapa: classificador, widgets, mídia, sugestões, seletor e extrator; redator e pesquisador ficam como estão. Padrão "default" até o eval aprovar. Detalhe no ADR 0002.
- **Arquivos.** `models/types.ts`, `openaiLLM.ts`, `ollamaLLM.ts`, `providers/*/index.ts`, `classifier.ts:45`, `widgets/*.ts`, `agents/media/*.ts`, `agents/suggestions/index.ts:21`, `baseSearch.ts:586,703`, `scrapeURL.ts:192`.
- **Impacto.** Latência: estimativa de dezenas de segundos por pergunta no setup do usuário (a medir). **Risco:** médio: JSON pior em modelos que dependem do pensamento; um parâmetro desconhecido pode dar 400 num servidor estrito (por isso por provedor e desligável). **Pago:** não. **Medição:** TTFT e tokens por etapa (G1-01) com e sem, no LM Studio. **Eval:** sim (modelo). **Aprovação:** sim, muda o comportamento do modelo.

### G1-03 Tirar os vetores de embedding dos blocos, eventos e banco
- **Problema.** `metadata.embedding` (`baseSearch.ts:290`) entra no sub-passo `search_results` e vai por `replace /data/subSteps` (`:361-385`). O `rfc6902` guarda uma cópia, e o `delete` de `:443` só limpa o objeto original. Os vetores ficam nos eventos da sessão por 30 min (`session.ts:17,47,62`), vão ao navegador, voltam inteiros em cada `/api/reconnect` e são gravados em `messages.responseBlocks` (`search/index.ts:248-253`). Ligado ao vazamento de memória do upstream #1199 (`upstream.md` nota A).
- **Inspiração.** O que vai para o cliente na Perplexity é `id`, `url`, `title`, `snippet`, `date` ([agent-qs]); o vetor fica no armazenamento ([cobbledb]).
- **Como.** Guardar os vetores num `Map` local do `executeSearch`, indexado pelo objeto do resultado, e publicar no bloco uma cópia só com `content`, `title`, `url`, `publishedDate`. A dedup por cosseno (`:409-437`) lê do `Map`. Opcional: migração que limpa `embedding` das linhas já gravadas (é dado, não schema; perguntar antes).
- **Arquivos.** `baseSearch.ts:255-450`; snapshots de `src/lib/agents/search/__tests__/__snapshots__` podem mudar.
- **Impacto.** Memória do servidor, bytes do stream e tamanho do banco. Com bge-m3 (1.024 dimensões) e ~30 resultados por chamada, cada sub-passo leva dezenas de milhares de números (a medir). **Risco:** baixo; o redator não lê o vetor. **Pago:** não. **Medição:** bytes de eventos por sessão, heap após N perguntas, tamanho de `responseBlocks`.

### G1-04 Falhas que não derrubam a resposta
- **Problema.** Uma falha do classificador (`classifier.ts:45`, chamado sem `try` em `search/index.ts:94`), do seletor do quality (`baseSearch.ts:586-600`), um nome de ferramenta inventado (`registry.ts:81-83` dentro do `Promise.all` de `:99`) ou um JSON de tool call malformado (`openaiLLM.ts:144,219,230`) encerram a busca inteira (`llm-inventory.md` §4.14-4.17). Os widgets e os extratores já engolem os seus erros.
- **Inspiração.** Failover antes do 1º token e erros determinísticos que não se repetem ([orch-routing]); fallback de modelo ([fallback]).
- **Como.** Classificador: em erro, `skipSearch: false`, sem widgets, `standaloneFollowUp` = pergunta original, `searchQueries: []`, e um aviso no log. Seletor: em erro, os 3 primeiros pela ordem do RRF. Ferramenta desconhecida e argumentos inválidos: resultado de ferramenta com o erro, para o modelo corrigir na iteração seguinte.
- **Arquivos.** `search/index.ts:94-99`, `classifier.ts`, `baseSearch.ts:586-600`, `researcher/actions/registry.ts:81-99`, `openaiLLM.ts:144,219-230`.
- **Impacto.** Menos respostas perdidas com modelos locais pequenos. **Risco:** baixo; o caminho normal não muda. **Pago:** não. **Medição:** taxa de respostas com `status: 'error'` no eval e no benchmark. **Eval:** o caminho normal não muda; o de falha se testa com `FakeLLM` que lança (`src/__tests__/helpers/fakes.ts`).

### G1-05 Página ou ferramenta que falhou não vira fonte
- **Problema.** `Scraper.scrape` devolve o título `'Failed to scrape'` em vez de lançar (`scraper.ts:74`). O quality testa `if (!scrapedData)` (`baseSearch.ts:690`), que nunca dispara, e gasta extratores sobre a página de erro; uma página com todos os pedaços falhando entra com `content: ''` (`:725-728`). `scrape_url` (`scrapeURL.ts:230-237`) e MCP (`mcp.ts:111-115`) devolvem o texto de erro como fonte citável. O balanced já trata (`baseSearch.ts:842`).
- **Inspiração.** "Tratar `id` e `url` do resultado como fonte da verdade" e citar só o que foi lido ([web-search]).
- **Como.** Um predicado `isFailedScrape` exportado do `scraper.ts`, usado no quality e no `scrape_url`. O erro vai ao pesquisador como nota no resultado da ferramenta, nunca como `Chunk` de fonte. Página sem fatos extraídos sai da lista.
- **Arquivos.** `scraper.ts`, `baseSearch.ts:684-730`, `scrapeURL.ts:180-240`, `mcp.ts:104-130`.
- **Impacto.** Menos fontes falsas e menos chamadas de extrator inúteis. **Risco:** baixo. **Pago:** não. **Medição:** fontes com conteúdo de erro por resposta; chamadas de extrator. **Eval:** sim (fontes).

### G1-06 Teto de saída no pesquisador e no redator
- **Problema.** `streamText` não manda limite (`openaiLLM.ts:181`, `ollamaLLM.ts` sem `num_predict`), embora o orçamento reserve 4.000 para o pesquisador e 3.000/4.000/6.000 para o redator (`context/budget.ts:22-25`). Um modelo local em laço gera até encher o contexto (`llm-inventory.md` §4.4).
- **Inspiração.** `max_output_tokens` por nível ([effort]).
- **Como.** Passar `options.maxTokens` = `RESERVED_OUTPUT_TOKENS` da etapa (`researcher/index.ts:275-284`, `search/index.ts:191-199`, `api.ts:130-138`), enviado em `max_tokens` para LM Studio e Ollama compatível (`openaiLLM.ts:262-265`) e `num_predict` no Ollama. Com raciocínio ligado, o pensamento conta no limite: fazer depois de G1-02 ou somar uma folga. Marcar `finish_reason: length` no log.
- **Arquivos.** `openaiLLM.ts`, `ollamaLLM.ts`, `researcher/index.ts`, `search/index.ts`, `api.ts`.
- **Impacto.** Corta o pior caso de latência e custo. **Risco:** médio: relatório do quality cortado no meio. **Pago:** não. **Medição:** distribuição de tokens de saída por modo antes de escolher os números. **Eval:** sim (checagem de tamanho do quality).

### G1-07 Prefixo estável no prompt do pesquisador
- **Problema.** "You are currently on iteration i of N" fica no começo do prompt de sistema (`prompts/search/researcher.ts:22,108,210`). O prefixo muda a cada iteração, então o servidor local (cache de prefixo do llama.cpp, LM Studio, Ollama) refaz o prefill de todo o histórico e dos resultados de ferramenta a cada volta. No quality são até 25 voltas com contexto crescente.
- **Inspiração.** `prompt_cache_key` estável por nível e afinidade de implantação para reaproveitar o cache ([effort], [orch-routing]).
- **Como.** Mover a linha da iteração (e qualquer coisa variável) para o fim, numa mensagem curta depois do histórico; data só com o dia (já é assim no pesquisador).
- **Arquivos.** `prompts/search/researcher.ts`, `researcher/index.ts:275-284`.
- **Impacto.** Prefill menor por iteração no balanced e no quality (a medir; o ganho depende do servidor). **Risco:** baixo. **Pago:** não. **Medição:** `prompt_eval_duration` do Ollama e tempo até o 1º token por iteração no LM Studio. **Eval:** sim (prompt).

### G1-08 Não ler nem embutir a mesma página duas vezes
- **Problema.** No balanced, a mesma página (63 KB) foi raspada nas iterações 1 e 2 e teve 41 trechos embutidos duas vezes; a fusão por URL concatena os trechos repetidos (`benchmark-2026-11-07.md` §6). O quality só pula URLs já extraídas (`baseSearch.ts:605-617`).
- **Inspiração.** Trechos e vetores guardados por URL ([cobbledb]).
- **Como.** Um `Map<urlNormalizada, Promise<páginaLida>>` criado por pesquisa no `Researcher` e passado às ações; `readTopPages` e o quality consultam antes de raspar. Deduplicar trechos iguais ao juntar resultados. É o passo 1 do ADR 0003, sem banco.
- **Arquivos.** `researcher/index.ts`, `researcher/types.ts`, `baseSearch.ts:605-617,816-854`, `scrapeURL.ts`.
- **Impacto.** Segundos por pergunta no balanced e no quality. **Risco:** baixo. **Pago:** não. **Medição:** scrapes e embeddings por pergunta. **Eval:** sim, leve (o contexto perde trechos duplicados).

### G1-09 Limitador global do extrator e abandono real no prazo
- **Problema.** O limitador do extrator é criado por chamada (`baseSearch.ts:679`, `scrapeURL.ts:109`): várias buscas paralelas somam 3×N extratores no servidor local. O prazo do limitador de embedding libera a vaga sem cancelar o pedido (`utils/limit.ts:47-51`), e o `withTimeout` de 8 s da leitura deixa o scrape e o embedding rodando (`baseSearch.ts:746-759`).
- **Inspiração.** Hedging e prazos por tentativa ([cobbledb], [orch-routing]).
- **Como.** Limitador do extrator no escopo do módulo, como o de embedding (`baseSearch.ts:67`). `createLimiter` passa um `AbortSignal` à tarefa e aborta no prazo; o scraper e o SDK de embedding recebem o sinal (o `fetch` e o SDK `openai` aceitam `signal`). Depende do campo `signal` de G1-14.
- **Arquivos.** `utils/limit.ts`, `baseSearch.ts`, `scrapeURL.ts`, `scraper.ts`, `openaiEmbedding.ts`.
- **Impacto.** Fila menor no LM Studio/Ollama; menos 502 (upstream #1147). **Risco:** baixo. **Pago:** não. **Medição:** pedidos simultâneos vistos pelo servidor; p95 do extrator. **Eval:** não (mesmo resultado, menos espera).

### G1-10 Quality: ranquear pedaços antes do extrator
- **Problema.** O quality passa cada pedaço de 4.000 tokens de até 3 páginas (até 100 mil caracteres) por um LLM extrator: ~30 chamadas numa pergunta típica, ~577 no máximo teórico (`llm-inventory.md` §2). O balanced já ranqueia trechos sem LLM (`bestPassages`, `baseSearch.ts:767-808`).
- **Inspiração.** Ranking em cascata no nível de trecho, antes do modelo ([search-arch]).
- **Como.** Pontuar os pedaços de cada página com o mesmo RRF de embedding + léxico do `bestPassages` e mandar ao extrator só os K melhores (ex.: 2 por página), na ordem da página.
- **Arquivos.** `baseSearch.ts:679-730`, `ranking.ts`.
- **Impacto.** Menos chamadas de extrator (estimativa: de ~30 para ~6; a medir). **Risco:** médio: perder um fato que estava num pedaço mal pontuado. **Pago:** não. **Medição:** chamadas e tempo do quality. **Eval:** sim (chunking e ranking).

### G1-11 Seletor do quality com entrada enxuta
- **Problema.** O seletor recebe `JSON.stringify(result)` com `similarity: 1`, `embedding: []` e metadados internos (`baseSearch.ts:595`); o quality não ranqueia nada antes (`:486-499`).
- **Inspiração.** Escolha final sobre resultados já ranqueados ([search-arch]).
- **Como.** Mandar só `index`, `title`, `source`, `date` e o snippet cortado; ordenar antes com o RRF léxico (sem embedding, para não mudar o custo do quality).
- **Arquivos.** `baseSearch.ts:554-600`. **Impacto:** tokens por chamada do seletor; escolha melhor (a medir). **Risco:** baixo. **Pago:** não. **Medição:** tokens de entrada do seletor. **Eval:** sim (prompt e ranking).

### G1-12 Redator recebe a pergunta reescrita
- **Problema.** O pesquisador e as ações recebem a pergunta reescrita; o redator recebe só o histórico e o `followUp` cru (`search/index.ts:150-156`). Em "e quanto custa?", o redator pode errar o referente.
- **Inspiração.** Contexto da conversa mantido de ponta a ponta ([agent-qs], `previous_response_id`).
- **Como.** Acrescentar à última mensagem do usuário uma linha "Standalone question: …" quando a reescrita for diferente, como o pesquisador já faz (`researcher/index.ts:164-174`).
- **Arquivos.** `search/index.ts:150-156`, `api.ts`. **Impacto:** qualidade em seguimentos. **Risco:** baixo. **Pago:** não. **Medição:** o eval tem só 2 perguntas de conversa; acrescentar 4 a 6 seguimentos antes. **Eval:** sim (contexto).

### G1-13 Stream: texto em delta, reconexão por snapshot, keepalive
- **Problema.** Cada pedaço do redator manda o texto acumulado inteiro (`search/index.ts:221-229`): bytes e trabalho do cliente crescem com o quadrado. `/api/reconnect` repete todos os eventos (`session.ts:80-95`), o que duplica texto (upstream #1038) e reenvia os vetores (G1-03). Sem bytes durante gerações longas, proxies cortam a conexão (upstream #1051).
- **Inspiração.** `output_text.delta`, `sequence_number` e reconexão por `starting_after` ([sdk-py], [background]).
- **Como.** (a) Evento `textDelta` com `blockId` e o pedaço, ou agrupar pedaços a cada ~50 ms; o patch `replace` só no fim. (b) Reconexão manda um snapshot (`getAllBlocks`) e depois os eventos novos. (c) `{"type":"ping"}` a cada 15 s.
- **Arquivos.** `search/index.ts:201-245`, `session.ts`, `api/chat/route.ts`, `api/reconnect/[id]/route.ts`, `hooks/useChat.tsx:375-470`, `hooks/reconnectStream.ts`.
- **Impacto.** Rede e CPU do navegador em respostas longas; reconexão sem texto duplicado. **Risco:** médio (cliente e servidor mudam juntos). **Pago:** não. **Medição:** bytes por resposta, tempo de render no cliente. **Eval:** não. **Aprovação:** sim, muda o contrato do stream de `/api/chat` (`/api/search` fica igual).

### G1-14 Cancelamento com `AbortSignal`
- **Problema.** Fechar a aba só tira o ouvinte (`chat/route.ts:235-240`); não há `signal` nos tipos (`models/types.ts:52-75`) nem em `src/lib/agents`. Pesquisador, extratores e redator seguem até o fim, também em `/api/search` e no benchmark (`llm-inventory.md` §4.13).
- **Inspiração.** `POST /v1/agent/{id}/cancel` e estados explícitos ([background]).
- **Como.** `signal` opcional nos inputs de LLM e embedding, repassado ao SDK; `AbortController` por sessão; botão "parar" e `POST /api/chat/[id]/cancel`; em `/api/chat`, abortar só se ninguém reconectar num prazo (ex.: 60 s), para manter a reconexão; em `/api/search` e no benchmark, abortar no `req.signal`.
- **Arquivos.** `models/types.ts`, `openaiLLM.ts`, `ollamaLLM.ts`, `session.ts`, `search/index.ts`, `researcher/index.ts`, rotas `chat`, `search`, `benchmark`, UI.
- **Impacto.** Custo com provedor pago e carga do servidor local. **Risco:** médio. **Pago:** não. **Medição:** chamadas que continuam após desconexão. **Eval:** não. **Aprovação:** sim (rota nova).

### G1-15 `$schema` e `json_schema` em servidores estritos
- **Problema.** `zodResponseFormat` gera `"$schema"` e `openaiLLM.ts:272` envia sem limpar; servidores estritos recusam (upstream #1233). A Groq só aceita `json_schema` em alguns modelos (upstream #980, #1061). O classificador falhando derruba tudo (G1-04).
- **Inspiração.** JSON Schema simples e citado no prompt ([output-control]).
- **Como.** Remover `$schema` antes do envio; numa resposta 400 por `response_format`, repetir uma vez com `json_object` e o schema no prompt.
- **Arquivos.** `openaiLLM.ts:245-290`, `providers/groq`. **Impacto:** compatibilidade. **Risco:** baixo. **Pago:** não. **Medição:** taxa de 400 por provedor no benchmark. **Eval:** smoke no LM Studio (o pedido muda).

### G1-16 Embeddings: prazo, limitador e modelo registrado
- **Problema.** Embedding OpenAI-compatível sem prazo próprio (600 s × 3 do SDK, `openaiEmbedding.ts:25-29`); Ollama sem `fetchWithHeadersTimeout` (`ollamaEmbedding.ts:17-19`); uploads fora do limitador e num pedido só (`uploads/manager.ts:115-116,146-147,172-173`); o modelo de embedding do upload não é registrado, e trocá-lo faz `computeSimilarity` lançar e derrubar a busca (`computeSimilarity.ts:2-3`, `llm-inventory.md` §4.8-4.11, §4.21-4.22).
- **Inspiração.** Limites por pedido (512 textos, 120.000 tokens) e prazos ([emb-qs], [sdk-py]).
- **Como.** `timeout: llmTimeoutMs()` no construtor; uploads no `withEmbeddingSlot` em lotes; gravar `{provider, model, dims}` no `*.content.json` e, na consulta, pular com aviso os uploads de outro modelo.
- **Arquivos.** `openaiEmbedding.ts`, `ollamaEmbedding.ts`, `uploads/manager.ts`, `uploads/store.ts`. **Impacto:** robustez dos uploads. **Risco:** baixo. **Pago:** não. **Medição:** upload de PDF grande; troca de modelo. **Eval:** não (o ranking não muda).

### G1-17 Orçamentos em tokens em vez de contagem de resultados
- **Problema.** O Vane limita por contagem (30 resultados por chamada, 20 finais, 2 trechos de 200 tokens, 3 páginas, 100 mil caracteres; `baseSearch.ts:43-104`) e só depois corta fontes inteiras para caber na janela (`writerContext.ts:45-75`). Busca, leitura e embedding já foram pagos quando o corte acontece.
- **Inspiração.** `max_tokens_per_page` e `max_tokens` por chamada, `max_results` dividido entre queries ([search-qs], [web-search]).
- **Como.** Campos `maxTokensPerPage` e `maxTokensPerSearch` no `EffortPreset` (`effort.ts:10-26`); o número de trechos por página sai do orçamento; o redator recebe trechos dentro do total. Ver ADR 0004.
- **Arquivos.** `effort.ts`, `baseSearch.ts`, `writerContext.ts`, `context/compact.ts`. **Impacto:** contexto previsível; menos fontes cortadas no fim. **Risco:** médio. **Pago:** não. **Medição:** tokens de fonte por resposta e fontes descartadas por `fitWriterSources`. **Eval:** sim (contexto, chunking).

### G1-18 Cache persistente de páginas por URL
- **Problema.** Toda pergunta raspa, corta e embute de novo; seguimentos sobre o mesmo tema pagam tudo outra vez.
- **Inspiração.** CobbleDB guarda por URL os trechos e o vetor de cada trecho ([cobbledb]); cache em camadas com validação por ETag no `cachew` ([cachew]).
- **Como.** Tabela SQLite `page_cache` (URL normalizada, texto, trechos, vetores por modelo de embedding, `etag`, `last_modified`, `fetched_at`), TTL curto (ex.: 24 h) e validação condicional. Passo 2 do ADR 0003; o passo 1 é G1-08.
- **Arquivos.** `drizzle/` (migração nova), `db/schema.ts`, `scraper.ts`, `baseSearch.ts`. **Impacto:** latência em perguntas repetidas e seguimentos. **Risco:** médio: conteúdo velho em notícias. **Pago:** não. **Medição:** taxa de acerto e latência do balanced. **Eval:** sim. **Aprovação:** sim (schema do banco).

### G1-19 Paridade entre o redator da API e o da UI
- **Problema.** `api.ts` não chama `sanitizeCitations` e usa contexto `''` sem busca (`api.ts:95,141-146`), enquanto a UI limpa e usa um marcador (`search/index.ts:158-159,233-244`). O benchmark mede a API; seletor e extratores herdam o rótulo `researcher` (`llm-inventory.md` §4.26-4.27).
- **Inspiração.** Uma só saída tipada para o produto e a API ([agent-qs]).
- **Como.** Função comum para montar contexto, chamar o redator e limpar; `withTraceLabel` próprio no seletor e no extrator.
- **Arquivos.** `agents/search/api.ts`, `search/index.ts`, `baseSearch.ts`. **Impacto:** o que se mede é o que o usuário recebe. **Risco:** baixo. **Pago:** não. **Medição:** comparar saídas da API e da UI no mesmo caso. **Eval:** sim (a saída da API muda).

### G1-20 Avisar quando um filtro é descartado
- **Problema.** Com menos de 3 resultados, a busca filtrada é refeita sem filtro (`baseSearch.ts:181-196`), inclusive o `site:` digitado pelo usuário no caminho rápido (`researcher/index.ts:198`), sem aviso (`architecture.md` §11.4).
- **Inspiração.** Filtro de domínio como restrição explícita de permitir ou bloquear ([domain-filter]).
- **Como.** Para `site:` do usuário, só alargar com 0 resultados; quando alargar, anotar no resultado da ferramenta e no sub-passo ("busca ampliada para além de X").
- **Arquivos.** `baseSearch.ts:157-197`, `researcher/index.ts:198`, i18n. **Impacto:** respeito ao pedido do usuário. **Risco:** baixo. **Pago:** não. **Medição:** checagem `site:` do eval. **Eval:** sim (fontes).

### G1-21 Temperatura padrão coerente
- **Problema.** Texto e chamadas de ferramenta usam 1,0 nos provedores OpenAI-compatíveis e 0,7 no Ollama (`openaiLLM.ts:116,179`, `ollamaLLM.ts:123,180`): o mesmo modelo se comporta diferente no LM Studio e no Ollama.
- **Inspiração.** Configuração por nível, com o mesmo resultado em qualquer cliente ([effort]).
- **Como.** Uma constante por etapa (ex.: pesquisador 0,3, redator 0,7) usada pelas duas classes, sobrescrevível por env.
- **Arquivos.** `openaiLLM.ts`, `ollamaLLM.ts`, `models/utils/objectDefaults.ts`. **Impacto:** tool calls mais estáveis (a medir). **Risco:** médio. **Pago:** não. **Medição:** tool calls inválidas por pergunta. **Eval:** sim (modelo). **Aprovação:** sim (parâmetro padrão).

## Grupo 2: integrações opcionais com as APIs da Perplexity

Todas são **"adicionar provedor/serviço pago"**: precisam de aprovação, de chave (`PERPLEXITY_API_KEY`, lida só do ambiente, como a do Firecrawl em `lib/firecrawl.ts`) e nunca podem virar requisito. Sem a chave, nada muda. Em todas, a pergunta ou o texto sai da máquina, o que deve aparecer na tela de configuração. Arquitetura comum no ADR 0001.

### G2-01 Search API como alternativa ao SearXNG
- **Lacuna.** Busca sem índice próprio; leitura de página na hora; mídia e Discover sempre no SearXNG.
- **Inspiração.** `POST /search` com até 5 queries, `max_results` até 20, `max_tokens_per_page`, filtros de domínio, idioma, país, recência e datas, `search_type: fast` ([search-qs], [date-filters]).
- **Como.** Terceira opção em `search.provider` (`config/index.ts:136-153`, `serverRegistry.ts:19-22`) e `src/lib/perplexitySearch.ts` no molde do `firecrawlSearch.ts`, chamado por `runProvider` (`lib/webSearch.ts:58-61`). Mapear `recency`, `domains` e `language` (`filters.ts`); com `max_tokens_per_page`, o snippet já é texto da página, e o balanced pode pular `readTopPages`. Serve também de linha de base no eval: mesma pergunta com SearXNG e com a Search API separa "qualidade da busca" de "qualidade do redator".
- **Arquivos.** `config/index.ts`, `serverRegistry.ts`, `lib/webSearch.ts`, novo `perplexitySearch.ts` + teste, `i18n/configText.ts`, `messages/*.json`.
- **Impacto.** Qualidade e latência da busca (p50 publicado de 160 ms no fast). **Esforço:** P/M. **Risco:** baixo (opção nova). **Custo:** US$ 5 por mil pedidos, US$ 1 no fast ([pricing]). **Eval:** sim.

### G2-02 Embeddings API como provedor de embedding
- **Lacuna.** Embeddings locais variam em qualidade e já quebraram em silêncio (vetores zerados).
- **Inspiração.** `pplx-embed-v1` (1.024 ou 2.560 dims, Matryoshka, 32K de contexto) e os contextualizados, que embutem os trechos de um documento juntos ([emb-qs], [ctx-emb]).
- **Como.** Provedor só de embedding (como o Transformers) em `models/providers/perplexity`, com uma classe `BaseEmbedding` que decodifica `base64_int8` (não dá para reaproveitar `OpenAIEmbedding`, que força `float`, `openaiEmbedding.ts:18`; a compatibilidade do endpoint não foi verificada). Lotes de até 512 textos. O contextualizado serve aos uploads via `embedChunks` (`models/base/embedding.ts:6`). Depende de G1-16 (registro do modelo por upload).
- **Arquivos.** `models/providers/index.ts`, nova pasta do provedor, `uploads/manager.ts`. **Impacto:** ranking e uploads. **Esforço:** M. **Risco:** baixo. **Custo:** US$ 0,004 a 0,05 por 1M tokens. **Eval:** sim. **Privacidade:** o texto dos uploads sai da máquina.

### G2-03 Agent API como provedor de LLM (ou como modo delegado)
- **Lacuna.** Quem quer resposta de nível Perplexity sem GPU não tem caminho.
- **Inspiração.** `POST /v1/agent` com `effort`, `models` com fallback, `response_format`, `stream`, compatível com `/v1/responses` ([agent-qs], [effort], [fallback]).
- **Como.** Duas formas. (a) **Provedor de LLM**: uma classe nova sobre a API Responses (o `OpenAILLM` usa Chat Completions), sem `web_search`, só com as ferramentas do Vane; schemas fixos pagam o preparo de 10 a 30 s só na primeira vez ([output-control]). (b) **Modo delegado**: o pesquisador e o redator viram uma chamada ao Agent API com `effort`, e os eventos `search_results` e `output_text.delta` viram blocos `source` e `text`. (b) é funcionalidade nova (Grupo 3). O Orchestrator, se o usuário tiver acesso à prévia, fala Chat Completions e entraria como provedor OpenAI-compatível sem código ([orch-qs]); não verificado.
- **Arquivos.** (a) nova pasta em `models/providers`; (b) `search/index.ts` e um agente novo. **Impacto:** qualidade sem hardware. **Esforço:** M (a), G (b). **Risco:** médio. **Custo:** tokens do modelo + US$ 1 a 2,50 por mil buscas. **Eval:** sim.

### G2-04 Decisions API para checar citações
- **Lacuna.** Ninguém confere se a fonte `n` sustenta a frase com `[n]`.
- **Inspiração.** Juiz de citação do cookbook, até 128 perguntas sim/não por chamada sobre um `state` ([decisions], [llms]).
- **Como.** Só no quality e atrás de uma opção: depois do redator, pares (frase, trecho citado) viram perguntas "o trecho sustenta a frase?"; abaixo de um limiar com folga (a API não promete calibração), a citação é marcada na UI, não apagada. A alternativa local é G3-02.
- **Arquivos.** `search/index.ts` (depois de `sanitizeCitations`), `utils/citations.ts`, UI da citação. **Impacto:** confiança nas citações. **Esforço:** M. **Risco:** baixo (pós-processamento). **Custo:** US$ 0,01 a 0,02 por 1M tokens de entrada. **Eval:** sim (checagem de citação).

## Grupo 3: funcionalidades novas para o roadmap (só com aprovação)

| ID | Funcionalidade | Inspiração | Como (resumo) | Esforço | Aciona |
|---|---|---|---|---|---|
| G3-01 | Pesquisa profunda em segundo plano, retomável | `background`, `starting_after`, `cancel`, `ultra` ([background], [effort]) | Jobs no SQLite com eventos numerados; o quality/pesquisa profunda roda fora da requisição; plano de sub-perguntas; ver ADR 0005 | G | schema, API, funcionalidade |
| G3-02 | Verificação local de citações | Juiz de citação ([llms]) | Cosseno frase × trecho com o embedding já carregado; LLM pequeno só nos casos duvidosos; só no quality | M | funcionalidade |
| G3-03 | Modelo opcional por etapa ("modelo rápido") | Extração com modelo pequeno, modelo por nível ([effort]) | Campo opcional nas configurações para classificador, widgets, mídia, sugestões, seletor e extrator; vazio = modelo atual | M | modelo padrão (não muda), UI nova |
| G3-04 | Vane como servidor MCP e endpoint compatível com Responses | `modelcontextprotocol` (MIT) e `/v1/responses` ([mcp-repo]) | Ferramentas `vane_search` e `vane_answer` sobre o `APISearchAgent`; nomes de evento iguais aos da Perplexity | M | contrato de API |
| G3-05 | Imagens na resposta | Classificador de mídia e `image_search` ([changelog]) | Campo `showImages` no classificador; galeria junto da resposta; mídia pelo provedor configurado | M | prompt, UI |
| G3-06 | Perguntas relacionadas persistidas | Relacionadas no fim da resposta ([help-pro]) | O servidor gera em paralelo ao fim e emite o bloco `suggestion`, que já existe no tipo, gravado com a mensagem | P/M | funcionalidade |
| G3-07 | Uploads com contexto e mais formatos | Embeddings contextualizados, PDF/DOC/RTF ([ctx-emb], [changelog]) | Prefixar título e seção no pedaço; RTF e DOC; imagens só com modelo de visão | M | chunking (eval) |
| G3-08 | Finanças como ferramenta | `finance_search` ([tools-overview]) | Ação do pesquisador sobre o `yahoo-finance2` do widget, com citação | P/M | funcionalidade |
| G3-09 | Aprovação de ferramentas MCP com escrita | `require_approval` ([tools-overview]) | Cartão de aprovação na UI para ferramentas sem `readOnlyHint` | M | funcionalidade, segurança |
| G3-10 | Filtros de país e de intervalo de datas | `country`, `search_after/before_date_filter` ([date-filters]) | Campos novos em `filters.ts`, aplicados após a busca quando o motor não suporta | P | fontes (eval) |
| G3-11 | Espaços (Projects) | Projects com instruções, arquivos e fontes ([projects]) | Tabela `spaces`; instruções e uploads por espaço | G | schema |
| G3-12 | Automações | Automations ([pplx-changelog]) | Reexecutar uma pergunta numa agenda e guardar o resultado; depende de G3-01 | M | schema |

## Ordem sugerida

1. **G1-01** (medir) e as três referências do eval.
2. Correções sem efeito no texto: **G1-03, G1-04, G1-09, G1-16**.
3. Maior ganho de latência: **G1-02** (com aprovação) e **G1-07**, depois **G1-06**.
4. Fontes e contexto, cada um no eval: **G1-05, G1-08, G1-11, G1-12, G1-20, G1-10**, depois **G1-17** (ADR 0004).
5. Contrato e cancelamento, com aprovação: **G1-13, G1-14**; depois **G1-18** (ADR 0003).
6. Grupo 2 só se o usuário quiser provedores pagos, começando por **G2-01** (também útil como linha de base do eval).
7. Grupo 3: **G3-03** e **G3-01** são os de maior valor; **G3-06** é o mais barato.

## O que não vale copiar

- **Índice, crawler e Photon próprios.** Pressupõem frota e 200 bi de URLs; no Vane, a alavanca equivalente é cache (G1-08, G1-18), orçamento (G1-17) e ranking local.
- **ROSE, prefill/decode desagregados, decodificação especulativa.** São do servidor de inferência; o usuário escolhe LM Studio, Ollama ou llama.cpp.
- **`ultra` com três agentes em paralelo.** Num servidor local, três agentes disputam a mesma GPU; o tempo total cresce.
- **Comet, Computer, Teammates, sandbox de código.** Fora do escopo de um motor de respostas e caros em segurança para um app sem login.
- **Fallback de modelo e retentativas por conta própria em cima do Bifrost.** O SDK já repete 2 vezes; somar camadas multiplica o custo de um 5xx. Conferir o Bifrost antes.
- **Presets versionados com modelo fixo por nível.** O usuário escolhe o modelo; versionar só faz sentido para os parâmetros, junto da referência do eval.
- **Fast Search sem eval.** A Perplexity aceitou um retriever pior porque mediu a nota final; sem G1-01, o Vane não tem como fazer essa troca.

## Fontes

Todas lidas na Fase 2; o grau de confiança de cada uma está em `perplexity-study.md`.

[effort]: https://docs.perplexity.ai/docs/agent-api/effort.md
[search-evals]: https://github.com/perplexityai/search_evals
[photon]: https://www.perplexity.ai/hub/blog/photon
[agent-qs]: https://docs.perplexity.ai/docs/agent-api/quickstart.md
[cobbledb]: https://www.perplexity.ai/hub/blog/cobbledb
[orch-routing]: https://docs.perplexity.ai/docs/router/routing-and-reliability.md
[fallback]: https://docs.perplexity.ai/docs/agent-api/model-fallback.md
[web-search]: https://docs.perplexity.ai/docs/agent-api/tools/web-search.md
[search-arch]: https://www.perplexity.ai/hub/blog/architecting-and-evaluating-an-ai-first-search-api
[sdk-py]: https://github.com/perplexityai/perplexity-py
[background]: https://docs.perplexity.ai/docs/agent-api/background-mode.md
[output-control]: https://docs.perplexity.ai/docs/agent-api/output-control.md
[emb-qs]: https://docs.perplexity.ai/docs/embeddings/quickstart.md
[search-qs]: https://docs.perplexity.ai/docs/search/quickstart.md
[cachew]: https://github.com/perplexityai/cachew
[domain-filter]: https://docs.perplexity.ai/docs/search/filters/domain-filter.md
[date-filters]: https://docs.perplexity.ai/docs/search/filters/date-time-filters.md
[pricing]: https://docs.perplexity.ai/docs/getting-started/pricing.md
[ctx-emb]: https://www.perplexity.ai/hub/blog/contextual-embedding-beyond-the-gold-passage
[orch-qs]: https://docs.perplexity.ai/docs/router/quickstart.md
[decisions]: https://docs.perplexity.ai/docs/decisions/quickstart.md
[llms]: https://docs.perplexity.ai/llms.txt
[mcp-repo]: https://github.com/perplexityai/modelcontextprotocol
[changelog]: https://docs.perplexity.ai/docs/resources/changelog.md
[help-pro]: https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search
[tools-overview]: https://docs.perplexity.ai/docs/agent-api/tools/overview.md
[projects]: https://www.perplexity.ai/hub/blog/spaces-are-now-projects
[pplx-changelog]: https://www.perplexity.ai/changelog
