# Fork module195/Vane x upstream ItzCrazyKns/Vane (antigo Perplexica)

Data da coleta: 07/11/2026. Atualiza o `perf-audit/upstream.md` de 06/11/2026. Pesquisa só de leitura: nada foi comentado, aberto ou enviado no GitHub. O remoto `upstream` não foi adicionado ao config do repositório; os refs do upstream foram buscados por URL para `refs/remotes/upstream/*`.

## Ferramentas usadas e falhas

| Ferramenta | Resultado |
| --- | --- |
| `git fetch` do upstream por URL (todos os branches) | OK. Branch atual e árvore de trabalho sem mudança. |
| `gh api search/issues` | OK (exige `is:issue` ou `is:pull-request` na busca). |
| `gh api repos/ItzCrazyKns/Vane/issues/N` | **Bloqueado** (403, repositório não habilitado na sessão). Os corpos das issues vieram da própria busca. |
| GitHub MCP no upstream | Não usado de novo: na rodada anterior deu `Access denied` para o upstream. |
| DeepWiki (`ask_wiki_question`) | OK. 2 perguntas novas. |
| context7 e exa | Não conectaram (ERR_PROXY_TUNNEL). Não eram necessários. |
| `ItzCrazyKns/Perplexica` | Redireciona para `ItzCrazyKns/Vane` (mesmos refs), então as issues são as mesmas. |

## 1. Fork x upstream

### Contagens (refeitas hoje)

| Comparação | Fork à frente | Fork atrás |
| --- | --- | --- |
| `origin/master` (02bd0c7, 06/11/2026) x `upstream/master` (348feca, 01/09/2026) | **152** (112 sem merges) | **0** |
| `origin/master` x `upstream/canary` (0987ee4, 27/12/2025) | 215 | 0 |
| HEAD local `claude/project-thread-bivz3o` (78f19ff) x `upstream/master` | 154 | 0 |

- A base comum continua sendo o HEAD do upstream (`348feca Update README.md`). O upstream não mudou desde a coleta anterior.
- Correção de número: o documento anterior dava 51 à frente. Esse era o valor para o commit `3b3799c`. Desde então o fork recebeu cerca de 100 commits (dia 06/11), daí os 152 de hoje.
- **Nenhum commit do upstream falta no fork.** O upstream não mescla PR desde 10/04/2026 (busca `is:merged merged:>=2026-04-11` devolve 0). Há 244 issues e 136 PRs abertos.
- Os outros branches do upstream são velhos e de histórico paralelo. O mais recente fora de `master`/`canary` é `feat/improve-search-architecture` (2e2c584, 27/12/2025), que aparece com 929 commits "fora do fork" só porque o histórico foi reescrito antes do squash. Nada lá é mais novo que o master.
- Logo, as "correções do upstream que faltam" continuam sendo **PRs abertos e nunca mesclados**.

### PRs abertos do upstream: situação no fork hoje

Muitos itens que estavam como "Falta" em 06/11 entraram no fork no mesmo dia. Conferi cada um no código.

| PR / issue | O que corrige | Situação no fork (verificada hoje) |
| --- | --- | --- |
| #1168 | Embeddings em lote (N+1) | **Feito.** Uma chamada `embedText([q, ...contents])` por query (`baseSearch.ts:265-269`, commit `73f997a`) |
| #1147 | Limite de concorrência de embeddings | **Feito.** `createLimiter(3, timeout 120 s)` (`baseSearch.ts:61-69`, `73f997a`, `5de3b07`) |
| #1120 / #1119 | Volta aos top-10 quando o filtro >0,5 zera a query | **Feito** (`254d12d`, `FALLBACK_RESULTS = 10`) |
| #1096 / #1093 / #1054 | Status `error` no banco e `res.ok` no reconnect | **Feito** (`046a85e` grava `status:'error'` e blocos parciais; `22daea1` no `useChat`) |
| #1099 | try/catch no `APISearchAgent` | **Feito** (`c884f1f`) |
| #993 | Timeout do LLM | **Feito.** `LLM_TIMEOUT_MS`, padrão de 5 min (`src/lib/models/utils/timeout.ts`, `a1425f3`) |
| #1091 / #964 | Guardas para `urls`/`queries` indefinidos | **Feito** (`aaeead3`, `normalizeURLArgs` em `scrapeURL.ts:55-69`) |
| #1228 | Fontes deduplicadas por URL normalizada | **Feito** (`786cbac`, `dedupeByUrl`) |
| #1227 | Remove citações `[n]` acima do total de fontes | **Feito** (`7d36206`) |
| #1032 / #1037 / #1042 / #959 | JSON dentro de cercas markdown | **Feito** (`33e00bc`, `parseModelJson` com `stripCodeFences` + `repairJson`) |
| #1200 | Escapar HTML cru (XSS) | **Feito** (`src/lib/markdownSafety.ts`) |
| #1222 / #1052 / #1145 / #1224 | SSRF no scrape e nos base URLs | **Feito** para o scrape (`src/lib/security/urlGuard.ts`: só http(s), recusa IP privado salvo `VANE_ALLOW_PRIVATE_URLS`). Base URL de provider privado continua aceito de propósito (LM Studio/Ollama locais) |
| #1223 | Esconder credenciais no `GET /api/config` | **Feito** (`maskConfig`/`maskProvider` em `src/lib/config/secrets.ts`) |
| #1056 / #977 | Limite de resultados por query | **Feito** de outro jeito: `RESULTS_PER_SEARCH_CALL = 30` dividido entre as queries |
| #1226 | Pareia resultados com tool calls; `splitText` sem loop infinito | **Feito** (veio no PR #3; `registry.ts:99` usa `Promise.all`, `splitText.ts:45-49`) |
| #1229 | Rewrite preso no loading | **Feito** (PR #3) |
| #1231 / #1211 | Resposta normal quando o classificador pula a busca | **Feito** (prompt "Answering without search" em `writer.ts:40`) |
| #1038 / #938 | Snapshot no reconnect em vez de repetir todos os eventos | **Falta.** `session.ts:80-95` ainda repete o array `events` inteiro |
| #1051 / #1030 | Keepalive no stream durante gerações longas | **Falta.** Só há o header `Connection: keep-alive` |
| #1214 / #1210 | Respeitar `HTTP(S)_PROXY` (`NODE_USE_ENV_PROXY=1`) | **Falta** nos dois Dockerfiles |
| #1230 | Teto nos arrays do corpo de `/api/chat` (GHSA-mrhx-c7xc-m3w5) | **Parcial.** O zod já é 4.6.7, mas `sources`, `history` e `files` continuam sem `.max()` (`route.ts:39-44`) e `safeValidateBody` devolve todas as issues no 400 |
| #1219 | Node 24.22.1 na imagem (CVE-2026-111497) | **Falta.** `Dockerfile` e `Dockerfile.slim` usam `node:24.5.0-slim` |
| #1232 / #1131 | Selects de modelo sincronizados após adicionar/apagar modelo | **Falta.** `Section.tsx:29-35` passa `values` (props iniciais) aos `ModelSelect`, não o estado `providers` |
| #1209 (2) | Versão do `next` diferente no runtime do Docker | Provavelmente coberto (`5b45cd0`, next 16.4.5); não testado |
| #1050 / #1116 / #980 / #1061 | Groq com `json_schema` | **Falta.** `GroqLLM extends OpenAILLM` sem ajuste; usa `zodResponseFormat` estrito |
| #1189 / #1185 | `unhandledRejection: fetch failed` | Parcial: o erro agora vai para a sessão e para o banco, mas não há tratamento específico |

## 2. Issues e PRs do upstream

Foco em itens abertos ou atualizados desde set/2026 e nos que ainda afetam o fork. Os itens do documento anterior que o fork já resolveu estão resumidos no fim da tabela.

| # | Tipo | Título (resumido) | Estado | Resumo | Vale para o fork hoje? | Fork já corrigiu? |
| --- | --- | --- | --- | --- | --- | --- |
| 1199 | issue | Memory leak: ~40 MB retidos por interação | aberto | RAM de `next-server` cresce com o tráfego até 15,6 GB | **Sim.** Ver nota A: sessões vivem 30 min com todos os eventos, e os blocos guardam cópias dos vetores de embedding | Parcial (#1225 tira o vazamento do Transformers) |
| 1233 | issue (novo, 06/11) | 400 "unsupported keyword: $schema" em backends OpenAI-compatíveis estritos | aberto | O validador do servidor recusa `$schema` no `response_format` | **Sim.** Testei: `zodResponseFormat` do SDK `openai` 6.x gera `"$schema": "http://json-schema.org/draft-07/schema#"` e `openaiLLM.ts:272` o envia sem limpar. Afeta classificador, picker e extractor | Não |
| 1197 | issue | Pipeline trava ou quebra quando o modelo vaza tokens Harmony (`<\|channel\|>`) | aberto | gpt-oss/gemma via gateway Ollama | **Sim.** Não há tratamento de tokens Harmony em `src/lib/models`. Com `046a85e` a falha vira erro visível em vez de trava | Parcial |
| 1206 | issue | Config de provider apagada: diálogos resetam no meio da edição; config inválida é salva | aberto | Provider salvo como `{"name": ...}` sem chave | **Sim, em parte.** `99fb3c6`/`2fbcd94` tiraram o `setConfig` do `useMemo`, mas `AddProviderDialog.tsx:58-66` e `UpdateProviderDialog.tsx:50-53` ainda resetam o formulário quando a identidade do array de campos muda num re-render do pai. E `registry.addProvider`/`updateProvider` gravam sem chamar `parseAndValidate` | Parcial |
| 1230 | PR | Teto nos arrays de `/api/chat` (DoS de memória com zod) | aberto | 50.000 itens geram resposta de 4 MB | **Sim** (ver tabela da seção 1) | Parcial |
| 1170 | issue | `/api/search` dá 500 "reading 'providerId'" | aberto | Corpo sem `chatModel`/`embeddingModel` | **Sim.** `api/search/route.ts:37-41` lê `body.chatModel.providerId` sem validar; vira 500 genérico em vez de 400 | Não |
| 1038 / 938 | PR / issue | Texto repetido no reconnect | aberto | Replay completo dos patches | **Sim** | Não |
| 1030 / 1051 | issue / PR | Desconecta do LM Studio antes de terminar | aberto | Sem keepalive em gerações de vários minutos | **Sim.** Proxies reversos cortam streams ociosos; o timeout de 5 min do LLM ajuda a não prender, mas não mantém a conexão viva | Não |
| 1210 / 1214 | issue / PR | `fetch` do servidor ignora `HTTP(S)_PROXY` | aberto | Docker/Kubernetes com saída restrita | **Sim** | Não |
| 1207 / 1102 | issue | `Dockerfile.slim`: Next escuta só no IP de `$HOSTNAME` | aberto | Container em duas redes fica inacessível numa delas | **Sim.** Nenhum dos Dockerfiles nem o `entrypoint.sh` (que faz `exec node server.js`) define `HOSTNAME=0.0.0.0` | Não |
| 1219 | PR | Node 24.22.1 (CVE no decodificador Brotli) | aberto | Imagem com Node 24.5.0 | **Sim** | Não |
| 1131 / 1232 | issue / PR | Select de modelo não mostra modelo recém-adicionado | aberto | Só atualiza ao reabrir Configurações | **Sim** (`Section.tsx:29-35`) | Não |
| 1204 | issue | Modelo local OpenAI: "nome" e "chave" parecem trocados | aberto | Usuário confunde "Model key" (id do modelo) com API key | **Sim, e pior em pt-BR:** o rótulo é "Chave do modelo" (`pt-BR.json:73`), que lembra "chave de API". Sugestão: "ID do modelo" | Não |
| 1208 | issue | Campos de API key aparecem em texto puro | aberto | Inputs `type="text"` | **Sim.** `AddProviderDialog.tsx:166,192` e `UpdateProviderDialog.tsx:147,173` usam `type="text"` | Não (o GET mascara, mas a digitação aparece) |
| 980 / 1061 | issue | Groq quebrado (json_schema) | aberto | Schema estrito incompatível | **Sim** | Não |
| 1144 | issue | US$ 3000 de cobrança no OpenRouter | aberto | Sem teto de gasto | **Sim**, em tese: não há limite de custo; o quality ainda pode chegar a 25 iterações. O benchmark do fork agora mede tokens reais (`4614b9c`) | Não |
| 1186 | issue | `chatModels` zerado ao reiniciar (Anthropic) | aberto | Config sobrescrito no boot | **Não reproduzido.** `initializeFromEnv` (`config/index.ts:300-375`) só acrescenta providers por hash do config; o hash não é recalculado em `updateModelProvider`, o que pode gerar provider duplicado se o env mudar | Verificar |
| 1169 | issue | `.txt` com várias linhas quebra o JSON (Ollama) | aberto | Caractere de controle dentro de string | Provavelmente não: `ollamaLLM.ts:252` usa `parseModelJson` com `repairJson` | Provavelmente coberto |
| 1173 | issue | GPT 5.6 recusa `reasoning_effort` com tools | aberto | Parâmetro não suportado | Não: o fork não envia `reasoning_effort` | N/A |
| 1163 | issue | PDF exportado quebra com japonês/CJK | aberto | jsPDF só com Helvetica | Sim para CJK (`Navbar.tsx:118`); português sai normal | Não |
| 1143 | issue | 82 resultados e nenhuma resposta (Gemini) | aberto | Pipeline para após a busca | Provavelmente coberto: erros agora chegam à UI e ao banco (`046a85e`, `22daea1`) | Verificar com Gemini |
| 1184 | issue | "Failed to connect" atrás de SNI-proxy | aberto | `fetch('/api/providers')` com credenciais embutidas na URL da página | Sim (chamadas relativas no cliente); caso raro | Não |
| 1139 / 1123 / 1180 / 1155 / 1122 | issue | Config sem autenticação, SSRF de segunda ordem pela URL do SearXNG | aberto | Qualquer um que alcance a API muda o config | **Parcial.** O fork mascara segredos e tem `requestGuard.ts` (lista de hosts contra DNS rebinding e escrita só de mesma origem), mas não há login; curl na rede ainda grava `/api/config` | Parcial |
| 1109 | issue | Citações duplicadas (mesmo artigo em vários sites) | aberto | PubMed, ScienceDirect e ResearchGate para o mesmo paper | Parcial: `dedupeByUrl` junta URLs iguais e o corte >0,75 junta textos parecidos, mas não o mesmo trabalho em domínios diferentes | Parcial |
| 1172 / 1130 / 997 | issue | Erros e logs pobres | aberto | Difícil depurar | Melhor no fork: erros na UI, `trace.ts` e benchmark | Parcial |
| 1190 | issue | 0 resultados com o SearXNG embutido | fechado | SearXNG da imagem antigo | Fork fixou o commit do SearXNG num estágio próprio (`68cd78a`) | Revisar a versão fixada |
| 1132 / 1121 | issue | Imagem Docker enorme | aberto | Camadas de Playwright etc. | Fork sem Playwright, slim sem pip e só o runtime CPU do onnxruntime (`6fcf5e2`, `197ebef`, `2f804d8`) | Feito em grande parte |
| Já resolvidos no fork | — | #1168, #1147, #1119/#1120, #1006, #1070, #965, #1069, #1080, #1099, #503, #964, #959, #1011, #1031, #977, #981, #858, #1160, #1150, #1154, #1174, #1211, #1200, #1222, #1228, #1227 | — | Ver a seção 1 | — | Sim |

### Notas de auditoria (código do fork)

- **A. Memória (#1199), verificado hoje.** O `SessionManager` (`src/lib/session.ts`) guarda cada sessão num `Map` por 30 min (`setTimeout` fixo, sem `clearTimeout` e sem apagar no `end`/`error`). Cada sessão mantém o array `events` com todos os patches e um `Map` de blocos. O `rfc6902` clona o `value` de cada `replace` (`node_modules/rfc6902/patch.js:151`). Em speed/balanced, `baseSearch.ts:282-291` coloca o vetor `embedding` de cada resultado nos chunks e manda `replace /data/subSteps` com eles (`baseSearch.ts:361-385`). O `delete uniqueResult.metadata.embedding` da linha 443 só apaga o objeto original. Testei com um script contra o `session.ts` real: o bloco da sessão continua com os 1024 floats depois do `delete`. Consequências: (1) os vetores vão no NDJSON para o navegador; (2) ficam na memória da sessão por 30 min; (3) `session.getAllBlocks()` é o que vai para `messages.responseBlocks` (`index.ts:252`), então, se nenhum `replace` posterior trocar o array, os vetores também são gravados no SQLite. Cada `updateBlock` repete o array `subSteps` inteiro, então `events` cresce de forma quadrática nas iterações. Correção barata: não pôr `embedding` nos chunks que vão para o bloco (manter num `Map` à parte), apagar a sessão alguns minutos depois do `end`, e mandar snapshot no reconnect (#1038).
- **B. `$schema` (#1233).** Afeta toda chamada `generateObject` em providers que estendem `OpenAILLM` (OpenAI, Anthropic, Gemini, Groq, LM Studio, Lemonade, Bifrost) contra servidores com validador estrito. Correção: tirar `$schema` de `response_format.json_schema.schema` antes do envio.
- **C. Outros riscos que continuam.** Sem keepalive no stream (#1051), sem proxy de saída (#1214), sem teto de custo (#1144), e `generateText` não streaming ainda faz `JSON.parse(tc.function.arguments)` sem guarda (`openaiLLM.ts:144`), o mesmo erro do #1160 no caminho sem streaming.

## 3. Conferência com o DeepWiki

O DeepWiki descreve o upstream (às vezes código antigo, e às vezes se contradiz). Abaixo, o que ele diz e o que o código do fork faz hoje.

| Tema | DeepWiki (upstream) | Fork hoje (verificado no código) | Diverge? |
| --- | --- | --- | --- |
| Iterações por modo | speed 2, balanced 6, quality 25 | Iguais, mas agora vêm de `EFFORT_PRESETS` (`src/lib/agents/search/effort.ts`), com `readPages` e `fastPath` por modo | Sim (presets e caminho rápido) |
| Speed | Loop de research normal | Caminho rápido: usa as queries do classificador (até 3) sem passar pelo loop (`891cca7`, `78f19ff` respeita `site:`) | Sim |
| Ranking speed/balanced | Cosseno com a query, corte <0,5, ordena por similaridade, remove duplicatas >0,75, máximo 20 | Ranking híbrido: embedding + lexical fundidos por RRF entre as queries (`ranking.ts`, `1a64c7a`), fallback para top-10, dedupe por URL normalizada, filtros de recência/domínio/idioma (`filters.ts`), nova busca quando a evidência é fraca. Mantém o corte 0,5 e o >0,75 | Sim |
| Embeddings | Um pedido por resultado (implícito) | Um pedido por query, até 3 em paralelo, timeout de 120 s | Sim |
| Balanced lê páginas? | Não; só o quality raspa | Sim: lê 2 páginas e anexa os 2 melhores trechos por página (`pageReading`, timeout 8 s) | Sim |
| Quality | Picker escolhe até 3 resultados, raspa e extrai fatos com LLM | Igual na lógica, mas extrações limitadas a 3 simultâneas e página cortada em 100.000 caracteres (`6cc1684`) | Sim (limites) |
| Raspagem | `Scraper` (na coleta anterior: Playwright) | Firecrawl quando configurado, senão fetch + Readability; `urlGuard` contra SSRF | Sim |
| Busca web | Só SearXNG, timeout 10 s; "não há backend alternativo nem MCP" | `searchWeb` escolhe SearXNG ou Firecrawl; ferramentas MCP do Bifrost como ações `mcp_*` | Sim |
| Structured output | OpenAI usa `responses.stream` com `zodTextFormat` | `generateObject` usa `chat.completions.create` + `zodResponseFormat` + `parseModelJson` (cercas e reparo), temperatura 0,2 e teto de tokens (`124d69e`). `responses.stream` só sobra em `streamObject` | Sim |
| Providers | Na 2ª pergunta disse que `LMStudioLLM` estende `BaseLLM` | No fork (e no upstream) `LMStudioLLM`, Anthropic, Gemini, Groq e Lemonade estendem `OpenAILLM`; só Ollama estende `BaseLLM` direto. Fork soma Bifrost | DeepWiki errou nesse ponto |
| Config | `config.json`; env sobrepõe defaults | Env só preenche valores vazios no primeiro start; depois vale o salvo. Seção `bifrost`, `migrateConfig` simples | Sim (prioridade do env) |
| DB e migrações | Migração seria "placeholder" em `ConfigManager.migrateConfig` | Runner próprio `src/lib/db/migrate.ts` aplica `drizzle/*.sql` no start e registra em `ran_migrations`; WAL + `synchronous=NORMAL`, índice em `messages(chatId)`, exclusão em transação | Sim (o DeepWiki confunde migração de config com migração de banco) |
| Formato do stream | "SSE" com `text/event-stream` | O header é `text/event-stream`, mas o corpo é NDJSON (um JSON por linha), não SSE de verdade. Upstream igual | Só de nome |
| Reconnect | Na 2ª pergunta disse que **não** repete eventos | Repete todos (`session.ts:80-95`), no upstream também (`git show 348feca:src/lib/session.ts`, linhas 81-92). Na coleta anterior o próprio DeepWiki disse que repetia | DeepWiki se contradiz; o código repete |
| Status no erro | `SearchAgent` grava `completed` mesmo no erro | Fork grava `status:'error'` com blocos parciais (`index.ts:38`) | Sim |
| Timeouts | Só SearXNG 10 s; nenhum no LLM | LLM 5 min (`LLM_TIMEOUT_MS`), embeddings 120 s, leitura de página 8 s, GET da lista de modelos 10 s com cache, Firecrawl, MCP e RSS com timeout | Sim |
| Limites de concorrência | 3 queries por `web_search`, 3 URLs por `scrape_url` | Iguais (`MAX_QUERIES_PER_CALL`, `MAX_URLS_PER_CALL`), mais limitador global de embeddings e de extrações | Sim (limites extras) |
| Writer | Sem limite explícito de contexto (coleta anterior) | `fitWriterSources` (`writerContext.ts`), resposta direta primeiro e tamanho proporcional (`eacf69b`) | Sim |
| Benchmark | Não existe | `src/lib/benchmark/` e `POST /api/benchmark` | Só no fork |

### O que o DeepWiki ainda ajuda a ver

1. O DeepWiki não fala de MCP, Firecrawl, Bifrost nem do caminho rápido. Esses caminhos só existem no fork e não têm a "revisão" de ninguém de fora.
2. O que ele diz de sessão e memória (eventos guardados por 30 min) continua valendo, e a nota A mostra que o fork ainda carrega os vetores de embedding nessa memória.
