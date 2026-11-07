# Roteiro de leitura do código do Vane

Base: `master` em `78f19ff` (a versão anterior deste roteiro era de `3b3799c`; desde então entraram 103 commits). Ordem pensada para quem vai mexer na busca. Cada parada traz `arquivo:linha`, o que olhar e por quê; todas as referências foram conferidas no código atual. O contexto, os diagramas e o histórico das mudanças estão em [`architecture.md`](architecture.md); cada chamada a LLM e a embedding está em [`llm-inventory.md`](llm-inventory.md). Nada aqui foi executado; é leitura de código. Caminhos curtos: `researcher/...` fica em `src/lib/agents/search/researcher/`, e `baseSearch.ts`, `ranking.ts` e `filters.ts` ficam em `researcher/actions/search/`.

## Parte A. Entrada, segurança e infraestrutura

**1. `package.json:6-15`.** Olhe os scripts: build com `next build --webpack` (`:8`), `lint` agora é `eslint .` com ESLint 9 (`:10`), `test` com vitest (`:12`) e `i18n:check` (`:14`). Por que importa: é o que o CI roda, e o lockfile continua sendo yarn.

**2. `.github/workflows/ci.yaml:3-47`.** Olhe os gatilhos (todo PR e push no `master`, `:3-7`) e os passos: `yarn install --frozen-lockfile`, lint, `tsc --noEmit`, testes, `i18n:check` e build (`:31-47`). Por que importa: é o novo portão de qualidade; o `docker-build.yaml` continua só construindo imagens.

**3. `src/proxy.ts:5-27` e `src/lib/security/requestGuard.ts:61-133`.** Olhe o `matcher: '/api/:path*'` (`proxy.ts:26`), os hosts locais aceitos sem configuração (`requestGuard.ts:61-66`), `isHostAllowed` com `VANE_ALLOWED_HOSTS` e curingas (`:75-88`), e `checkApiRequest`: Host desconhecido dá 403, métodos que alteram estado exigem `Origin` igual ao Host ou ao `x-forwarded-host`, senão `Sec-Fetch-Site` `same-origin` ou `none` (`:104-133`). Por que importa: é a única barreira da API (não há login), contra DNS rebinding e CSRF; `curl` sem `Origin` passa de propósito.

**4. `src/lib/security/urlGuard.ts:31-46,116-206`.** Olhe as faixas IPv4 bloqueadas (`:31-46`), `assertPublicHttpURL`, que resolve o DNS e recusa endereço privado (`:130-176`), e `fetchPublicURL`, que segue até 5 redirecionamentos conferindo cada salto (`:178-206`). Quem usa: `scraper.ts:52,125` e `api/favicon/route.ts:88`. Por que importa: as URLs lidas vêm do modelo; `VANE_ALLOW_PRIVATE_URLS` (`:123-124`) desliga a checagem.

**5. `src/instrumentation.ts:1-22`.** Olhe a saída antecipada durante `next build` (`:6`), as migrações e o `throw` em caso de falha (`:13-18`), e só depois a importação de `config/index` (`:20`). Por que importa: uma migração com erro agora derruba o servidor em vez de subir sem tabelas.

**6. `src/lib/db/paths.ts:5-14` e `src/lib/db/open.ts:8-57`.** Olhe `DATA_DIR` só para dados e as migrações sempre em `cwd/drizzle` (`paths.ts:12-14`), o banco `:memory:` no build (`open.ts:40`) e o WAL com `synchronous = NORMAL` e novas tentativas em `SQLITE_BUSY` (`:17-33`). Por que importa: explica por que o build não cria nem trava `data/db.sqlite`, e por que o volume de dados pode ser separado da app.

**7. `src/lib/db/migrate.ts:14-34,60-313`, `src/lib/db/schema.ts:6-26` e `drizzle/0003_messages_chat_id_idx.sql`.** Olhe o runner à mão: `0001` e `0002` continuam com SQL vazio (`/* Do nothing */`) e a lógica real está escrita em `migrate.ts:80-295`; as outras migrações só executam os statements (`:296-303`), e qualquer erro é relançado (`:309-312`). O índice `messages_chat_id_idx` está no schema (`:25`) e na `0003`. Por que importa: qualquer mudança de schema passa por aqui, gerada com `drizzle-kit`.

**8. `src/lib/config/index.ts:13-31,241-376,399-440,585` e `config/secrets.ts:8-87`.** Olhe o singleton que lê o arquivo uma vez, `saveConfig` regravando tudo (`:250-255`) e a semeadura por env em `initializeFromEnv` (`:300-376`): busca só preenche vazios (`:355-360`) e Bifrost não religa um switch desligado (`:362-373`). `validateUIConfigWrite` recusa chaves fora das seções declaradas (`:399-433`), e os segredos saem mascarados (`secrets.ts:26,45`). Por que importa: mudar `config.json` na mão exige reiniciar, e env só vale na primeira vez.

**9. `src/lib/config/serverRegistry.ts:14-68`.** Olhe `getSearchProvider`, `getFirecrawlURL` e `getBifrostConfig` (`:53`). Por que importa: são os pontos de leitura de config no servidor; busca, scraper e MCP dependem deles.

## Parte B. Modelos

**10. `src/lib/models/registry.ts:14-67,108-126`, `models/modelListCache.ts:17-91` e `models/base/provider.ts:24-38`.** Olhe `new ModelRegistry()` por requisição, o Bifrost acrescentado em `addBifrostProvider` (`registry.ts:46-67`) e o cache das listas de modelos: 60 s, chave com hash da config, requisições simultâneas compartilhando uma só, falhas não guardadas (`modelListCache.ts:17-91`). Por que importa: `loadChatModel` chama `hasModel`, que antes custava um GET por mensagem.

**11. `models/providers/anthropic/index.ts:33-35,62-84` e `models/providers/bifrost/index.ts:38-60`.** Olhe o GET de modelos da Anthropic agora com `modelListSignal()` (10 s) e cache, e o Bifrost que nem consulta a lista ao carregar (`bifrost/index.ts:51-55`). Por que importa: é a latência antes de o stream abrir, por provedor.

**12. `models/providers/openai/openaiLLM.ts:58-63,168-243,246-291`, `models/utils/objectDefaults.ts:17-43` e `models/utils/timeout.ts:57-99`.** Olhe o `timeout: llmTimeoutMs()` (5 min, `:63`), `temperature ?? 1.0` no streaming (`:178-179`), e `generateObject` com 0,2 e teto de 8.192 em `max_tokens` (`:256-265`), exceto em modelos de raciocínio (`objectDefaults.ts:42-43`). Compare com `ollamaLLM.ts:68,122-125` (0,7, `num_ctx`). Por que importa: quase todos os provedores herdam esta classe; é aqui que se definem temperatura, tokens e timeout.

**13. `src/lib/bifrost.ts:14-30,32-72`.** Olhe o cabeçalho `x-bf-mcp-include-tools` com um nome que não casa com nada (`:14,25-30`) e a separação de embeddings por regex (`:32-55`). Por que importa: é como o gateway entra reaproveitando as classes OpenAI, sem deixar o Bifrost injetar ferramentas no laço do pesquisador.

## Parte C. Do clique ao stream

**14. `src/app/layout.tsx:1,36-60`.** Olhe `force-dynamic`, a leitura de config no servidor e o `ChatProvider` envolvendo tudo, ou o `SetupWizard`. Por que importa: o estado do chat vive acima das páginas e o setup bloqueia o app.

**15. `src/lib/hooks/useChat.tsx:375-536,538-630`.** Olhe o `getMessageHandler` (`researchComplete`, `updateBlock` com `applyPatch`, `messageEnd` protegido por `claimMessageEnd`, `:392-459`), as sugestões pedidas só no fim (`:505-521`) e `sendMessage` com o split por linha que reprocessa o buffer inteiro quando o JSON vem cortado (`:612-629`). Por que importa: é o lado cliente do protocolo NDJSON.

**16. `src/app/api/chat/route.ts:103-256`.** Olhe a carga paralela dos modelos (`:130-136`), `agent.searchAsync` sem `await` (`:213`), `ensureChatExists` sem `await` (`:228`) e o `abort` que só desliga o listener (`:235-240`). Por que importa: fechar a aba não cancela a busca.

**17. `src/lib/session.ts:5-103`.** Olhe o `Map` global, o TTL de 30 min (`:17,22-24`), `emit` guardando todo evento (`:45-48`) e o replay em `subscribe` (`:80-95`). Por que importa: é a base do reconnect, e cada `updateBlock` do redator guarda o texto acumulado inteiro.

## Parte D. O agente

**18. `src/lib/agents/search/index.ts:16-260`.** Leia de cima a baixo: `saveFailure` grava `status: 'error'` com os blocos já produzidos (`:16-51`), gravação ou reescrita da mensagem (`:53-92`), classificação (`:94-99`), widgets e pesquisa em paralelo (`:101-135`), `fitWriterSources` (`:164-180`), o streaming com texto acumulado (`:191-231`), a limpeza de citações (`:233-244`) e o `end` antes do `UPDATE` final (`:246-260`). Por que importa: é o fluxo inteiro em um arquivo.

**19. `src/lib/utils/citations.ts:3-32`.** Olhe `sanitizeCitations`: apaga `[n]` com `n` acima do número de fontes que o redator recebeu, mantém os válidos de um grupo e não toca código nem links markdown. Por que importa: roda uma vez, no fim do stream (`search/index.ts:236-243`), então a interface pode mostrar por um instante um `[n]` que depois some.

**20. `src/lib/agents/search/effort.ts:22-32` e `classifier.ts:32-60`.** Olhe os presets por modo (iterações 2/6/25, páginas lidas 0/2/0, caminho rápido só no speed) e o schema do classificador, que agora também devolve até 3 `searchQueries` (`:32-36`) além de `standaloneFollowUp` (`:37-41`). Por que importa: ajustar um modo é mudar uma linha de `EFFORT_PRESETS`, não caçar `mode === ...`.

**21. `researcher/index.ts:30-67,187-232`.** Olhe `fastPathQueries`: só vale com `web_search` como única ferramenta de pesquisa, sem uploads, URL na pergunta ou fontes acadêmicas (`:40-67`). No caminho rápido, um `site:` digitado pelo usuário é lido da mensagem original e vira o filtro `domains`, com o operador tirado das consultas (`:196-215`, `filters.ts:98-111`); sem resultado, cai no laço normal (`:229-231`). Por que importa: no speed é o que elimina a chamada ao LLM do pesquisador.

**22. `researcher/index.ts:103-185,234-457`.** Olhe o teto de iterações (`:109`), `syncMCPActions` (`:111`), o bloco `source` emitido já na primeira rodada e substituído depois (`:135-154,437,451`), o orçamento e a compactação do histórico (`:234-273`), o plano em tempo real (`:293-355`) e o `done` sem fontes, que ganha uma busca extra (`:367-420`). Por que importa: é o coração do comportamento por modo.

**23. `researcher/actions/registry.ts:88-107`, `actions/index.ts:10-16` e `actions/plan.ts:31`.** Olhe como cada ação decide `enabled`, o `Promise.all` com a ordem dos resultados preservada e o plano desligado no speed. Por que importa: é o ponto de extensão para novas ferramentas.

**24. `researcher/actions/mcp.ts:31-167` e `src/lib/mcp/client.ts:26-141`.** Olhe o gate por Bifrost (`:31-43`), allow list contra `readOnlyHint` (`:58-61`), truncamento a 8000 caracteres (`:20,70-73`), a falha da ferramenta virando texto em vez de derrubar o laço (`:111-115`), e o cache de 60 s com o re-registro das `mcp_*` (`:133-167`). No cliente, a resposta SSE de uma mensagem (`client.ts:26-43`) e o prazo por chamada (`:67`). Por que importa: é a única ferramenta externa dinâmica.

## Parte E. Busca, ranking, páginas e contexto

**25. `researcher/actions/search/webSearch.ts:19-36,110-146` e `filters.ts:46-158`.** Olhe os argumentos opcionais `recency`, `domains` (com `-` para excluir) e `language`, `parseSearchFilters` descartando valores inválidos (`filters.ts:46-90`), os operadores `site:` na consulta e o mesmo filtro reaplicado nos resultados (`:117-152`). Por que importa: modelo pequeno que manda lixo ainda recebe uma busca simples.

**26. `baseSearch.ts:157-197,201-226,242-462`.** Olhe a nova busca sem filtros quando a filtrada volta fraca (`:177-196`), o `runQuery` com a cota por consulta (`:201-226`), um embedding em lote por consulta com limitador de 3 e prazo de 120 s (`:63-69,264-270`), o limiar 0,5 com reserva dos 10 melhores (`:72-74,294-305`), o caminho sem embeddings (`:314-324`) e a deduplicação quase idêntica por cosseno acima de 0,75 (`:413-435`). Por que importa: é o ramo de speed e balanced, e o maior gasto de embeddings.

**27. `ranking.ts:15-100` e `baseSearch.ts:392-406`.** Olhe a pontuação léxica com peso dobrado no título (`:38-55`), os empates dividindo o mesmo posto (`:62-73`) e `fuseQueryResults`, que soma RRF (k = 60) da ordem do motor, do vetor e do léxico (`:84-100`); entre consultas, o RRF é somado por URL normalizada. Por que importa: decide a ordem das fontes e, com ela, os números de citação.

**28. `baseSearch.ts:459-461,767-854` e `:464-740`.** No balanced, olhe `readTopPages` e `bestPassages`, que leem as 2 melhores páginas e guardam os trechos mais relevantes, com prazo por página. No quality, olhe o seletor LLM (`:586`), o filtro de URLs já extraídas (`:605-617`), a leitura com `Scraper.scrape` e no máximo 3 extrações simultâneas (`:679-737`) e o corte em 100 mil caracteres (`:104`). Por que importa: é onde o tempo de cada iteração se decide.

**29. `src/lib/scraper.ts:26-78,124-160`, `src/lib/webSearch.ts:6-93`, `src/lib/firecrawlSearch.ts:32-69` e `src/lib/searxng.ts:47`.** Olhe o contrato "nunca lança" e a checagem SSRF no scraper (`scraper.ts:32-33,52`), Firecrawl 60 s contra `fetch` 20 s (`:37,41`), o despachante com no máximo 2 buscas simultâneas e duas novas tentativas em 403/429/5xx (`webSearch.ts:7,14,74-93`), a tradução de `time_range` e idioma para o Firecrawl (`firecrawlSearch.ts:54-61`) e o timeout de 10 s do SearXNG. Por que importa: mídia e Discover continuam indo direto ao SearXNG.

**30. `src/lib/context/budget.ts:6-77`, `context/compact.ts:5,91-204` e `agents/search/writerContext.ts:31-75`.** Olhe a janela (`LLM_CONTEXT_WINDOW`, o que o provedor informar, ou 32 000; `budget.ts:38-52`), o fator 1,2, as reservas de saída por etapa e modo (`:22-25`), o limiar de 75% da compactação (`compact.ts:5`), o `fitSourcesToBudget` que preserva a ordem, e o `formatSearchResult` com `source=` e `date=` (`writerContext.ts:31-37`). Por que importa: decide quanto contexto o redator recebe.

## Parte F. Recursos laterais

**31. `src/lib/uploads/paths.ts:12-26`, `uploads/manager.ts:39-41,79-88,198` e `uploads/store.ts:53-97`.** Olhe os uploads seguindo `DATA_DIR` com leitura de reserva na pasta antiga, e o RRF de `query` com o hash de `{chunk, score}` (`store.ts:74`), que faz cada consulta gerar uma chave diferente e impede a soma. Por que importa: esse bug de qualidade continua, assim como a releitura de disco a cada iteração (`prompts/search/researcher.ts:333`).

**32. `src/lib/discover/fetchTopic.ts:106-165`, `discover/cache.ts:12-59` e `discover/rss.ts:5-7,144-157`.** Olhe RSS primeiro, SearXNG se houver menos de 8 itens (`fetchTopic.ts:11,112`), merge e cache com TTL e requisições compartilhadas. Por que importa: é o padrão de cache a seguir para o resto.

**33. `src/app/api/search/route.ts:54,100-107` e `src/lib/agents/search/api.ts:11-24`.** Olhe o `try/catch` novo em `APISearchAgent.searchAsync` e o evento `error` virando resposta 500 no modo sem stream. Por que importa: um erro de LLM não deixa mais a requisição pendente; documentação em `docs/API/SEARCH.md`.

## Parte G. Interface e medição

**34. `src/components/MessageBox.tsx:49-95`, `src/components/Chat.tsx:80` e `components/MessageRenderer/Citation.tsx:17,27,41`.** Olhe o markdown memoizado com `safeMarkdownRenderRule` (`MessageBox.tsx:49-95`), a espera sem conteúdo (`Chat.tsx:80`) e a prévia da citação com favicon, data e até 280 caracteres. Por que importa: mostra onde o usuário espera e onde está o custo de renderização por token.

**35. `src/lib/benchmark/runner.ts:51-142`, `benchmark/instrument.ts:98,234,339,368`, `benchmark/probe.ts:46`, `benchmark/analyze.ts:304` e `src/app/api/benchmark/route.ts:115-154`.** Olhe os wrappers `InstrumentedLLM` e `InstrumentedEmbedding`, o rastreio de `fetch` agrupado por caminho (`classifyURL`, `withHttpTrace`), as sondas de rede, o diagnóstico em `analyze` e o stream NDJSON da rota. O runner usa `APISearchAgent` (`runner.ts:119`). Por que importa: é a ferramenta para medir o que os docs só estimam; a eval de qualidade fica em `perf-audit/eval/`.

## Parte H. Empacotamento

**36. `Dockerfile:1-32,34-66,68-113`, `Dockerfile.slim:32-58`, `entrypoint.sh:8-44` e `docker-compose.yaml:9,13`.** Olhe o estágio de build, o SearXNG num estágio próprio fixado em `SEARXNG_COMMIT` (`Dockerfile:37,55-56`), o `standalone` e o `drizzle` copiados para a imagem final (`:84-85`), o SearXNG iniciado com `setpriv` e uma sonda de até 30 s no lugar do `sleep` (`entrypoint.sh:8-39`), e a porta presa a `127.0.0.1` no compose. Por que importa: é o que muda entre a imagem completa e a slim, e o que roda ao iniciar.

Fora do roteiro: `src/__tests__/helpers/fakes.ts` (`FakeLLM`, `FakeEmbedding`, `createFakeSession`) e os testes em `src/lib/agents/search/__tests__/` (por exemplo `pipeline.test.ts` e `fastPath.test.ts`, que cobre o `site:` em `:147`) mostram como o pipeline é testado sem rede.
