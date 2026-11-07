# ADR 0005: Jobs em segundo plano e retomáveis para o quality e a pesquisa profunda

- **Status:** Proposta
- **Data:** 07/11/2026
- **Relacionados:** `improvements.md` G1-13, G1-14, G3-01, G3-12; `vane-vs-perplexity.md` §1 (pesquisa profunda), §2.7

## Contexto

O quality roda dentro da requisição de `POST /api/chat`: o agente é disparado sem `await` (`chat/route.ts:213`) e escreve numa `SessionManager` em memória, que guarda blocos e todos os eventos por 30 min (`session.ts:17`). Consequências:
- reiniciar o servidor perde o trabalho; a mensagem fica `answering` até o `saveFailure`, que só roda num erro capturado (`search/index.ts:33-51`);
- uma pesquisa de 25 iterações com modelo local pode passar de 30 min, e a sessão some antes do fim;
- fechar a aba não cancela nada (`chat/route.ts:235-240`), e não há botão de parar;
- `/api/reconnect/[id]` repete todos os eventos desde o início (`session.ts:80-95`), com o texto acumulado e os vetores de embedding (G1-03);
- em produção, o `Map` de sessões fica no escopo do módulo, não no `global` (`session.ts:5-9`); se o bundle duplicar o módulo, a reconexão pode não achar a sessão (a confirmar, `architecture.md` §14).

A Perplexity trata pesquisa longa como objeto próprio: `background: true` devolve um id na hora; estados `queued` → `in_progress` → `completed` / `failed` / `cancelled` / `incomplete`; reconexão por `starting_after=<sequence_number>`; `POST /cancel`; Batch API para lotes ([background], [effort]).

O banco é SQLite com WAL; não há fila nem worker; o servidor é um processo Node (`node server.js`). Mudar o schema ou o contrato da API pede aprovação.

## Opções

### A. Manter a sessão em memória e só aumentar o TTL
- Prós: uma linha.
- Contras: mais memória presa (já é o problema do upstream #1199); continua sem sobreviver a reinício nem cancelar.

### B. Persistir os eventos da sessão em SQLite, mantendo a execução na mesma requisição
- Prós: reconexão por `sequence_number` depois de reinício da UI; replay a partir de um ponto.
- Contras: a execução ainda morre com o processo; grava muito (um evento por pedaço de texto, a menos que G1-13 entre antes).

### C. Tabela de jobs + executor no próprio processo, com eventos numerados e snapshot
- Prós: o quality vira um job com estado no banco; a UI recebe o id e acompanha; reconexão com `starting_after`; cancelamento por `AbortController` (G1-14); ao reiniciar, jobs `in_progress` viram `incomplete` com os blocos parciais, em vez de sumirem; limite de jobs simultâneos (útil para GPU local); sem dependência nova.
- Contras: schema novo (`jobs`, `job_events` ou snapshot periódico); muda o contrato entre UI e servidor; o processo único continua sendo o limite.

### D. Fila externa (Redis/BullMQ) e worker separado
- Prós: escala e isolamento.
- Contras: dependência principal nova e outro serviço para quem auto-hospeda; desproporcional para um app de um usuário.

## Decisão proposta

**C**, só para o quality e o futuro modo de pesquisa profunda; speed e balanced continuam como hoje. Pré-requisitos: G1-13 (texto em delta e snapshot), G1-14 (cancelamento) e G1-03 (sem vetores nos blocos), que tornam os eventos pequenos o bastante para gravar.

Esboço:
1. Tabela `jobs` (`id`, `chatId`, `messageId`, `mode`, `status`, `createdAt`, `updatedAt`, `lastSeq`) e snapshot dos blocos a cada N eventos ou T segundos; os eventos intermediários ficam em memória.
2. `POST /api/chat` com `mode: quality` devolve o id do job; `GET /api/jobs/[id]?starting_after=N` faz o stream; `POST /api/jobs/[id]/cancel` cancela.
3. Na partida (`instrumentation.ts`), jobs `in_progress` viram `incomplete`, com os blocos do último snapshot.
4. No máximo 1 job de quality simultâneo por padrão (configurável), porque o gargalo é o servidor de modelo.
5. A API pública `POST /api/search` não muda nesta fase.

## Consequências

- **Positivas:** pesquisa longa sobrevive à aba fechada e a reinício (como parcial); cancelamento real; memória de sessão limitada; base para automações (G3-12).
- **Negativas:** migração nova, mudança no `useChat` e no contrato do stream; mais código no fork e distância maior do upstream; testes de ponta a ponta novos (fluxos 5 e 6 do `eval-plan.md` §2).
- **A medir:** memória do processo com N pesquisas; tempo até retomar após recarregar; bytes gravados por job.
- **Gate:** aprovação do usuário (schema, contrato de API, funcionalidade nova); não toca prompt nem ranking, então o eval de qualidade só confere que as respostas do quality não mudaram.

[background]: https://docs.perplexity.ai/docs/agent-api/background-mode.md
[effort]: https://docs.perplexity.ai/docs/agent-api/effort.md
