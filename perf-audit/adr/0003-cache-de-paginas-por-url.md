# ADR 0003: Cache por URL de páginas lidas, cortadas e embutidas

- **Status:** Proposta
- **Data:** 07/11/2026
- **Relacionados:** `improvements.md` G1-08, G1-18; `vane-vs-perplexity.md` §2.3, §2.6

## Contexto

Toda leitura de página acontece na hora da pergunta:
- balanced: `readTopPages` raspa 2 páginas por busca, corta em trechos de 200 tokens e embute até 40 deles por página (`baseSearch.ts:81-91,767-808,816-854`);
- quality: raspa até 3 páginas por busca, até 100 mil caracteres, e passa cada pedaço de 4.000 tokens por um extrator LLM (`baseSearch.ts:98-104,679-730`);
- `scrape_url`: até 3 URLs por chamada (`scrapeURL.ts:52-70`).

Não há cache em nenhuma camada. Na rodada de 07/11, a mesma página de 63 KB foi raspada e embutida duas vezes na mesma pesquisa do balanced, e os trechos repetidos foram concatenados (`benchmark-2026-11-07.md` §6). Seguimentos sobre o mesmo tema repetem tudo.

A Perplexity faz o inverso: corta e embute na indexação e guarda por URL os trechos e o vetor de cada trecho (CobbleDB), com leitura em lote e hedging ([cobbledb]). O `cachew` dela mostra o cache em camadas com validação por ETag ([cachew]).

O banco do Vane é SQLite com WAL (`db/open.ts:17-33`), tabelas `chats` e `messages` (`db/schema.ts`), migrações à mão em `drizzle/` (`db/migrate.ts`). Mudar o schema pede aprovação.

## Opções

### A. Sem cache
- Prós: sempre fresco; nenhum estado novo.
- Contras: paga scrape e embedding duas vezes na mesma pesquisa; seguimentos não aproveitam nada.

### B. Memo por pesquisa (em memória, vida de uma pergunta)
- Prós: sem schema; resolve o caso medido (mesma página na iteração 1 e 2); sem risco de conteúdo velho.
- Contras: não ajuda seguimentos nem perguntas repetidas.

### C. Cache em memória do processo, com LRU e TTL
- Prós: ajuda seguimentos; sem schema.
- Contras: se perde no reinício; disputa memória com as sessões (já pesadas, ver G1-03); precisa de teto em bytes.

### D. Tabela SQLite por URL (texto, trechos, vetores por modelo de embedding, ETag, `Last-Modified`, `fetched_at`)
- Prós: sobrevive a reinício; serve seguimentos e perguntas repetidas; o vetor é guardado por modelo, então trocar de modelo invalida sozinho; validação condicional barata com ETag.
- Contras: migração nova (aprovação); risco de conteúdo velho em notícias e preços; crescimento do banco (precisa de limpeza); o conteúdo de terceiros fica em disco.

## Decisão proposta

Em dois passos, medindo cada um:
1. **B agora** (`improvements.md` G1-08): um `Map<urlNormalizada, Promise<página>>` criado pelo `Researcher` e passado às ações; deduplicar trechos ao juntar resultados.
2. **D depois, se o passo 1 e o G1-01 mostrarem ganho em seguimentos** (G1-18): tabela `page_cache` com chave na URL normalizada (`utils/normalizeUrl.ts`), TTL padrão curto (24 h; menor quando o resultado tem data recente), validação por `If-None-Match`/`If-Modified-Since` no fetch direto (o Firecrawl não expõe ETag; lá vale só o TTL), limpeza por tamanho e idade, e chave de vetor = `{provedor, modelo, dims}`.

C fica descartada: tem os custos de D sem a persistência.

## Consequências

- **Positivas:** menos scrapes e embeddings por pergunta; seguimentos mais rápidos; a mesma fonte não aparece duplicada no contexto.
- **Negativas:** no passo 2, schema novo, migração e uma política de frescor para manter; páginas lidas ficam gravadas em `DATA_DIR`, o que deve ser dito na documentação e ter um botão de limpar.
- **A medir:** scrapes e embeddings por pergunta; taxa de acerto do cache; latência do balanced e do quality em seguimentos; tamanho do banco depois de N perguntas.
- **Gate:** eval da Fase 5 (o contexto muda quando os trechos duplicados somem); aprovação do usuário para a migração do passo 2.

[cobbledb]: https://www.perplexity.ai/hub/blog/cobbledb
[cachew]: https://github.com/perplexityai/cachew
