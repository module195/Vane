# ADR 0001: Provedores da Perplexity opcionais, atrás das interfaces que já existem

- **Status:** Proposta
- **Data:** 07/11/2026
- **Relacionados:** `improvements.md` G2-01 a G2-04; `vane-vs-perplexity.md` §1 (custo, privacidade)

## Contexto

O Vane promete rodar 100% local: SearXNG na imagem completa (`Dockerfile:34-66`), modelos em LM Studio, Ollama ou Transformers, dados em `DATA_DIR`. A Perplexity oferece quatro APIs que tapam lacunas do Vane: Search API (trechos já extraídos, filtros de data e país), Embeddings API (`pplx-embed`, contextualizados), Agent API (resposta com busca e citações) e Decisions API (juiz de citação). Todas são pagas e mandam a pergunta ou o texto para fora da máquina.

O Vane já tem três pontos de extensão que cobrem esses casos:
- busca: `search.provider` (`config/index.ts:136-153`, `serverRegistry.ts:19-22`) e `runProvider` (`lib/webSearch.ts:58-61`), hoje com SearXNG e Firecrawl;
- modelos: `BaseModelProvider` (`models/base/provider.ts:12-21`) com `loadChatModel` e `loadEmbeddingModel`, registrados em `models/providers/index.ts`;
- pós-processamento do redator: o ponto depois de `sanitizeCitations` (`search/index.ts:233-244`).

Regras do usuário: provedor pago só com aprovação; nunca obrigatório; mudanças pequenas e fáceis de manter no fork.

## Opções

### A. Não integrar
- Prós: nada muda; nenhum risco de dependência paga.
- Contras: quem aceita pagar não tem como; o eval perde uma linha de base de busca "de referência".

### B. Provedores opcionais atrás das interfaces existentes (um por API)
- Prós: cada integração é um arquivo novo mais uma opção de configuração; sem chave, o código nem é chamado; o fork continua próximo do upstream; cada uma passa pelo eval isoladamente.
- Contras: quatro integrações para manter; a Embeddings API usa `base64_int8` e não serve à classe `OpenAIEmbedding`, que força `float` (`openaiEmbedding.ts:18`); a Agent API fala Responses, não Chat Completions.

### C. Um "modo Perplexity" que delega toda a pergunta ao Agent API
- Prós: qualidade da Perplexity com uma chamada; pouco código no pipeline.
- Contras: é funcionalidade nova, contorna classificador, pesquisador e redator, e não melhora o Vane local; acopla o produto a um contrato externo que mudou de nome duas vezes em 2026 (Sonar → Agent API, `preset` → `effort`).

### D. Dependência do SDK `perplexity-node`
- Prós: tipos e retentativas prontos (Apache-2.0).
- Contras: dependência principal nova para quatro chamadas HTTP; pede aprovação; duplica as retentativas do SDK `openai` e do Bifrost.

## Decisão proposta

**B**, com `fetch` direto e sem SDK novo (D descartada), na ordem G2-01 (Search), G2-02 (Embeddings), G2-04 (Decisions). C fica no Grupo 3 como "modo delegado".

Regras:
1. Chave só do ambiente (`PERPLEXITY_API_KEY`), como a do Firecrawl (`lib/firecrawl.ts`); nunca gravada no `config.json` e mascarada onde aparecer (`config/secrets.ts`).
2. Sem a chave, a opção não aparece ou aparece desabilitada; o padrão continua SearXNG e o modelo local.
3. A tela de configuração diz o que sai da máquina (consulta, trechos, texto dos uploads).
4. Cada provedor tem teste com servidor falso, como `firecrawlSearch` e `openaiEmbedding` já têm.
5. Nenhum provedor novo faz retentativa própria além de uma, respeitando `Retry-After`.

## Consequências

- **Positivas:** caminho pago para quem quer; Search API serve de linha de base no eval (mesmas perguntas, só a busca muda); nada muda para quem roda local.
- **Negativas:** o eval de cada provedor custa dinheiro; mudanças na API da Perplexity exigem manutenção; o embedding de 1.024 ou 2.560 dimensões obriga a reembutir uploads (depende de `improvements.md` G1-16).
- **A medir:** latência e custo por pergunta com e sem o provedor (G1-01); nota do eval por modo.
- **Não verificado:** se a Embeddings API aceita `float`; acesso ao Orchestrator (prévia privada); licença dos pesos `pplx-decider` e `pplx-embed-v2` para um caminho local.
