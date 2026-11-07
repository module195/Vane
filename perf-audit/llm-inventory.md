# Inventário de chamadas a LLM e a modelos de embedding — Vane (HEAD 78f19ff)

Escopo: `src/` na árvore de trabalho atual (HEAD `78f19ff`, logo após `050f357 fix(embeddings)`). `perf-audit/eval` fica fora: ele só embrulha o `BaseLLM` do app (`perf-audit/eval/lib/models.ts`, que força temperatura 0) e não acrescenta etapas.

## 0. Resumo

- **19 pontos de chamada no código do app**: 13 de LLM e 6 de embedding.
  - Os 13 de LLM usam todos o **modelo de chat escolhido pelo usuário**: 10 `generateObject`, 3 `streamText` e 0 `generateText` / `streamObject`.
  - Os 6 de embedding usam todos `embedText` e o **modelo de embedding do usuário**. Ninguém chama `embedChunks`.
- **Camadas de repasse** (não contam como pontos de chamada): `src/lib/benchmark/instrument.ts:144,153,166,179` (LLM) e `:264,270` (embedding). Elas só repassam a chamada e medem tempo, tamanho e uso.
- **Chamadas diretas a SDK** (todas dentro dos provedores):
  - `openaiLLM.ts:111` (`chat.completions.create`), `:174` (com stream), `:253` (objeto), `:297` (`responses.stream`, só para `streamObject`).
  - `ollamaLLM.ts:113,169,220,261` (`ollama.chat`).
  - `openaiEmbedding.ts:34,44` (`embeddings.create`), `ollamaEmbedding.ts:22,31` (`ollama.embed`) e `transformerEmbedding.ts:49` (pipeline local ONNX).
- **Fora de `models/providers` não há chamadas diretas a SDK nem `fetch` para `/chat/completions` ou `/embeddings`.** Os `fetch` de `lmstudioLLM.ts:27` (`/api/v0/models`) e das listas de modelos são metadados, não inferência.
- **Discover** (`src/lib/discover`) e **compactação de contexto** (`src/lib/context/compact.ts`, `budget.ts`) **não chamam LLM**. A compactação troca resultados antigos de ferramentas por um resumo de uma linha, sem LLM, e o redator só recorta as fontes. A janela de contexto vem do env `LLM_CONTEXT_WINDOW`, de `getContextWindow()` do provedor ou do padrão de 32k.
- **Nenhum provedor repassa `options` (GenerateOptions)** ao construir o LLM (`providers/*/index.ts`, `bifrost/index.ts:54`), e **nenhum ponto de chamada passa `options`**. Por isso todo `input.options?.x ?? this.config.options?.x` resolve para o valor de fallback fixo no provedor ou para `undefined`. topP, stop e as penalidades nunca são enviados.

### Padrões que valem para todas as linhas da tabela

| Classe | Temperatura | Limite de saída | Timeout | Retentativa |
|---|---|---|---|---|
| OpenAI-compatível (`OpenAILLM`: OpenAI, Anthropic, Gemini, Groq, LM Studio, Lemonade, Bifrost) `generateObject` | `objectTemperature()` = **0.2** (`src/lib/models/utils/objectDefaults.ts:17,28`; env `LLM_OBJECT_TEMPERATURE`). **1.0** em modelos de raciocínio da OpenAI (`isOpenAIReasoningModel`, `objectDefaults.ts:44`) | `max_tokens` = `objectMaxTokens()` = **8192** (`objectDefaults.ts:18,32`; env `LLM_OBJECT_MAX_TOKENS`, 0 = sem limite). Sem limite em modelos de raciocínio da OpenAI | `timeout: llmTimeoutMs()` = **300 s** até os headers (`src/lib/models/utils/timeout.ts:14,16`; env `LLM_TIMEOUT_MS`), definido no construtor do SDK em `openaiLLM.ts:63` | o SDK openai 6.33 usa `maxRetries` = **2** por padrão em 408/409/429/5xx/erro de conexão. Falha de parse não é retentada |
| OpenAI-compatível `streamText` | **1.0** fixo (`openaiLLM.ts:179`) | **nenhum** (padrão do servidor) | 300 s até o primeiro byte. Depois disso vale só o `bodyTimeout` do undici (300 s sem dados) | SDK 2x (só antes do stream começar) |
| Ollama `generateObject` | 0.2 (`ollamaLLM.ts:232`) | `num_predict` 8192 (`ollamaLLM.ts:237`). `num_ctx` = `OLLAMA_NUM_CTX` ou 32000 (`ollamaLLM.ts:39-42`) | `fetchWithHeadersTimeout(llmTimeoutMs())` (`ollamaLLM.ts:68`, `timeout.ts:30`) | nenhuma |
| Ollama `streamText` | **0.7** fixo (`ollamaLLM.ts:180`) | nenhum (`num_predict` indefinido) | igual ao de cima | nenhuma |
| Embedding OpenAI-compatível | — | — | **sem timeout próprio**: padrão do SDK, 600 s × (1+2 retentativas) (`openaiEmbedding.ts:25-29`). Na busca, há um teto de 120 s no slot (`baseSearch.ts:63-69`) | SDK 2x |
| Embedding Ollama | — | — | nenhum (só o `headersTimeout` de 300 s do undici; `ollamaEmbedding.ts:17`) | nenhuma |
| Embedding Transformers | — | — | nenhum (local; o primeiro uso baixa o modelo) | o pipeline que falhou é esquecido (`transformerEmbedding.ts:42`) |

**Raciocínio desligado?** Só no **Ollama**, nos 4 métodos, com `think: false` quando o nome do modelo contém algum item da lista `reasoningModels` (`ollamaLLM.ts:44-53`: gpt-oss, deepseek-r1, qwen3, deepseek-v3.1, magistral, nemotron-3, nemotron-cascade-2, glm-4.7-flash). **OpenAI, LM Studio, Anthropic, Gemini, Groq, Lemonade e Bifrost não recebem nada** que desligue o raciocínio: não há `reasoning_effort`, `chat_template_kwargs.enable_thinking=false` nem `/no_think` (grep sem resultados em `src/`).
- Anthropic: o pensamento estendido já vem desligado por padrão no endpoint compatível. Na prática, desligado.
- Gemini 2.5: pensa por padrão. Ligado.
- Groq qwen3/gpt-oss: raciocinam por padrão. Ligado.
- LM Studio e Lemonade: depende do template do modelo. Ligado em qwen3, gpt-oss e R1.
- O texto do raciocínio é descartado. No benchmark ele aparece em `reasoningChars` (`openaiLLM.ts:41`).

## 1. Tabela de pontos de chamada

Legenda: "chat" = modelo de chat do usuário; "emb" = modelo de embedding do usuário. "Raciocínio" indica se a chamada o desliga: **Ollama: sim, se o modelo estiver na lista; os outros 7 provedores: não**. Isso vale para todas as linhas de LLM, porque nenhuma etapa passa algo específico.

| # | arquivo:linha | etapa | modelo | prompt de sistema (onde + resumo) | streaming | max_tokens | temperatura | timeout | tratamento de erro | raciocínio desligado |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `src/lib/agents/search/classifier.ts:45` | Classificador (`generateObject`): skipSearch, fontes, widgets, ≤3 consultas, reescrita autônoma | chat | `src/lib/prompts/search/classifier.ts:1`: classifica a consulta, define os flags e reescreve a pergunta no idioma do usuário | não | 8192 (`objectDefaults.ts:18`); nenhum em modelo de raciocínio OpenAI | 0.2 (`objectDefaults.ts:17`) / 1.0 em modelo de raciocínio OpenAI | LLM 300 s (`timeout.ts:14`) + SDK 2x | **throw**: `searchQueries` malformado vira [] (`classifier.ts:32-33`), mas qualquer erro de parse/rede derruba a resposta inteira (`index.ts:17-28` → evento `error` + status `error`) | Ollama: lista; outros: não |
| 2 | `src/lib/agents/search/researcher/index.ts:275` | Pesquisador: laço de chamadas de ferramenta (`streamText` + tools), 1 chamada por iteração | chat | `src/lib/prompts/search/researcher.ts:324` (`getResearcherPrompt` → speed `:4`, balanced `:90`, quality `:192`): descreve as ferramentas, a iteração i/max e os arquivos enviados | sim | **nenhum** (reserva de 4000 só no orçamento, `budget.ts:23`) | OpenAI-compatível 1.0 (`openaiLLM.ts:179`); Ollama 0.7 (`ollamaLLM.ts:180`) | 300 s até o 1º byte + SDK 2x; sem timeout no meio do stream | **throw**: erro do stream ou do `partial-json` parse (`openaiLLM.ts:219,230`) sobe e derruba a busca. Ferramenta desconhecida faz `ActionRegistry.execute` lançar (`registry.ts:81-83`), e o `Promise.all` (`registry.ts:99`) também derruba a busca | idem |
| 3 | `src/lib/agents/search/index.ts:191` | Redator (UI, `/api/chat`) | chat | `src/lib/prompts/search/writer.ts:12` (`getWriterPrompt`): resposta direta, citações [n], regras de tamanho por modo, idioma do usuário | sim | **nenhum** (reserva 3000/4000/6000 só no orçamento, `budget.ts:24`) | 1.0 / 0.7 | 300 s até o 1º byte + SDK 2x | **throw** → `searchAsync` emite `error` e salva status `error` (`index.ts:17-28,33-51`). Depois `sanitizeCitations` (`index.ts:235-244`) | idem |
| 4 | `src/lib/agents/search/api.ts:130` | Redator (`/api/search` e benchmark) | chat | `writer.ts:12` (o mesmo); contexto vazio `''` quando não há busca (`api.ts:95`) | sim | nenhum | 1.0 / 0.7 | igual | **throw** → evento `error` (`api.ts:13-23`); **sem** `sanitizeCitations` | idem |
| 5 | `src/lib/agents/search/researcher/actions/search/baseSearch.ts:586` | Seletor do modo quality: escolhe 2-3 de todos os resultados únicos | chat | inline em `baseSearch.ts:554-576`: escolhe ≤3 índices pela pergunta e pelas consultas; saída `{picked_indices}` | não | 8192 | 0.2 | LLM 300 s + SDK 2x | **throw sem catch**: a falha sobe por `executeSearch` → ação `web_search` → `Promise.all` em `registry.ts:99`, e a resposta inteira cai | idem |
| 6 | `src/lib/agents/search/researcher/actions/search/baseSearch.ts:703` | Extrator do modo quality: 1 chamada por pedaço de 4000 tokens de cada página escolhida (≤100k caracteres por página) | chat | inline em `baseSearch.ts:637-669`: fatos em tópicos ligados à pergunta, números preservados, `{extracted_facts}` | não | 8192 | 0.2 | LLM 300 s + SDK 2x; limitador `EXTRACTOR_CONCURRENCY`=3 **por chamada de `executeSearch`** (`baseSearch.ts:98,679`), sem `timeoutMs` | **swallowed** por pedaço (`baseSearch.ts:719-721`, só `console.log`); página com todos os pedaços falhando ainda entra com `content: ''` (`baseSearch.ts:725-728`) | idem |
| 7 | `src/lib/agents/search/researcher/actions/scrapeURL.ts:192` | Extrator do `scrape_url` (só quando a página tem >1 pedaço) | chat | inline em `scrapeURL.ts:9-41`: igual ao #6, mas **sem a pergunta**; usuário = `<queries>Summarize</queries>` (`scrapeURL.ts:201`) | não | 8192 | 0.2 | LLM 300 s + SDK 2x; limitador 3 por chamada de ação (`scrapeURL.ts:109`) | **fallback**: a 1ª falha do `Promise.all` troca tudo por `chunks[0]` (`scrapeURL.ts:212-218`). Falha de scrape vira um resultado "Failed to fetch…" que pode ser citado (`scrapeURL.ts:230-237`) | idem |
| 8 | `src/lib/agents/search/widgets/weatherWidget.ts:58` | Widget de clima: extrai local ou lat/lon | chat | inline em `weatherWidget.ts:26-51` | não | 8192 | 0.2 | LLM 300 s + SDK 2x (Nominatim/Open-Meteo sem timeout) | **swallowed** em `widgets/executor.ts:26-28` | idem |
| 9 | `src/lib/agents/search/widgets/stockWidget.ts:56` | Widget de ações: extrai nome/ticker e ≤3 comparações | chat | inline em `stockWidget.ts:27-49` | não | 8192 | 0.2 | igual | **swallowed** (`executor.ts:26-28`) | idem |
| 10 | `src/lib/agents/search/widgets/calculationWidget.ts:40` | Widget de cálculo: extrai expressão mathjs | chat | inline em `calculationWidget.ts:15-33` | não | 8192 | 0.2 | igual | **swallowed** (`executor.ts:26-28`); erro do `mathEval` também | idem |
| 11 | `src/lib/agents/media/image.ts:32` | Reescreve a consulta para busca de imagens (`/api/images`; benchmark `media:images`) | chat | `src/lib/prompts/media/image.ts:3` + poucos exemplos `:10`: reescrita autônoma em `{query}` | não | 8192 | 0.2 | igual | **throw** → HTTP 500 (`src/app/api/images/route.ts:32-38`) | idem |
| 12 | `src/lib/agents/media/video.ts:31` | Reescreve a consulta para busca de vídeos (`/api/videos`) | chat | `src/lib/prompts/media/videos.ts:3` + poucos exemplos `:10` | não | 8192 | 0.2 | igual | **throw** → HTTP 500 | idem |
| 13 | `src/lib/agents/suggestions/index.ts:21` | Sugestões de perguntas seguintes (`/api/suggestions`, que o `useChat.tsx:515` chama quando há fontes) | chat | `src/lib/prompts/suggestions/index.ts:1`: 4-5 sugestões no idioma do usuário | não | 8192 | 0.2 | igual | **throw** → HTTP 500 (`src/app/api/suggestions/route.ts:32-38`) | idem |
| 14 | `src/lib/agents/search/researcher/actions/search/baseSearch.ts:269` | Ranqueamento speed/balanced: 1 `embedText([consulta, ...snippets])` por consulta com resultados | emb | — | não | — | — | slot `withEmbeddingSlot`: concorrência 3, **120 s** (`baseSearch.ts:63-69`, `src/lib/utils/limit.ts:46-51`) + SDK 600 s×3 | **fallback**: ordem do buscador + palavras-chave, `embeddingError` (`baseSearch.ts:314-348`) | n/a |
| 15 | `src/lib/agents/search/researcher/actions/search/baseSearch.ts:787` | Leitura de páginas no balanced (`bestPassages`): 1 `embedText([pergunta, ...≤40 trechos])` por página lida (readPages=2) | emb | — | não | — | — | slot de 120 s + `withTimeout` de 8 s por página (`baseSearch.ts:90,746-759,839-847`) | **fallback**: só palavras-chave (`baseSearch.ts:790-795`); timeout → fica só o snippet | n/a |
| 16 | `src/lib/uploads/store.ts:54` | Ação `uploads_search`: embedding das consultas | emb | — | não | — | — | **nenhum** além do SDK (600 s×3) ou do undici; **fora do slot** | **throw**: a falha sobe pela ação e derruba a busca. Dimensão diferente da do upload faz `computeSimilarity` lançar (`src/lib/utils/computeSimilarity.ts:2-3`) | n/a |
| 17 | `src/lib/uploads/manager.ts:116` | Upload de .txt: o documento inteiro num só `embedText` (pedaços de 512/128 tokens) | emb | — | não | — | — | nenhum além do SDK; **sem lotes** | **throw** → HTTP 500 (`src/app/api/uploads/route.ts:34-39`); confere a quantidade (`manager.ts:118-120`) | n/a |
| 18 | `src/lib/uploads/manager.ts:147` | Upload de PDF | emb | — | não | — | — | igual | igual | n/a |
| 19 | `src/lib/uploads/manager.ts:173` | Upload de DOCX | emb | — | não | — | — | igual | igual | n/a |

Fora da tabela (não são inferência): as ações MCP (`researcher/actions/mcp.ts:106`) chamam ferramentas, não LLM, e o erro vira texto citável (`mcp.ts:111-115`). `plan.ts` e `done.ts` não chamam nada. `writerContext.ts:55` e `researcher/index.ts:235` só leem a janela de contexto; no LM Studio isso faz um `fetch` de 3 s, uma vez por instância (`lmstudioLLM.ts:3,27-30`).

### Encoding de embedding (commit `050f357`): verificado

`src/lib/models/providers/openai/openaiEmbedding.ts:18` define `ENCODING_FORMAT = 'float'`, que vai em **`embedText` (`:37`) e em `embedChunks` (`:47`)**. Esse padrão chega a `LMStudioEmbedding`, `LemonadeEmbedding` e `GeminiEmbedding`, que só estendem a classe, e ao Bifrost (`bifrost/index.ts:58`). Ollama e Transformers não são afetados. O teste `openai/__tests__/openaiEmbedding.test.ts` passa (1/1, rodado agora).

Ressalva: arquivos enviados pelo LM Studio **antes** do commit foram salvos com vetores zerados em `*.content.json`. Para eles `computeSimilarity` devolve 0 (`computeSimilarity.ts:15-17`) até serem reenviados.

## 2. Chamadas por modo, numa busca típica

Premissas: só a fonte `web`, sem arquivos enviados, sem MCP e sem widgets. Cada widget marcado pelo classificador soma +1 `generateObject`, em paralelo à pesquisa. Parâmetros vêm de `src/lib/agents/search/effort.ts:22-26`: speed {2 iterações, readPages 0, fastPath}, balanced {6, 2, —}, quality {25, 0, —}. "Emb" conta chamadas `embedText`; cada uma carrega 1 consulta + ≤30/n resultados (`baseSearch.ts:43,204-207`).

| Modo | Classificador | Pesquisador (`streamText`) | Seletor | Extrator | Redator | **Total LLM** | **Emb** |
|---|---|---|---|---|---|---|---|
| speed, fast path (`researcher/index.ts:40-67,195-227`) | 1 | **0** | 0 | 0 | 1 | **2** | ≤3 (1 por consulta do classificador, ≤3) |
| speed, sem fast path (ou fast path sem resultados) | 1 | 1-2 (ex.: web_search, depois done) | 0 | 0 | 1 | **3-4** | ≤3 por web_search (≤6) |
| balanced (típico: 2 buscas + done) | 1 | 3 (máx. 6) | 0 | 0 | 1 | **5** (faixa 3-8) | por web_search: ≤3 consultas + ≤2 páginas = ≤5 → típico ≤10, máx. ≈30 |
| quality (típico: 6 buscas + done; o prompt pede "5-6 iterações", `webSearch.ts:77`) | 1 | 7 (máx. 25) | 1 por web_search com resultados = 6 | Σ pedaços das ≤3 páginas escolhidas (≈1-7 por página, ≤~21 por busca; típico ~5) ≈ 30 | 1 | **≈45** (máx. teórico: 1+25+25×(1+21)+1 ≈ 577) | **0** (o quality não usa embedding: `similarity: 1`, `baseSearch.ts:486-499`) |

Multiplicadores:
- Uma busca filtrada (recência ou domínio) com evidência fraca roda `runSearch` de novo sem o filtro (`baseSearch.ts:181-196`). Isso dobra os embeddings no speed/balanced e dobra **seletor + extratores** no quality.
- Várias tool calls na mesma iteração rodam em paralelo (`registry.ts:99`).
- O retry de "sem evidência" (`researcher/index.ts:380-419`) gasta uma das iterações.

Depois da resposta, a UI (`src/lib/hooks/useChat.tsx:507-515`) faz +1 `generateObject` de sugestões quando há fontes. Se a busca automática de mídia estiver ligada (`useChat.tsx:491-502`), soma +2 (imagens + vídeos).

## 3. Como cada provedor trata `GenerateOptions`

Só existem duas implementações de LLM: `OpenAILLM` e `OllamaLLM`. Anthropic, Gemini, Groq, LM Studio e Lemonade são `class X extends OpenAILLM {}` (o LM Studio só acrescenta `getContextWindow`), e o Bifrost instancia `OpenAILLM` direto.

| Provedor (baseURL) | temperature | topP | maxTokens | stop | penalidades | saída estruturada | raciocínio | timeout | uso (`src/lib/trace.ts:94` `reportUsage`) |
|---|---|---|---|---|---|---|---|---|---|
| **OpenAI** (`config.baseURL`, padrão `api.openai.com/v1`) | texto: `?? 1.0`; objeto: `?? 0.2` (1.0 em modelo de raciocínio) | `top_p` | texto: `max_completion_tokens` (indefinido); objeto: `max_completion_tokens`=opção, senão `max_tokens`=8192 (nenhum em modelo de raciocínio) | `stop` | `frequency_penalty`, `presence_penalty` | `response_format: zodResponseFormat` (json_schema estrito, `openaiLLM.ts:272`) + `parseModelJson` (tira cercas e repara, `utils/json.ts:21`) + `schema.parse`. `streamObject`: API Responses `text.format: zodTextFormat` (`:297-314`) | nada enviado. `isOpenAIReasoningModel` só altera temperatura e limite no `generateObject` | SDK `timeout`=LLM_TIMEOUT_MS (300 s até os headers), `maxRetries` 2 (padrão) | não streamado: `usage.prompt/completion/reasoning_tokens` + `reasoningChars`. Streamado: `stream_options.include_usage` **só quando `isUsageTracked()`** (benchmark, `:190`). `streamObject`: **nada** |
| **Anthropic** (`api.anthropic.com/v1`, compatível) | igual à OpenAI | igual | igual (`max_tokens` 8192 no objeto) | igual | igual (o endpoint compatível ignora) | igual; o endpoint compatível da Anthropic, ao que se sabe, ignora `response_format`, e aí tudo depende do prompt + `parseModelJson` | nada; o pensamento estendido vem desligado por padrão | igual | igual (sem `reasoning_tokens`) |
| **Gemini** (`generativelanguage.googleapis.com/v1beta/openai`) | igual | igual | igual | igual | igual | json_schema (aceito no endpoint compatível) | nada; Gemini 2.5 pensa por padrão (sem `reasoning_effort`) | igual | igual |
| **Groq** (`api.groq.com/openai/v1`) | igual | igual | igual | igual | igual | json_schema; **a ser confirmado**: a Groq só aceita `json_schema` em alguns modelos, e nos outros o `generateObject` falharia (o classificador derruba tudo) | nada; qwen3/gpt-oss raciocinam | igual | igual |
| **LM Studio** (`normalizeBaseURL(config)`) | igual (texto 1.0) | igual | objeto `max_tokens` 8192, que inclui os tokens de pensamento | igual | igual | json_schema (LM Studio aceita) | nada; o raciocínio vai em `reasoning_content` (descartado e contado em `reasoningChars`) ou entra inline no `content` como `<think>`, que o `parseModelJson` / a UI precisam tolerar (`src/lib/utils/citations.ts:45-56`) | igual; `getContextWindow` com fetch de 3 s | igual |
| **Lemonade** (`config.baseURL`) | igual | igual | igual | igual | igual | json_schema | nada | igual | igual |
| **Bifrost** (`${url}/v1` + headers, `bifrost/index.ts:46-47,54`) | igual; `openai/gpt-5*` e `o*` entram como raciocínio (a regex aceita prefixo `/`) | igual | igual | igual | igual | json_schema (repassado ao provedor de origem) | nada | igual | igual |
| **Ollama** (`config.baseURL`, padrão `localhost:11434`) | texto/`streamObject`: `?? 0.7`; `generateObject`: `?? 0.2` | `options.top_p` | `num_predict`: texto/`streamObject` indefinido; `generateObject` 8192. `num_ctx` sempre 32000/`OLLAMA_NUM_CTX` | `options.stop` | `options.frequency_penalty/presence_penalty` | `format: z.toJSONSchema(schema)` + `parseModelJson` + `schema.parse` | `think: false` se o nome do modelo contiver um item da lista (`ollamaLLM.ts:44-53`), **nos 4 métodos** | `fetchWithHeadersTimeout(300 s)` (`:68`), sem retentativa | `prompt_eval_count`, `eval_count`, `eval_duration`, `prompt_eval_duration`, caracteres de `thinking` (`:21-31`) em generateText/streamText (chunk final)/generateObject; `streamObject`: **nada** |
| Embeddings OpenAI-compat. (OpenAI, Gemini, LM Studio, Lemonade, Bifrost) | — | — | — | — | — | — | — | **sem timeout próprio** (SDK 600 s, 2 retentativas) | nada (o benchmark mede tempo e caracteres, `instrument.ts:244-272`) |
| Embedding Ollama / Transformers | — | — | — | — | — | — | — | nenhum | nada |

## 4. Inconsistências e bugs (arquivo:linha)

### Padrões e parâmetros

1. **`GenerateOptions` está morto na prática.** Nenhum `load*Model` passa `options` (`openai/index.ts:172-176`, `ollama/index.ts:89-91`, `lmstudio/index.ts:94-98`, `bifrost/index.ts:54`, …) e nenhum ponto de chamada passa `input.options`. Na prática, topP, stop e penalidades nunca vão para o servidor e nenhuma etapa tem temperatura ou limite próprios.
2. **`streamObject` diverge de `generateObject` nas duas classes.**
   - OpenAI (`openaiLLM.ts:294-331`):
     - usa a **API Responses** (`responses.stream`), que LM Studio, Lemonade, Groq, o endpoint compatível do Gemini e Anthropic em geral não implementam;
     - manda `input.messages` sem `convertToOpenAIMessages` (`:299`);
     - usa nomes de parâmetro que a API Responses não conhece (`max_completion_tokens`, `stop`, `frequency_penalty`, `presence_penalty`, `:302-310`; o correto seria `max_output_tokens`);
     - temperatura `?? 1.0`, sem `objectTemperature()`, sem `objectMaxTokens()` e sem tratar modelos de raciocínio;
     - não chama `reportUsage`.
   - Ollama (`ollamaLLM.ts:258-299`): temperatura 0.7 (`:272`) em vez de 0.2, sem limite `num_predict` (`:274`) e sem `reportUsage`.
   - Hoje não há chamadas a `streamObject` no app, mas `instrument.ts:171-186` o expõe.
3. **A temperatura padrão do texto difere por provedor.** OpenAI-compatível usa 1.0 (`openaiLLM.ts:116,179`); Ollama usa 0.7 (`ollamaLLM.ts:123,180`). O mesmo modelo local responde mais "quente" pelo LM Studio do que pelo Ollama, no pesquisador (chamada de ferramentas) e no redator.
4. **Pesquisador e redator não têm limite de saída** (`researcher/index.ts:275-284`, `index.ts:191-199`, `api.ts:130-138`). Ao mesmo tempo, o orçamento reserva 4000 e 3000/4000/6000 tokens (`src/lib/context/budget.ts:22-25`). Um modelo local preso em loop gera até encher o contexto. O comentário de `objectDefaults.ts:10-12` só protege o `generateObject`.
5. **O `generateObject` da OpenAI mistura dois campos** (`openaiLLM.ts:262-265`): com opção explícita manda `max_completion_tokens`, que o LM Studio e o Ollama compatível ignoram; com o padrão manda `max_tokens`. É inofensivo hoje (ver item 1), mas uma opção explícita perderia o limite nesses servidores.
6. **`isOpenAIReasoningModel` só é consultado no `generateObject`** (`openaiLLM.ts:247`). Modelos de raciocínio que não são da OpenAI (DeepSeek-R1, qwen3 e gpt-oss no LM Studio, Groq ou Bifrost) recebem temperatura 0.2 e limite de 8192, que conta os tokens de pensamento. O pensamento nunca é desligado fora do Ollama, que é a causa do achado "raciocínio oculto" no `src/lib/benchmark/analyze.ts:638-650`.
7. **A lista de `think:false` do Ollama é por substring e incompleta** (`ollamaLLM.ts:44-53,117,173,224,266`). Ficam de fora qwq, cogito, phi4-reasoning e exaone-deep, entre outros. O gpt-oss, ao que se sabe, não desliga com `think:false` (aceita só níveis). O app não oferece como configurar isso.

### Timeouts

8. **Embeddings OpenAI-compatíveis não têm timeout próprio** (`openaiEmbedding.ts:25-29`). O LLM usa `timeout: llmTimeoutMs()` (`openaiLLM.ts:63`); o embedding fica no padrão do SDK, 600 s com 2 retentativas, o que dá até ~30 min. Na busca, o slot corta em 120 s.
9. **Uploads e `uploads_search` ficam fora do slot de embedding** (`manager.ts:116,147,173`, `store.ts:54`): sem limite de concorrência e sem timeout, num cenário conhecido por dar 502 no Ollama (comentário em `baseSearch.ts:56-62`).
10. **Embedding do Ollama não tem `fetchWithHeadersTimeout`** (`ollamaEmbedding.ts:17-19`), diferente do LLM (`ollamaLLM.ts:66-69`).
11. **O timeout do slot de embedding libera a vaga sem abortar a requisição** (`src/lib/utils/limit.ts:47-51`). A chamada antiga continua rodando no servidor, então a concorrência real pode passar de `EMBEDDING_CONCURRENCY`=3. O mesmo acontece com o `withTimeout` de 8 s da leitura de página (`baseSearch.ts:746-759`): resolve `undefined` e deixa o scrape e o embedding em andamento.
12. **O limitador do extrator é por chamada, não global** (`baseSearch.ts:679`, `scrapeURL.ts:109`), ao contrário do de embedding (`baseSearch.ts:67`). Com várias `web_search` paralelas na mesma iteração, com `scrape_url` junto, ou com duas conversas ao mesmo tempo, o servidor local recebe 3×N extratores simultâneos. Não há `timeoutMs` no limitador.
13. **Nenhuma chamada recebe `AbortSignal`.** `GenerateTextInput`/`GenerateObjectInput` não têm `signal` (`models/types.ts:55-81`). Fechar a aba (`src/app/api/chat/route.ts:235-240`) não interrompe pesquisador, extratores nem redator. Isso é intencional para permitir o `/api/reconnect`, mas também acontece em `/api/search` e no benchmark.

### Erros engolidos, propagados ou inconsistentes

14. **Uma falha do seletor do quality derruba a resposta inteira** (`baseSearch.ts:586-600`, sem try/catch). A falha sobe pelo `Promise.all` de `registry.ts:99`. Os extratores logo abaixo engolem os erros, e a assimetria não tem justificativa.
15. **Uma falha do classificador derruba a resposta inteira** (`classifier.ts:45`, `index.ts:94-99`), sem fallback do tipo "buscar com a pergunta original". Já os widgets engolem os erros (`widgets/executor.ts:26-28`).
16. **Um nome de ferramenta inventado pelo modelo derruba a busca** (`researcher/actions/registry.ts:81-83` lança; `executeAll` usa `Promise.all`, `:99`), quando bastaria devolver um erro como resultado da ferramenta.
17. **O parse dos argumentos de tool call pode lançar sem tratamento**: `JSON.parse` no `generateText` (`openaiLLM.ts:144`) e o `partial-json` `parse` no `streamText` (`:219,230`) com JSON malformado de modelos pequenos. A exceção encerra o stream e a busca.
18. **O extrator do quality engole erros e deixa fontes vazias.** Uma página com todos os pedaços falhando entra em `extractedFacts` com `content: ''` (`baseSearch.ts:692,718-728`) e vira uma fonte citável sem conteúdo. Os fatos também são concatenados na ordem em que as chamadas terminam, não na ordem da página (`:718`).
19. **O fallback do `scrape_url` descarta trabalho feito**: a 1ª falha troca tudo por `chunks[0]` (`scrapeURL.ts:212-218`), perde os fatos já extraídos dos outros pedaços e deixa as outras chamadas rodando. Erros de scrape (`:230-237`) e de MCP (`mcp.ts:111-115`) viram "fontes" citáveis com texto de erro.
20. **Os prompts do extrator são duplicados e já divergem.** `scrapeURL.ts:9-41` não tem a frase sobre a pergunta do usuário que `baseSearch.ts:638` tem, e manda `<queries>Summarize</queries>` sem `<question>` (`scrapeURL.ts:201`), embora `additionalConfig.question` esteja disponível.
21. **O embedding de uploads não registra o modelo usado.** Trocar o modelo de embedding nas configurações faz `computeSimilarity` lançar "Vectors must be of the same length" (`computeSimilarity.ts:2-3`) dentro de `store.query` (`store.ts:54-69`), e a busca inteira cai. Uploads antigos do LM Studio, de antes do `050f357`, estão zerados e dão similaridade 0 sem aviso.
22. **O upload manda o documento inteiro numa só requisição de embedding** (`manager.ts:115-116`, `146-147`, `172-173`). Um PDF grande pode passar dos limites de entradas ou tokens por requisição (OpenAI: 2048 entradas) e do timeout. Documento vazio → `embedText([])` → erro 400.

### Ids e índices de tool call

23. **Ids de tool call podem colidir e juntar chamadas distintas.**
    - No `streamText` da OpenAI, `id: tc.id!` (`openaiLLM.ts:213`) fica `undefined` em servidores que não mandam id. O pesquisador agrupa por `ftc.id === tc.id` (`researcher/index.ts:344-352`), então várias chamadas sem id viram uma só.
    - Ainda no `streamText`, o código assume que `tc.index` é sequencial a partir de 0 (`openaiLLM.ts:210-222`). Um provedor que omite `index` cria uma chamada duplicada a cada chunk.
    - No Ollama, o id é `sha256(i-nome)` (`ollamaLLM.ts:202-207`): duas `web_search` em chunks separados, ambas com i=0, recebem o mesmo id e a segunda sobrescreve a primeira.
24. **O `generateText` do Ollama manda só `properties` como `parameters`** (`ollamaLLM.ts:108`), sem `type`/`required`. O `streamText` manda o schema completo (`:164`). Hoje não há chamadas a `generateText` no app.
25. **`done` no `streamText` da OpenAI** é `finish_reason !== null` (`openaiLLM.ts:234`). Servidores que mandam `undefined` marcam todo chunk como `done`. Hoje ninguém lê esse campo.

### Medição e caminhos duplicados

26. **Uso e rótulos no benchmark.** `stream_options.include_usage` só é pedido no benchmark (`openaiLLM.ts:190`), o que é intencional. Seletor e extratores não têm `withTraceLabel` próprio e herdam o rótulo `researcher` (`api.ts:52`), então o benchmark não os separa. O caminho da UI (`index.ts`) não tem rótulo nenhum.
27. **Os dois redatores divergem.** `api.ts` não chama `sanitizeCitations` (`index.ts:235-244` chama) e usa contexto `''` quando não há busca (`api.ts:95`), enquanto `index.ts:158-159` usa o marcador `<Query to be answered without searching; Search not made>`. O benchmark mede o caminho da API, não o da UI.
28. **O seletor do quality manda `JSON.stringify(result)` com metadados internos** (`baseSearch.ts:595`): `similarity: 1`, `embedding: []` e `publishedDate`. São tokens a mais num prompt que já leva até ~30 resultados.
