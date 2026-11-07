# Estudo da Perplexity por fontes públicas (Fase 2 da auditoria)

Data: 07/11/2026. Escopo: o que a Perplexity publica sobre produtos, API, arquitetura, qualidade e latência, e o que isso significa para o Vane. Ponto de partida: `comparacao-perplexity/relatorio.md` (06/11/2026, seções 2 e 2A). Cada afirmação desse relatório que entrou aqui foi conferida de novo; as correções estão marcadas com **(corrigido)**.

Só fontes públicas: documentação em `docs.perplexity.ai`, blog e research hub, Help Center, changelog, GitHub `perplexityai`, Hugging Face `perplexity-ai`, artigos de parceiros e entrevistas. Não houve acesso a áreas logadas nem tentativa de extrair prompts ou código interno.

**Legenda de confiança** (vale para cada linha):
- **F**: fato, fonte oficial da Perplexity (docs, blog, changelog, repositório).
- **P**: fato de fonte pública não oficial (parceiro, entrevista, imprensa).
- **I**: inferência ou especulação (minha ou de terceiros). Usar como direção, não como fato.

Números de desempenho, qualidade e custo são **autodeclarados** pela Perplexity, inclusive os medidos com o harness que ela mesma publica.

---

## 1. Resumo

1. **F** A API foi reorganizada em 2026 em cinco produtos: Agent API (resposta com busca e citações), Search API (resultados ranqueados sem resposta), Embeddings, Decisions (probabilidades) e Orchestrator (prévia privada). A Sonar Chat Completions virou Agent API em julho de 2026 e está obsoleta. [changelog][cookbook-repo]
2. **F** O Agent API funciona por **níveis de esforço** versionados (`fast` a `xhigh`, mais `ultra` desde 06/11/2026). Cada nível é um pacote de modelo, passos, raciocínio, orçamento de busca em tokens e ferramentas, e o cliente pode sobrescrever qualquer campo. [effort][pplx-changelog-1106]
3. **F** A busca roda sobre índice próprio (mais de 200 bilhões de URLs) e, desde set/2026, sobre o **Photon**, motor léxico em Rust feito do zero (p99 de recuperação e ranking caiu de ~800 ms para ~65 ms). O que vai ao modelo são **trechos da página já extraídos e cortados por orçamento de tokens**, não o snippet curto. [search-arch][photon]
4. **F** O "Fast Search" (set/2026) virou o padrão de todos os níveis e custa 40% do preço da busca padrão; num teste interno com 3.554 tarefas, a qualidade agregada ficou igual (64,3% contra 64,0%) e o custo total caiu 68%. [changelog][photon]
5. **F** O `search_evals` (MIT) mudou na versão 0.2.0 (02/06/2026): antes media **APIs de busca** dentro de dois agentes padrão (SimpleQA, FRAMES, SEAL); agora mede **sistemas inteiros** (BrowseComp, DSQA, HLE, WideSearch). A versão 0.1 é a que mais serve ao Vane. [search-evals][search-evals-v01]

---

## 2. Produtos e APIs

### 2.1 Mapa (índice `llms.txt`)

| Produto | Endpoint | Estado | Fonte |
|---|---|---|---|
| Agent API | `POST /v1/agent` (alias `/v1/responses`) | GA desde fev/2026; endpoint canônico desde mar/2026 | **F** [agent-qs][changelog] |
| Search API | `POST /search` | GA; Fast Search desde set/2026 | **F** [search-qs] |
| Embeddings API | SDK `embeddings.create`, mais contextualizados | lançado em fev/2026 | **F** [emb-qs] |
| Decisions API | `POST /v1/decisions` | lançado em out/2026 | **F** [decisions] |
| Orchestrator API | `https://api.perplexity.ai/orchestrator/v1` | **prévia privada**, acesso por e-mail | **F** [orch-qs] |
| MCP Server remoto | `https://api.perplexity.ai/mcp` | jul/2026; OAuth em set/2026 | **F** [changelog][mcp-repo] |
| Batch API | JSONL, até 50.000 pedidos | nov/2026 | **F** [pplx-changelog-1106] |
| Outros | Files, Skills, Profiles, Computer MCP, Analytics, Audit, CLI `pplx` | — | **F** [llms] |

### 2.2 Search API (resultados ranqueados, sem resposta gerada)

- **F** `query` aceita uma string ou **até 5 queries** numa só chamada, processadas de forma independente; é cobrada como 1 pedido, mas gasta 5 unidades do limite. [search-qs][ratelimits]
- **F** `max_results` vai de 1 a 20 (padrão 10). No `web_search` do Agent API, vai de 1 a 50. **(corrigido: o relatório anterior dava 1 a 50 para os dois.)** [search-qs][web-search]
- **F** Orçamento de conteúdo em tokens: `max_tokens` (total, até 1.000.000) e `max_tokens_per_page`. Cada resultado traz `title`, `url`, `snippet` (texto extraído da página, pode vir vazio), `date` e `last_updated`. [search-qs]
- **F** Filtros: `search_domain_filter` (até 20 domínios, permitir **ou** bloquear com prefixo `-`, sem misturar; aceita caminho para limitar a uma seção do site), `search_language_filter` (ISO 639-1, até 20), `country` (ISO 3166-1). [search-qs][domain-filter]
- **F** Filtros de data: `search_recency_filter` (`hour`, `day`, `week`, `month`, `year`), `search_after_date_filter` / `search_before_date_filter` (publicação) e `last_updated_after_filter` / `last_updated_before_filter` (atualização), no formato `%m/%d/%Y`. Publicação e atualização são filtros distintos. [date-filters]
- **F** `search_type: "fast"` reduz latência e custo. [search-qs][fast-search]
- **F** O SDK `perplexity-search-sdk` (Apache-2.0, núcleo compilado fechado) expõe também `content.snippets(query, urls)`: **trechos relevantes à pergunta de URLs que o cliente já tem**. [search-sdk]

### 2.3 Agent API (busca, raciocínio, ferramentas e citações)

- **F** Corpo: `model` ou `models` (lista de até 5 para fallback, cobrança só do modelo que atendeu), `effort`, `input`, `instructions`, `tools`, `max_steps`, `max_output_tokens`, `reasoning.effort` (`minimal` a `max`), `response_format`, `background`, `stream`, `previous_response_id`. [agent-qs][fallback][effort]
- **F** Ferramentas: `web_search`, `fetch_url`, `image_search` (out/2026), `finance_search` (mai/2026), `people_search`, `sandbox` (execução de código em VM, sessão de 20 min), MCP e conectores com `require_approval` (out/2026), funções customizadas, Skills. [tools-overview][changelog][pricing]
- **F** `web_search` aceita `filters` (os mesmos da Search API), `user_location` (país, região, cidade, lat/long), `max_results`, `max_tokens`, `max_tokens_per_page`. **O `max_results` é um total por chamada, dividido entre as queries reformuladas, cerca de `ceil(max_results / n_queries)` cada.** [web-search]
- **F** Saída: itens `search_results` (com `queries` e `results[]`: `id`, `url`, `title`, `snippet`, `date`, `last_updated`, `source`), `fetch_url_results`, `message` (`output_text`), mais itens de MCP, sandbox e skill. O `usage` traz tokens e `cost`. [agent-qs][sdk-py]
- **F** Anexos: imagens e, desde out/2026, PDF, DOC, DOCX, TXT e RTF como `input_file`. [changelog]
- **F** Compatibilidade OpenAI: `/v1/responses` e `GET /v1/models` (abr/2026). [changelog]

### 2.4 Níveis de esforço (estado em 07/11/2026)

**F** Tabela da página de esforço, versão ativa `fast@2026-10-16.0` no exemplo. [effort]

| Nível | Modelo | Passos máx. | Raciocínio | Saída máx. | Ferramentas e orçamento |
|---|---|---|---|---|---|
| fast | gpt-6-luna (fallback gpt-5.6-luna), tier `priority` | 1 | none | 8.192 | web_search fast, 10 resultados, sem chamadas paralelas |
| low | gpt-6-luna | 5 | minimal | 128.000 | web_search fast (15 resultados, 4.000 tokens no total e por página) + fetch_url (1 URL, 10.000 tokens) |
| medium | gpt-6-luna | 15 | medium | 128.000 | igual ao low |
| high | gpt-6.1-terra | 40 | medium | 128.000 | igual ao low; até 40 chamadas de ferramenta com lembretes de orçamento |
| xhigh | claude-opus-5-5 (fallback gpt-6.1-sol) | 300 | high | 512.000 | web_search fast, finance_search, sandbox; compactação de contexto a partir de 150.000 tokens |
| ultra | claude-opus-5-5 | não documentado | — | — | **três agentes em paralelo**; roda em segundo plano |

- **(corrigido)** O relatório anterior trazia `high` = gpt-6-sol com 15 passos, `xhigh` com 100 passos e `low` com saída de 32k. A página atual mostra 40, 300 e 128.000. O changelog de 06/11 anuncia "níveis mais baratos com qualidade igual ou maior" e o `ultra`. **F** [effort][pplx-changelog-1106]
- **F** Três modos de uso: dinâmico (`effort="low"`, recebe atualizações), fixado (`low@<versão>`) e congelado (copiar os campos e omitir `effort`). Campo passado junto com `effort` sobrescreve só aquele campo; `tools` se mesclam por ferramenta. **As atualizações mantêm a faixa de custo e latência; o que muda é a qualidade.** [effort]
- **F** Cada nível usa um `prompt_cache_key` estável (ago/2026, economia de ~5%). [effort][changelog]
- **F** Configurações internas do nível (lembretes de passos, orçamento de `fetch_url`, extração com gpt-6-luna, `grep` desligado, compactação) não estão no schema público; uma configuração congelada não as herda. [effort]

### 2.5 Citações

- **F** O texto traz marcadores entre colchetes ligados ao `id` do resultado. O formato depende do nível: `[1]` no `fast`, `[web:1]` no `low`/`medium`/`high` (citações tipadas por fonte desde jul/2026). Os `annotations` vêm vazios nos exemplos. [agent-qs][streaming-cit][changelog]
- **F** O modelo só cita se o prompt pedir. A documentação manda **tratar o `id` e a `url` do resultado como fonte da verdade** e não confiar em URL escrita pelo modelo, nem dentro de JSON estruturado. [web-search][output-control]

### 2.6 Streaming

- **F** Tipos de evento no SDK oficial: `response.created`, `response.in_progress`, `response.output_item.added/done`, `response.reasoning.started`, `response.reasoning.search_queries`, `response.reasoning.search_results`, `response.reasoning.fetch_url_queries`, `response.reasoning.fetch_url_results`, `response.reasoning.stopped`, `response.output_text.delta/done`, `response.skill.loaded`, `response.completed`, `response.failed`; em segundo plano também `response.paused` e `response.resumed`. [sdk-py][background]
- **F** `search_results` chega uma vez por busca; em modos de vários passos esses eventos se espalham pelo stream. Um marcador `[n]` pode vir partido entre dois deltas, então a análise deve ser feita sobre o texto acumulado. [streaming-cit]
- **F** Se as fontes precisam aparecer na UI imediatamente, a documentação recomenda o modo sem streaming. [output-control]

### 2.7 Saída estruturada

- **F** Só JSON Schema (`response_format.type = "json_schema"`, `name` de 1 a 64 caracteres). Campos em `required` sempre vêm; os outros podem vir `null`. **Um schema novo leva de 10 a 30 s para ser preparado na primeira chamada**; as seguintes não pagam isso. Citar a estrutura esperada no prompt melhora a aderência. [output-control]

### 2.8 Tarefas assíncronas e pesquisa profunda

- **F** `background: true` devolve o objeto na hora; estados `queued` → `in_progress` → `completed` / `failed` / `cancelled` / `incomplete`. Quando a organização bate o limite de tokens, a resposta fica `in_progress` com um objeto `paused` e retoma sozinha. [background]
- **F** Reconexão do stream: `GET /v1/agent/{id}?stream=true&starting_after=N` pelo `sequence_number`; depois da janela de reconexão, 400 e fallback para o `GET` simples. Cancelamento assíncrono em `POST /v1/agent/{id}/cancel`. Arquivos gerados são listados e baixados por endpoints próprios. [background][llms]
- **F** O guia de pesquisa profunda e o MCP mapeiam `perplexity_research` para um nível de esforço alto; o `ultra` roda em segundo plano. [async-dr][mcp-repo][effort]
- **F** Batch API (nov/2026) processa até 50.000 pedidos do Agent API por arquivo JSONL. [pplx-changelog-1106]

### 2.9 Decisions API

- **F** Recebe `state` (texto, objeto ou lista, imagens como `image_url`) e de 1 a 128 perguntas nomeadas de três tipos: sim/não (probabilidade de "sim"), múltipla escolha (até 255 opções, probabilidade por opção e `confidence`) e rubrica (até 10 níveis, nota esperada ponderada). [decisions]
- **F** Modelos `pplx-decider-v1.2` (27B, US$ 0,02/1M tokens de entrada) e `pplx-decider-flash-v1.2` (4B, US$ 0,01); saída grátis; contexto de 256K; o v1.2 responde todas as perguntas numa passada, o Flash cobra o `state` por pergunta. Limite padrão de 10 req/s. [decisions][pricing]
- **F** A página não promete calibração formal: pedidos idênticos às vezes variam na segunda casa decimal, então o limiar deve ter folga. **(corrigido: o pedido falava em "probabilidades calibradas".)** [decisions]
- **F** Os pesos dos deciders estão no Hugging Face, inclusive em GGUF (`pplx-decider-flash-gguf-v1.2`). A licença não foi conferida. [hf]
- **F** Desde 06/11/2026 há "web grounding": uma busca antes de decidir. A página de início rápido ainda diz que a API não busca URLs. [pplx-changelog-1106][decisions]
- **F** Exemplos do cookbook: juiz de precisão de citação, filtro de ações de agente, triagem de tickets, escolha da melhor citação num conjunto de resultados. [llms]

### 2.10 Embeddings API

- **F** API: `pplx-embed-v1-0.6b` (1.024 dims, US$ 0,004/1M) e `-4b` (2.560 dims, US$ 0,03/1M); contextualizados `pplx-embed-context-v1-0.6b` / `-4b` (US$ 0,008 e 0,05). Contexto de 32K, mean pooling, sem prefixo de instrução, Matryoshka, saída `base64_int8` ou `base64_binary` (não normalizada: cosseno no int8, Hamming no binário). Até 512 textos e 120.000 tokens por pedido. [emb-qs][pricing]
- **F** Contextualizado = trechos do mesmo documento embutidos juntos, para cada vetor levar o contexto do documento. [emb-qs][ctx-emb]
- **F** Pesos abertos v2 no Hugging Face (nov/2026): `pplx-embed-v2-context-0.6b/9b` e `pplx-embed-v2-late-0.6b/9b`, para texto e imagem. A licença dos pesos não foi conferida. [hf][pplx-changelog-1106]
- **F** Técnica do v2-context: destilação a partir do modelo de compressão de contexto deles (nota por token, agregada por trecho), late chunking num único forward de até 32.768 tokens. Nos testes, o tamanho do trecho pouco importou (nDCG@10 de 81,0% com 64 tokens para 79,9% com 512). [ctx-emb]
- **I** O relatório anterior dizia "base Qwen3"; não achei isso nas páginas lidas agora. Fica como não verificado.

### 2.11 Orchestrator API

- **F** **Prévia privada** (pedir acesso por e-mail). Modelos open-weight hospedados pela Perplexity atrás de um endpoint que fala OpenAI Chat Completions, OpenAI Responses (sem estado) e Anthropic Messages; qualquer modelo em qualquer formato. Cobrança por token na tabela do modelo; 429 não é cobrado. [orch-qs][pricing]
- **F** Roteamento: pesos por implantação, ajustados continuamente por taxa de erro, capacidade e latência medidas no tráfego real (não há probe de saúde separado). Conversas de vários turnos ficam na mesma implantação para aproveitar o cache de prompt. [orch-routing]
- **F** Failover em erro do provedor, rate limit ou timeout (há limite de **tempo até o primeiro token** e de duração total por tentativa). Erros determinísticos (400) não se repetem. Falha antes do primeiro token é invisível ao cliente; falha depois dele encerra o stream com erro na própria linha. [orch-routing]

### 2.12 Preços e limites

**F** Preços (página de preços, 07/11/2026). [pricing]

| Item | Preço |
|---|---|
| `web_search` padrão / fast | US$ 2,50 / US$ 1,00 por mil chamadas |
| `fetch_url` | US$ 0,0005 por chamada |
| `image_search` | US$ 2,50 por mil chamadas bem-sucedidas |
| `people_search`, `finance_search` | US$ 5 por mil |
| `sandbox` | US$ 0,03 por sessão de 20 min; buscas dentro dela a US$ 0,0025 |
| Search API padrão / fast | US$ 5,00 / US$ 1,00 por mil pedidos **(corrigido: o relatório anterior dava US$ 1 a 2,50)** |
| Tokens de modelo | tabela por modelo; `flex` 0,5× e `priority` 2× quando o modelo tem o tier |

**F** Limites: Agent API de 1 a 33 req/s conforme o tier de gasto acumulado (US$ 0 a 5.000+), mais TPM e TPH por modelo; Search API com 50 unidades/s (balde furado) igual para todos; Embeddings de 85 a 335 req/s. Resposta 429 traz `Retry-After` e um `error.type` que distingue limite de pedidos, de tokens e `overloaded` (capacidade do modelo, que pede fallback). [ratelimits]

### 2.13 SDKs (perplexity-py e perplexity-node)

- **F** Gerados pelo Stainless a partir do OpenAPI (14 endpoints). Python 0.46.1, Node 0.41.0, ambos Apache-2.0. [sdk-py][sdk-node]
- **F** Erros: `APIConnectionError`, `APITimeoutError`, `APIStatusError` com subclasses por código (400, 401, 403, 404, 422, 429 `RateLimitError`, ≥500 `InternalServerError`). [sdk-py]
- **F** Repetição automática **2 vezes** com backoff exponencial curto em erro de conexão, 408, 409, 429 e ≥500 (`max_retries` / `maxRetries`); timeout padrão de **15 minutos**, e timeout também é repetido. [sdk-py][sdk-node]
- **I** O padrão "repetir 408/409/429/5xx com backoff e respeitar `Retry-After`" é o mesmo da OpenAI; serve de régua para os clientes HTTP do Vane.

---

## 3. Arquitetura conhecida

### 3.1 Fluxo de resposta

```
pergunta + histórico → ① entendimento e roteamento (nível de esforço, modelo)
  → ② plano e queries (Pro/pesquisa) → ③ recuperação híbrida no índice próprio
  → ④ ranking em estágios, no nível de trecho → ⑤ fetch_url só se faltar
  → ⑥ contexto: trechos numerados com id, url, data, dentro de orçamento em tokens
  → ⑦ geração com [n] → ⑧ fontes, texto, mídia, passos, perguntas relacionadas
```

| Etapa | O que se sabe | Grau | Fonte |
|---|---|---|---|
| ① Roteamento | O nível de esforço fixa modelo, passos, raciocínio, orçamento e ferramentas antes da busca; na Sonar havia `search_type: "auto"` | F | [effort][changelog] |
| ① Roteamento | Há um classificador leve de complexidade e de sensibilidade a tempo | I | [aiep] |
| ① Produto | O modo "Best" escolhe o modelo pelo tipo de pergunta | F | [help-pro] |
| ② Plano | Pro Search separa plano e execução: plano em etapas, cada etapa gera queries, o resultado alimenta a etapa seguinte | P | [langchain] |
| ② Queries | Queries curtas, com termos que aparecem nas páginas-alvo; o modelo refina e busca de novo dentro do loop; as queries usadas voltam em `search_results.queries` | F | [search-bp][agent-qs] |
| ③ Índice | Mais de 200 bi de URLs, escala de exabytes, recrawl agendado por ML (importância × frequência de atualização), camadas quente e fria | F | [search-arch] |
| ③ Parsing | Regras por site, avaliação contínua por LLM (completude e qualidade) e correção automática das classes de erro mais comuns | F | [search-arch] |
| ③ Trechos | Documento quebrado em spans autocontidos, recuperados e ranqueados sozinhos; tamanho não publicado | F | [search-arch] |
| ③ Armazenamento | CobbleDB guarda por URL os trechos já cortados e o embedding de cada trecho | F | [cobbledb] |
| ③ Recuperação | Índice léxico e semântico, união pensada para recall, pré-filtro de conteúdo irrelevante ou velho | F | [search-arch] |
| ③ Photon | Motor léxico em Rust, broker → shards, WAND, cobertura de termos relaxada se houver poucos candidatos | F | [photon] |
| ③ Histórico | Antes do Photon, um fork de motor open source não nomeado; o Vespa publicou estudo de caso com a Perplexity | F/P | [photon][vespa] |
| ③ Histórico | Esse fork era o Vespa | I | [photon][vespa] |
| ④ Ranking | Pontuadores léxicos e de embedding baratos, depois cross-encoder, em documento e em trecho | F | [search-arch] |
| ④ Sinais | Cada resposta gerada serve de dado de qualidade, junto com avaliação por IA e feedback humano | F | [search-arch] |
| ④ Re-busca | Corte de qualidade com descarte e nova busca quando poucos candidatos passam | I | [aiep] |
| ⑤ Leitura | `fetch_url` é exceção: 1 URL e 10.000 tokens nos níveis low a high; o `snippet` já traz o texto extraído | F | [effort][search-qs] |
| ⑥ Contexto | Orçamento de trechos em tokens por página e no total | F | [web-search] |
| ⑦ Geração | Prompt guide: instruções curtas (são relidas a cada passo), permissão para admitir lacunas, avisar quando a fonte fala de algo próximo mas diferente | F | [prompt-guide] |
| ⑦ Geração | Prompts curtos, poucos exemplos, um prompt ajustado por modelo | P | [langchain] |
| ⑧ Entrega | Fontes em evento próprio, normalmente antes do texto; mídia por classificador (Sonar, dez/2025) | F | [streaming-cit][changelog] |

### 3.2 Infraestrutura de inferência

- **F** Motor de inferência próprio, **ROSE**, em GPUs Hopper e Blackwell; serve LLMs, ranking, classificação e embeddings com os mesmos kernels; tem decodificadores especulativos e MTP. [cutedsl][gptoss][fast-emb]
- **F** Prefill e decode desagregados: ~100 ms a mais no TTFT de cada pedido em troca de decode estável (antes, uma implantação R1 não passava de 50 TPS por causa das interrupções de prefill). [disagg]
- **F** `fabric-lib` (RDMA ponto a ponto, artigo do MLSys'26) e transferência de pesos para RL em menos de 2 s, no `pplx-garden`. [garden]
- **F** Computer roda 100% local no Mac (nov/2026) com Qwen 3.6 e "PPLX Pro" (Qwen pós-treinado); recomenda 36 GB ou mais. [local-mac]
- **F** SPACE, a plataforma de sandbox do Computer (microVMs com pausa, checkpoint e ramificação de sessão), foi aberta em 15/10/2026 sob Apache-2.0. [space]

---

## 4. Técnicas de qualidade

1. **Trecho como unidade de busca e de contexto** (F [search-arch][cobbledb]). A página é cortada e embutida trecho por trecho no momento da indexação, não da pergunta. O modelo recebe os melhores trechos dentro de `max_tokens_per_page`.
2. **Recuperação híbrida com recall primeiro e ranking em cascata** (F [search-arch]). O benchmark Q2D-Web deles mede só o primeiro estágio (Recall@1000) e deixa a ordem final para o reranker. Lá, BM25 puro tem Recall@1000 de 45,25, contra 57 a 70 dos modelos densos. [q2d]
3. **Fusão RRF para juntar listas** (F [q2d]). O Q2D-Web usa RRF para unir BM25, ColBERTv2 e densos na formação do pool.
4. **Avaliação do parser por LLM com correção automática** (F [search-arch]).
5. **Orçamento de resultados dividido entre queries** (F [web-search]). Mais queries trazem mais diversidade, não mais volume.
6. **Datas de publicação e de atualização em cada resultado**, com filtros separados (F [date-filters]).
7. **Citação ligada a `id` estável, com URL vinda dos metadados** (F [web-search]). A verificação posterior usa um juiz (cookbook "Judge Citation Accuracy with Decisions API"). (F [llms])
8. **Prompt curto, honesto sobre lacunas, ajustado por modelo** (F [prompt-guide], P [langchain]).
9. **Presets versionados sob a mesma faixa de custo e latência** (F [effort]). Isso permite melhorar a qualidade sem quebrar o contrato com o cliente.
10. **Aprendizado com produção** (F [rwe]). Correções do usuário, erros de ferramenta e julgamento por dois LLMs viram dados de RFT e autodestilação. Os erros de ferramenta caíram 21% a 33% online. Isso vale para o agente Computer, não para o motor de respostas.
11. **Avaliação regressiva** (F [llms][agent-eval-blog]). Os guias "Turn Agent Failures into Regression Tests" e "How to evaluate AI agents" pedem conjunto de teste, graders e checagens de regressão.
12. **Embeddings contextuais** (F [ctx-emb]). Recomendação: recuperar também os trechos de evidência ao redor da resposta, ter um índice por documento como linha de base e medir no próprio corpus.

---

## 5. Técnicas de latência

| Técnica | Número publicado | Grau | Fonte |
|---|---|---|---|
| Nível `fast`: 1 passo, sem raciocínio, tier `priority` (2× preço), sem chamadas paralelas | — | F | [effort] |
| Fast Search: p50 de 160 ms e p95 de 230 ms numa chamada; custo 40% menor | 160 / 230 ms | F | [photon][pricing] |
| Photon no lugar do motor antigo: p99 de recuperação + ranking de ~800 ms para ~65 ms; aquecimento de cache com queries reais repetidas antes de voltar ao roteamento | 800 → 65 ms | F | [photon] |
| Search API em set/2025 (de us-east-1) | p50 358 ms, p95 763 ms | F | [search-arch] |
| CobbleDB: leitura em lote de 10 a 15 chaves, `MultiGet`, réplica na mesma zona, **hedging** (repete a leitura lenta em outra réplica e fica com a primeira resposta) | p50 31,4 → 5,6 ms | F | [cobbledb] |
| Texto da página pré-extraído e pré-embutido na indexação (nada de baixar página na hora da pergunta) | — | F | [cobbledb][search-qs] |
| Cache de prompt com chave estável por nível | ~5% de custo | F | [effort][changelog] |
| Afinidade de implantação para reaproveitar o cache de prompt; failover por timeout de TTFT | — | F | [orch-routing] |
| Fallback de modelo em lista (até 5) | — | F | [fallback] |
| Prefill/decode desagregados, decodificação especulativa e MTP | +100 ms TTFT, decode estável | F | [disagg][gptoss] |
| Embeddings online servidos com kernels de decode; sobreposição CPU/GPU com LazyTensor | — | F | [fast-emb] |
| Compactação de contexto em segundo plano no Computer | −94% de pausas | F | [pplx-changelog-1106] |
| Fontes mostradas antes do texto e o plano visível tornam a espera mais aceitável | — | P | [langchain] |
| Schema JSON novo custa de 10 a 30 s na primeira vez (cachear o schema) | 10–30 s | F | [output-control] |

---

## 6. Funcionalidades do produto (consumidor)

| Funcionalidade | Estado público | Grau | Fonte |
|---|---|---|---|
| Modos: Search/"Best", Pro Search (dezenas de fontes, escolha de modelo), Reasoning, Research (Deep Research, "Advanced Deep Research"), "Create files and apps" (antigo Labs) | ativos | F | [help-pro][help-features] |
| Focos → "Choose sources": Web, Academic, Finance, Files, social; no Enterprise, Web / Org Files / os dois / nenhum | ativos | F | [help-pro][help-features] |
| Follow-ups com contexto; perguntas relacionadas | ativos | F | [help-pro] |
| Spaces → **Projects** (30/07/2026): instruções, arquivos, conectores, domínios priorizados, modelo padrão, memória Brain; 50 arquivos no Pro e até 5.000 no Enterprise Max | ativos | F | [projects][help-projects] |
| Pages (página publicável a partir de uma pesquisa) | ativo | F | [help-features] |
| Memory e Brain (memória que se atualiza sozinha; Brain for Projects gratuito desde nov/2026) | ativos | F | [pplx-changelog-1106][projects] |
| Upload de arquivos e imagens; geração de imagem e vídeo | ativos | F | [help-features][help-pro] |
| Comet (navegador) em iOS, Android, Mac e Windows desde 26/03/2026; Comet Assistant age na página (clica, preenche, compra), com `@tab` e busca no histórico | ativos | F | [comet-ios][comet] |
| Computer (agente de longa duração), Personal Computer (Mac/Windows), Computer local no Mac, Teammates, Automations (out/2026), Model Council (ago/2026), Effort Mode (set/2026), Voice mode (nov/2026) | ativos | F | [pplx-changelog][pplx-changelog-1106] |
| Learn Mode, Health, Finance Computer | ativos | F | [help-features][comet-ios] |

---

## 7. Novidades recentes (12 meses, nov/2025 a nov/2026)

**F** A fonte é o changelog da API [changelog], salvo onde indicado.

| Quando | O que mudou |
|---|---|
| nov/2025 | Pro Search GA na Sonar Pro (`search_type: "auto"`); MCP com instalação em um clique |
| dez/2025 | `sonar-reasoning` removido; classificador de mídia na `sonar-pro`; `max_tokens_per_page` e `last_updated_filter` na Search API |
| fev/2026 | Agent API GA; Embeddings API (padrão e contextualizado) |
| mar/2026 | `/v1/agent` canônico; Comet no iOS [comet-ios] |
| abr/2026 | `GET /v1/models`; chave de API mostrada uma vez só; créditos na AWS Marketplace |
| mai/2026 | Ferramenta `finance_search` |
| jun/2026 | `search_evals` 0.2.0 [search-evals] |
| jul/2026 | Sonar Chat Completions vira Agent API; Orchestrator API; MCP remoto; citações inline nos presets; Spaces → Projects [projects] |
| ago/2026 | Cache de prompt automático nos presets; `fast` com raciocínio `none` e tier `priority`; Model Council [pplx-changelog] |
| set/2026 | **Fast Search**; presets migram para GPT-6 Luna/Sol; `xhigh` vai para Claude Opus 5.5; conectores MCP próprios; OAuth no MCP; Photon, CobbleDB, Q2D-Web [photon][cobbledb][q2d] |
| out/2026 | `preset` → `effort`; `require_approval`; Decisions API (v1, v1.1, v1.2, Flash); arquivos PDF/DOC/DOCX/TXT/RTF; `image_search`; todos os presets em Fast Search; saída do `xhigh` em 512k; SPACE aberto [space]; Automations [pplx-changelog] |
| 06/11/2026 | Teammates; Computer local no Mac; Voice mode; Agent Plugins; pesos de `pplx-embed-v2-context`; **Batch API**; web grounding na Decisions; níveis de esforço mais baratos e o novo **`ultra`** [pplx-changelog-1106] |

---

## 8. Repositórios em github.com/perplexityai

**F** A página da organização listava 54 a 55 repositórios em 07/11/2026; a tabela tem 53 nomes únicos vistos nas duas páginas, mais o SPACE, aberto depois. As licenças vêm da listagem do GitHub ou do arquivo LICENSE do clone. Muitos são forks de ferramentas de build (Bazel) e de SDKs de terceiros. [gh-org][gh-org-2]

**Lidos em profundidade.** Seis foram clonados em 07/11/2026 e o `search_evals` está detalhado na seção 8.1.

| Nome | Licença | O que é | Relevância para o Vane | Reaproveitar código? |
|---|---|---|---|---|
| `search_evals` | MIT | Harness de avaliação de busca agêntica (Python) | **Alta**: método e graders para a Fase 5 | **Sim** (MIT, compatível; manter o aviso de copyright). Os dados têm termos próprios |
| `api-cookbook` | MIT | Vitrine da comunidade; exemplos antigos congelados (Sonar e Agent API), entre eles `fact-checker-cli` e `daily-knowledge-bot` | Baixa: os guias atuais estão nos docs | Sim (MIT), mas o código é antigo |
| `perplexity-node` | Apache-2.0 | SDK TypeScript (Stainless) | Média: tipos de evento e política de repetição; base de um provedor "Perplexity Search" | Sim (Apache-2.0, compatível com MIT, com NOTICE); melhor usar como dependência npm |
| `perplexity-py` | Apache-2.0 | SDK Python (Stainless), usado pelo `search_evals` | Baixa (o Vane é TS); serve de referência dos tipos | Sim, como dependência |
| `pplx-garden` | MIT (`lily` em Apache-2.0) | `fabric-lib` (RDMA, MoE), tokenizador unigram, `lily` (servidor Rust/Metal compatível com OpenAI para Qwen3.6-35B-A3B no Apple Silicon) | Baixa; o `lily` pode servir de backend local para quem roda o Vane num Mac | Não (é infraestrutura de GPU); o `lily` entra como provedor OpenAI-compatível sem mudar código |
| `pplx-kernels` | MIT | Kernels MoE de GPU, obsoletos (substituídos pelo `pplx-garden`) | Nenhuma | Não |
| `cachew` | Apache-2.0 | Proxy HTTP de cache em camadas para infra de engenharia (Git, Docker, Go, Artifactory) | Ideias: cache em camadas (memória → disco → autoritativo) com preenchimento de volta e invalidação por ETag | Não (Go, outro domínio); copiar só as ideias |

**Outros repositórios.** Uma linha cada.

| Nome | Licença | O que é | Relevância para o Vane | Reaproveitar código? |
|---|---|---|---|---|
| `modelcontextprotocol` | MIT | Servidor MCP oficial (`perplexity_search`, `_ask`, `_reason`, `_research`, com orçamentos `max_tokens` até 120k) | Média: modelo para expor o Vane como servidor MCP | Sim, como referência de schema |
| `ai-sdk` | MIT (package.json) | Provedor da Perplexity para o Vercel AI SDK | Baixa | Possível |
| `perplexity-search-sdk` | Apache-2.0 | SDK da Search API com núcleo compilado fechado; `content.snippets` | Média: contrato de "trechos por pergunta" | Não (núcleo binário) |
| `perplexity-cli` | não listada | CLI `pplx` (busca e trechos em JSON para agentes) | Baixa | Não |
| `pplx-rs` | não listada | Cliente Rust | Nenhuma | Não |
| `wandr` | Apache-2.0 | Benchmark de pesquisa ampla e profunda (arXiv 2608.14747), formato Harbor | Média: candidato para avaliar pesquisa profunda | Sim (Apache-2.0); conferir os termos dos dados |
| `SPACE` | Apache-2.0 | Sandbox em microVM do Computer | Baixa (só se o Vane ganhar execução de código) | Possível, mas é pesado |
| `numbat` | Apache-2.0 | Visibilidade da atividade de agentes no endpoint | Nenhuma | Não |
| `bumblebee` | Apache-2.0 | Scanner de exposição de supply chain | Nenhuma | Não |
| `codescythe` | Apache-2.0 | Removedor de código morto em TS (Rust) | Baixa: pode varrer o próprio Vane | Uso como ferramenta |
| `api-platform-developers` | Apache-2.0 | Sem descrição | Nenhuma | — |
| `api-discussion` | não listada | Fórum antigo da API (arquivado) | Nenhuma | — |
| `rusqlite`, `pgcat`, `rocksdb` | MIT, MIT, Apache-2.0 | Forks (SQLite em Rust, pooler Postgres, RocksDB) | Nenhuma | — |
| `bazel-central-registry`, `bazel-watcher`, `rules_web_e2e`, `rules_multirun`, `rules_playwright`, `rules_diff`, `gazelle_rs`, `gazelle_py`, `gazelle_css`, `toolchain_utils`, `download_utils`, `ape`, `watchman`, `dotslash`, `gawk`, `lefthook`, `libpfm` | Apache-2.0 / MIT / GPL-3.0 (gawk) / outras | Ferramentas e forks de build (Bazel) | Nenhuma | — |
| `workers-sdk`, `electron-sdk`, `dd-trace-js`, `next-auth`, `js-sdk-common`, `js-client-sdk`, `eppo-ios-sdk`, `lightweight-charts` | Apache-2.0 / MIT / ISC / outras | Forks de SDKs de terceiros (Cloudflare, Datadog, NextAuth, Eppo, gráficos financeiros) | Nenhuma (o `lightweight-charts` poderia desenhar o widget de ações) | Usar o original |
| `Factory`, `swift-markdown`, `socket.io-client-swift`, `Highlightr` | MIT / Apache-2.0 / outras | Bibliotecas iOS/Swift | Nenhuma | — |
| `webRTC`, `react-agent-handler-link`, `libfabric-efa-demo` | não listada / Apache-2.0 | Experimentos internos | Nenhuma | — |

**Conclusão (F/I).** Nenhum repositório tem o motor de busca, o ranking ou o prompt do produto (F). O que dá para reaproveitar é o **método de avaliação** (`search_evals`, `wandr`), os **contratos de API** (SDKs, MCP) e as **ideias de cache** (I).

### 8.1 `search_evals` em detalhe

**Versão 0.2.0 (atual, 02/06/2026 em diante)** (F [search-evals])
- Avalia **sistemas completos**: Perplexity Agent API, OpenAI Responses, Anthropic Managed Agents, Exa e Parallel, com a configuração de cada um em `systems.toml`. Na Perplexity: `openai/gpt-5.5`, raciocínio alto, `sandbox` + `web_search`, 100 passos, modo em segundo plano com polling.
- Conjuntos: BrowseComp (1.266 tarefas), DSQA (900), HLE só texto (2.158), WideSearch (200, métrica F1 por linha).
- Resultados publicados: Perplexity 0,871 (DSQA), 0,805 (BrowseComp), 0,612 (HLE), 0,651 (WideSearch).
- Graders: LLM-juiz `gpt-4.1` fixo no código, com saída em JSON Schema estrito. O prompt de "deep research" vem do BrowseComp/HLE: extrair a resposta final, comparar com o gabarito, aceitar pequena margem numérica. O do DSQA confere item a item nas respostas em conjunto e lista os excessos. O do WideSearch alinha vocabulário por LLM, junta tabelas e calcula precisão, recall e F1.
- Mecânica: pasta de execução `runs/{sistema}-{suite}[-sufixo]-{hash da config}`, com o hash incluindo a impressão digital do conjunto de dados; retomada reaproveita tarefas prontas; até 3 tentativas por tarefa; registro de pedidos, respostas, traço do grader e custo por tarefa; `summary.json` com **"falhas contam zero"** e **"falhas excluídas"** e custo separado de agente e de grader.
- Os dados não vêm no repositório: são baixados do Hugging Face em revisão fixada. Termos: BrowseComp pede que os exemplos decifrados não sejam publicados; DSQA é Apache-2.0; HLE é MIT e fechado (aceitar termos); WideSearch é CC0-1.0. [search-evals-data]

**Versão 0.1 (set/2025 a mai/2026, no histórico do git)** (F [search-evals-v01][search-arch])
- Avaliava **APIs de busca** (Perplexity, Exa, Brave, SERP via Tavily) dentro de dois agentes padrão: "single-step search" para SimpleQA, SEAL-0 e SEAL-Hard, e "deep research" para BrowseComp, DSQA, FRAMES e HLE. O modelo era fixo (Claude ou GPT).
- Os graders usavam o prompt do repositório ou do artigo original de cada benchmark.

**Serve para a Fase 5 do Vane?** (I, com base no código lido)
- **Licença: sim.** MIT no código, compatível com o MIT do Vane: dá para copiar prompts e lógica mantendo o aviso de copyright. Os dados seguem os termos de cada benchmark e não devem ser copiados para `perf-audit/fixtures`; o BrowseComp em particular não pode ser publicado decifrado.
- **Desenho: a 0.1 encaixa melhor.** A pergunta do Vane é "o meu pipeline (SearXNG + ranking + redator) responde bem?", não "qual sistema comercial ganha". Dois caminhos:
  1. Escrever um harness Python novo (`BaseHarness`, cerca de 100 linhas) que chama `POST /api/search` do Vane e rodar a 0.2.0 como está. Atenção: o grader fixa `gpt-4.1` e checa o modelo no preflight, então um juiz local exige mudar uma constante.
  2. Portar para `perf-audit/eval` (TypeScript) só as ideias: hash da configuração na pasta de execução, retomada por tarefa, as duas médias de falha, custo por tarefa, e os prompts de grader do SimpleQA e do DSQA.
- **Conjunto: começar pequeno.** BrowseComp e HLE são difíceis demais para modelos locais de 8B e caros de julgar. Para o speed e o balanced, um recorte de SimpleQA/SEAL (fatos curtos) e de FRAMES (vários saltos); para o quality, um recorte de DSQA. Tudo em inglês: complementa, mas não substitui, as 30 perguntas em pt-BR do eval atual.
- **Não verificado:** a licença dos dados do SimpleQA, do FRAMES e do SEAL usados na 0.1.

---

## 9. O que isto significa para o Vane

O código do Vane em `master` (`0dbebab`) já adotou vários padrões que o relatório anterior sugeria: filtros `recency`/`domains`/`language` no `web_search`, data e fonte no contexto do redator, ranking híbrido com RRF, trechos de página no balanced, nova busca quando a evidência é fraca, presets de esforço, caminho rápido no speed, fontes desde a primeira busca e prévia da fonte na citação (commits `f87fcce`, `3bcd04f`, `1a64c7a`, `891cca7`). A comparação da próxima fase deve partir daí.

1. **Orçamento em tokens, não em número de resultados** (F [web-search][effort]). A Perplexity limita por `max_tokens_per_page` e `max_tokens` e divide `max_results` entre as queries. Vale conferir se os presets do Vane (`effort.ts`) já expressam isso em tokens, ou ainda em resultados e caracteres.
2. **Medir qualidade e custo juntos, como no Fast Search** (F [photon]). A Perplexity aceitou um retriever um pouco pior (DCG de 2,45 para 2,21) porque a qualidade final não mudou e o custo caiu 68%. O eval do Vane deveria registrar custo e latência por tarefa ao lado da nota, para decidir trocas desse tipo.
3. **Adotar o método do `search_evals`** (F [search-evals]; I sobre o encaixe). Hash da configuração na pasta de execução, retomada, "falhas contam zero / excluídas" e grader no método original de cada benchmark. É MIT. Recorte pequeno de SimpleQA/FRAMES/DSQA para a Fase 5.
4. **O trecho é a unidade, e a extração custa caro na hora da pergunta** (F [cobbledb][search-arch]). A Perplexity corta e embute na indexação; o Vane faz tudo na hora. Um cache local de páginas já cortadas e embutidas, por URL (SQLite, com ETag/`Last-Modified` no estilo do `cachew`), cortaria latência nas perguntas repetidas e nos follow-ups. (I)
5. **Tarefas longas em segundo plano** (F [background]). O padrão `background` → polling → `starting_after` → cancelar é exatamente o que falta ao quality e à pesquisa profunda do Vane, que hoje vivem numa sessão em memória de 30 minutos. O `sequence_number` por evento casa com o replay de `/api/reconnect`.
6. **Verificar citações com um juiz barato** (F [decisions][llms]). A Perplexity resolve isso com um classificador de probabilidade e não com o LLM principal. No Vane, um modelo pequeno local (o `pplx-decider-flash` tem GGUF; licença a conferir) ou o próprio embedding pode checar `[n]` contra o trecho, só no quality.
7. **Contrato de eventos de streaming** (F [sdk-py][streaming-cit]). `search_queries`, `search_results`, `fetch_url_*` e `output_text.delta` mapeiam um para um nos blocos do Vane; vale copiar os nomes ao expor o Vane como API ou como servidor MCP (o `modelcontextprotocol`, MIT, serve de modelo).
8. **Repetição e fallback** (F [sdk-py][orch-routing][fallback]). Repetir 2 vezes em 408/409/429/5xx com backoff, respeitar `Retry-After`, distinguir "sobrecarga" de "limite", e fazer fallback de modelo **só antes do primeiro token**. Com o Bifrost no meio, conferir o que ele já faz para não repetir em dobro.
9. **Prompt do redator curto e honesto sobre lacunas** (F [prompt-guide]). Instruções curtas (relidas a cada passo), permissão para dizer "não encontrei" e aviso quando a fonte trata de algo vizinho. Medir no eval contra o prompt atual.
10. **O que não copiar** (I). Índice próprio, Photon, ROSE e prefill/decode desagregados pressupõem frota de GPU e crawler; num app auto-hospedado, a alavanca equivalente é cache, orçamento de tokens, ranking local e um modelo local rápido (ex.: o `lily` no Mac).

---

## 10. O que não deu para verificar

- Licença dos pesos `pplx-embed-v2-*` e `pplx-decider-*` no Hugging Face (a página da organização não mostra).
- Base do `pplx-embed-v1` (Qwen3, segundo o relatório anterior).
- Entradas do changelog da API depois de outubro de 2026, a não ser pelo changelog do produto de 06/11.
- Tamanho dos trechos (spans) e detalhes do reranker em produção.
- Que o motor anterior ao Photon era o Vespa (provável, não confirmado).
- Licença dos dados de SimpleQA, FRAMES e SEAL usados na versão 0.1 do `search_evals`.
- A API do GitHub (`gh api orgs/...`) foi recusada nesta sessão; a lista de repositórios veio da página web e dos clones públicos.

---

## Fontes

[llms]: https://docs.perplexity.ai/llms.txt
[changelog]: https://docs.perplexity.ai/docs/resources/changelog.md
[pricing]: https://docs.perplexity.ai/docs/getting-started/pricing.md
[ratelimits]: https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers.md
[search-qs]: https://docs.perplexity.ai/docs/search/quickstart.md
[fast-search]: https://docs.perplexity.ai/docs/search/fast-search.md
[search-bp]: https://docs.perplexity.ai/docs/search/best-practices.md
[date-filters]: https://docs.perplexity.ai/docs/search/filters/date-time-filters.md
[domain-filter]: https://docs.perplexity.ai/docs/search/filters/domain-filter.md
[agent-qs]: https://docs.perplexity.ai/docs/agent-api/quickstart.md
[effort]: https://docs.perplexity.ai/docs/agent-api/effort.md
[fallback]: https://docs.perplexity.ai/docs/agent-api/model-fallback.md
[tools-overview]: https://docs.perplexity.ai/docs/agent-api/tools/overview.md
[web-search]: https://docs.perplexity.ai/docs/agent-api/tools/web-search.md
[output-control]: https://docs.perplexity.ai/docs/agent-api/output-control.md
[background]: https://docs.perplexity.ai/docs/agent-api/background-mode.md
[prompt-guide]: https://docs.perplexity.ai/docs/agent-api/prompt-guide.md
[streaming-cit]: https://docs.perplexity.ai/docs/cookbook/articles/streaming-citations/README.md
[async-dr]: https://docs.perplexity.ai/docs/cookbook/articles/async-deep-research/README.md
[emb-qs]: https://docs.perplexity.ai/docs/embeddings/quickstart.md
[decisions]: https://docs.perplexity.ai/docs/decisions/quickstart.md
[orch-qs]: https://docs.perplexity.ai/docs/router/quickstart.md
[orch-routing]: https://docs.perplexity.ai/docs/router/routing-and-reliability.md
[search-arch]: https://www.perplexity.ai/hub/blog/architecting-and-evaluating-an-ai-first-search-api
[photon]: https://www.perplexity.ai/hub/blog/photon
[cobbledb]: https://www.perplexity.ai/hub/blog/cobbledb
[q2d]: https://www.perplexity.ai/hub/blog/q2d-web
[ctx-emb]: https://www.perplexity.ai/hub/blog/contextual-embedding-beyond-the-gold-passage
[rwe]: https://www.perplexity.ai/hub/blog/learning-from-real-world-experience
[agent-eval-blog]: https://www.perplexity.ai/hub/blog/ai-agent-evaluation
[disagg]: https://www.perplexity.ai/hub/blog/disaggregated-prefill-and-decode
[cutedsl]: https://www.perplexity.ai/hub/blog/cutedsl-at-perplexity
[gptoss]: https://www.perplexity.ai/hub/blog/gpt-oss-on-day-0
[fast-emb]: https://www.perplexity.ai/de/hub/blog/fast-embeddings-on-gpus
[space]: https://www.perplexity.ai/hub/blog/open-sourcing-space
[local-mac]: https://www.perplexity.ai/hub/blog/perplexity-computer-now-runs-fully-local-on-mac
[projects]: https://www.perplexity.ai/hub/blog/spaces-are-now-projects
[pplx-changelog]: https://www.perplexity.ai/changelog
[pplx-changelog-1106]: https://www.perplexity.ai/changelog/teammates-fully-local-computer-on-mac-and-voice-mode
[comet-ios]: https://www.perplexity.ai/changelog/what-we-shipped--march-27-2026
[comet]: https://www.perplexity.ai/comet/gettingstarted
[help-pro]: https://www.perplexity.ai/help-center/en/articles/10352903-what-is-pro-search
[help-features]: https://www.perplexity.ai/help-center/en/collections/18799290-features
[help-projects]: https://www.perplexity.ai/help-center/en/articles/10352961-what-are-projects
[hf]: https://huggingface.co/perplexity-ai
[gh-org]: https://github.com/orgs/perplexityai/repositories
[gh-org-2]: https://github.com/orgs/perplexityai/repositories?page=2
[search-evals]: https://github.com/perplexityai/search_evals
[search-evals-data]: https://github.com/perplexityai/search_evals/blob/main/THIRD_PARTY_DATASETS.md
[search-evals-v01]: https://github.com/perplexityai/search_evals/tree/d1ebfc1
[sdk-py]: https://github.com/perplexityai/perplexity-py
[sdk-node]: https://github.com/perplexityai/perplexity-node
[search-sdk]: https://github.com/perplexityai/perplexity-search-sdk
[mcp-repo]: https://github.com/perplexityai/modelcontextprotocol
[cookbook-repo]: https://github.com/perplexityai/api-cookbook
[garden]: https://github.com/perplexityai/pplx-garden
[langchain]: https://www.langchain.com/breakoutagents/perplexity
[vespa]: https://vespa.ai/case-studies/perplexity/
[aiep]: https://prajwalamte.github.io/AI-Engineering-Patterns/case-studies/perplexity-ai/

- Documentação: [llms.txt][llms], [changelog da API][changelog], [preços][pricing], [limites][ratelimits], [Search API][search-qs], [filtros de data][date-filters], [filtro de domínio][domain-filter], [boas práticas de busca][search-bp], [Agent API][agent-qs], [esforço][effort], [fallback][fallback], [web_search][web-search], [saída][output-control], [segundo plano][background], [guia de prompt][prompt-guide], [citações em streaming][streaming-cit], [pesquisa profunda][async-dr], [Embeddings][emb-qs], [Decisions][decisions], [Orchestrator][orch-qs], [roteamento][orch-routing].
- Blog e pesquisa: [Search API][search-arch] (25/09/2025), [Photon][photon] (24/09/2026), [CobbleDB][cobbledb] (14/09/2026), [Q2D-Web][q2d] (09/09/2026), [embeddings contextuais][ctx-emb] (30/09/2026), [experiência real][rwe] (21/09/2026), [avaliação de agentes][agent-eval-blog], [prefill/decode][disagg], [CuTeDSL][cutedsl], [GPT-OSS][gptoss], [embeddings em GPU][fast-emb], [SPACE][space], [Computer local][local-mac], [Projects][projects].
- Produto: [changelog][pplx-changelog], [06/11/2026][pplx-changelog-1106], [Comet iOS][comet-ios], [Comet][comet], [Pro Search][help-pro], [funcionalidades][help-features], [Projects][help-projects].
- Código e modelos: [GitHub p.1][gh-org], [p.2][gh-org-2], [search_evals][search-evals] e o histórico até o commit `d1ebfc1` (v0.1), [SDK Python][sdk-py], [SDK Node][sdk-node], [Search SDK][search-sdk], [MCP][mcp-repo], [cookbook][cookbook-repo], [pplx-garden][garden], [Hugging Face][hf].
- Fontes não oficiais: [entrevista da LangChain][langchain] (P), [estudo de caso do Vespa][vespa] (P), [AI Engineering Patterns][aiep] (I).
