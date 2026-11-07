# Plano da Fase 5: rede de segurança

Status: **proposta para aprovação** (ponto de parada 2). Versão 2, de 07/11/2026, sobre `60304d8`. Substitui a versão de 06/11, que está no histórico do git. As decisões que você já tomou continuam valendo: modelo fixo no **LM Studio**, juiz um **modelo local maior**.

## 0. Onde estamos

| Peça | Estado hoje |
|---|---|
| Testes de unidade e caracterização | 57 arquivos e 407 testes passando (eram 22 e 132 em 06/11). Cobrem busca (speed/balanced/quality com fakes), pipeline com snapshots, SearXNG, Firecrawl, scraper, citações, sessão e reconexão, rotas, banco e migrações, uploads, MCP, Bifrost, benchmark, segurança. |
| Lint | Consertado (ESLint 9); 0 erros num checkout limpo. Entra como portão junto com `tsc`, testes, i18n e build. |
| Testes de ponta a ponta na interface | **Não existem.** |
| Harness de avaliação (`perf-audit/eval/`) | Pronto: 30 perguntas em 6 grupos, 3 modos, gravação e repetição da SearXNG e das páginas, verificações automáticas, juiz com rubrica v1, comparação lado a lado e regra de aprovação. |
| Referências gravadas | **Nenhuma.** `fixtures/eval/searxng/` e `fixtures/eval/pages/` estão vazias e `eval/runs/` também. O harness nunca rodou contra o modelo real. Hoje nenhuma mudança de qualidade pode ser aprovada. |

Dois problemas do harness que este plano corrige:
1. Ele avalia o `APISearchAgent` (caminho do `/api/search`), não o `SearchAgent` do chat (`/api/chat`), que é o que você usa. Os dois redatores diferem (`api.ts` não passa por `sanitizeCitations`, contexto vazio quando pula a busca). Uma mudança no caminho do chat passaria sem ser vista.
2. Ele mede tempo total e tempo até o primeiro token, mas não grava tokens (`usage`), tokens de raciocínio nem o tempo de cada etapa. Sem isso não dá para medir o item de maior ganho (desligar o raciocínio nas chamadas estruturadas, G1-02).

## 1. Testes de caracterização (sem LLM): o que falta

Só o que ainda não está coberto, cada um com fixture gravada em `perf-audit/fixtures/characterization/`:

| Alvo | O que fixar |
|---|---|
| `baseSearch.ts` (vazamento de vetores) | Nenhum bloco emitido nem `responseBlocks` salvo contém `embedding`. **Hoje falha**; vira o teste da correção G1-03. |
| `/api/search` sem `chatModel`/`embeddingModel` | Responde 400 com mensagem, não 500. **Hoje falha** (#1170). |
| Fontes com erro de leitura | Página que falhou (`scraper.ts:73-76`) e erro de MCP não viram fonte citável. **Hoje falha** (G1-05). |
| Classificador, seletor do quality e ferramenta inventada | Uma falha não derruba a resposta inteira; cai para um caminho padrão. **Hoje falha** (G1-04). |
| Cliente fecha a conexão | O agente para de chamar o LLM (AbortSignal). **Hoje falha**; fica marcado como `todo` até a correção. |
| Busca filtrada que é refeita sem filtro | O `site:` digitado pelo usuário continua valendo (`baseSearch.ts:181-196`). |
| Widgets (tempo, ações, cálculo) | LLM falso e respostas gravadas das APIs externas. |
| Configuração | Leitura, gravação, chaves proibidas, máscara de segredos em `/api/config` e `/api/providers`. |

Os testes que "hoje falham" entram junto com a correção de cada item, no mesmo commit, e não antes, para não deixar a suíte vermelha.

## 2. Testes de ponta a ponta na interface (agente `e2e-runner`)

Playwright com o Chromium do container, contra o build de produção (`.next/standalone`), e o servidor falso de LLM, embeddings e SearXNG usado na Fase 4, que passa para `perf-audit/e2e/fake-backends.mjs`. Fluxos:

1. Primeiro acesso: configurar o provedor pela tela de setup.
2. Uma busca em cada modo até a resposta com fontes e citações clicáveis.
3. Envio de um arquivo e pergunta sobre ele.
4. Abrir a biblioteca, reabrir uma conversa e apagá-la.
5. Trocar o modelo nas configurações e buscar de novo.
6. Cancelar uma busca no meio e começar outra: a resposta antiga não pode vazar para a nova.
7. Recarregar a página durante o streaming (reconexão) sem texto duplicado (#1038).
8. Resposta 4xx/5xx da API: a interface sai do "carregando" (hoje fica presa, `useChat.tsx:569-603`).

Cada teste também falha se houver erro no console ou requisição falhando. Ficam fora do `yarn test` (script novo `test:e2e`), porque precisam do build. Os fluxos 6 a 8 devem falhar hoje e passar com as correções.

## 3. Conjunto de avaliação de qualidade

### 3.1 Perguntas

As 30 atuais ficam, porque cobrem o que o roteiro pede: fatos (7), várias fontes (8), acadêmicas (5), `site:` (4), arquivo enviado (4), conversa e widget (2). Acrescento 6, que cobrem os casos que as correções da auditoria tocam, chegando a 36 (108 respostas por rodada):

| Nova | Para quê |
|---|---|
| `site:` + resultado fraco | Busca que cai na nova busca sem filtro; o domínio tem que continuar respeitado. |
| Notícia recente (filtro de data) | Fontes com data e recência. |
| Pergunta que pede número exato | Afirmação sustentada pela fonte certa. |
| Pergunta ambígua em inglês | Idioma da resposta igual ao da pergunta. |
| Pergunta com página que falha | A falha não vira fonte citada. |
| Seguimento que depende do histórico | Reescrita da pergunta com contexto. |

### 3.2 Como roda

- **Dois caminhos:** cada pergunta roda pelo `SearchAgent` do chat (padrão) e, nas 10 perguntas marcadas, também pelo `APISearchAgent`.
- **Três referências** antes de qualquer comparação, para medir o ruído entre rodadas com temperatura 0.
- **Gravação no seu Mac**, com o LM Studio (o modelo que você usa, `qwen3.6-35b-a3b`, e o `bge-m3` para embeddings) e a sua SearXNG. A página é lida pelo leitor que você usa (Firecrawl), e isso fica registrado no `summary.json`.

### 3.3 O que se mede, por resposta

Tirado do `search_evals` da Perplexity (MIT, só a metodologia e o formato, sem copiar código):
- tempo total, tempo até o primeiro token e tempo por etapa (classificar, pesquisar, ler páginas, escrever);
- tokens de entrada, saída e raciocínio, número de chamadas de LLM e de embedding;
- tamanho do stream e do que é salvo no banco;
- a pasta da rodada recebe o hash da configuração (modelo, modo, versão do prompt e do juiz), e a rodada pode ser retomada;
- resposta com erro conta como **nota zero** e também é listada à parte, para não sumir da média.

### 3.4 Verificações automáticas (100% obrigatório)

As que já existem: toda citação `[n]` aponta para uma fonte; nenhuma citação quando a busca foi pulada; mesmo idioma da pergunta; sem título principal; no quality, tamanho dentro de ±30% da referência; `site:` respeitado. Novas: nenhuma fonte citada é página de erro; nenhum `embedding` nos blocos.

### 3.5 Juiz e regra de aprovação

- Juiz: modelo local maior, temperatura 0, rubrica `judge-prompt.md` v1 (relevância das fontes, afirmações sustentadas, completude contra pontos-chave revisados por você, formato das citações) e comparação lado a lado com as posições trocadas.
- Uma mudança passa se: nenhum critério cai mais de 0,3 na média de qualquer modo; nenhuma pergunta cai 2 pontos ou mais; verificações automáticas em 100%; e nenhuma métrica de custo (tokens, tempo) piora mais que o ruído medido nas três referências, salvo se a mudança for de qualidade e você aceitar a troca.
- Reprovações e casos em que o juiz preferiu a referência nas duas ordens vão para `perf-audit/eval/review-queue.md`, para sua revisão.

## 4. Ordem e esforço

| Passo | Onde roda | Esforço |
|---|---|---|
| 1. Harness: caminho do chat, tokens e etapas, hash e retomada, 6 perguntas novas, README sem Playwright | Container | M |
| 2. Testes de caracterização que já passam hoje (widgets, configuração, `site:`) | Container | P |
| 3. E2E dos fluxos 1–5 | Container | M |
| 4. Gravar as fontes e as 3 referências; revisar os pontos-chave | **Seu Mac** | ~2–3 h de máquina, ~20 min seus |
| 5. Testes que hoje falham e os fluxos E2E 6–8 | Junto com cada correção, na Fase 6 em diante | — |

O passo 4 é o único que depende de você: o seu Mac não está conectado a esta conversa. Ele pode rodar por uma sessão do Remote Control (eu disparo e acompanho) ou por você, com os comandos do README do harness. Sem ele, os passos 1–3 ficam prontos, mas nenhuma mudança que mexa em prompt, modelo, fontes, contexto, chunking ou reranking pode ser aprovada.

## 5. O que não muda

Nada em `src/` muda nesta fase, exceto o que o harness precisar para observar (o mesmo padrão do `benchmark/instrument.ts`, por envoltório em tempo de execução). Nenhuma chave de API ou dado de usuário vai para os arquivos gravados: as chaves vêm só do ambiente, e os uploads usados são os arquivos de teste desta pasta.
