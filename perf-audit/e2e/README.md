# Testes de ponta a ponta (Fase 5)

Fluxos 1 a 5 do plano (`perf-audit/eval-plan.md` §2), num navegador de verdade contra o build de produção.

```bash
yarn build
yarn test:e2e        # node --test perf-audit/e2e/run.mjs
```

## Como funciona

- `run.mjs` sobe o `.next/standalone/server.js` com um `DATA_DIR` temporário e vazio, então cada rodada começa pela tela de setup. Ele copia `.next/static`, `public` e `drizzle` para dentro do standalone quando faltam, como o `Dockerfile` faz.
- `fake-backends.mjs` faz o papel do LM Studio (LLM e embeddings, com os modelos `fake-chat`, `fake-chat-2` e `fake-embed`) e da SearXNG. É determinístico, sem modelo nem buscador de verdade. A resposta do redator cita `[1]` e `[2]` e diz qual modelo respondeu. `GET /__writer` devolve as mensagens da última chamada ao redator.
- O navegador não sai de `127.0.0.1`: requisições a outros hosts recebem um 204 vazio.
- Cada fluxo também falha se houver erro no console, erro não tratado na página, requisição que falhou ou resposta HTTP 400 ou mais. A exceção são as falhas listadas em `KNOWN_OFFLINE`, que vêm do servidor tentando acessar a internet.
- Usa `node:test` e o pacote `playwright`, sem `@playwright/test`. No container, o Playwright e o Chromium já vêm instalados. Em outra máquina, instale o Playwright e o Chromium antes de rodar.

## Fluxos

| # | Fluxo | O que confere |
|---|---|---|
| 1 | Primeiro acesso | Adiciona a conexão LM Studio pela tela de setup, escolhe os modelos de chat e de embeddings e conclui. O `config.json` fica com `setupComplete: true` e o provedor salvo. |
| 2 | Busca em cada modo (speed, balanced, quality) | O modo escolhido é o que vai no `POST /api/chat`. A resposta chega com fontes listadas e citações que são links para as fontes. |
| 3 | Envio de arquivo | O `.txt` sobe com status 200, e o texto dele chega ao redator. |
| 4 | Biblioteca | Lista as conversas, reabre uma (a resposta e as citações voltam), apaga outra (`DELETE` 200, some da lista, e abrir de novo dá 404). |
| 5 | Troca de modelo | Nas configurações, troca o modelo de chat para `fake-chat-2`. A próxima resposta vem desse modelo. |

Os fluxos 6 a 8 do plano (cancelar no meio, recarregar durante o streaming, erro 4xx/5xx sem ficar preso no "carregando") hoje devem falhar. Eles entram junto com as correções, na Fase 6 em diante.

## Achados ao escrever os testes

- **O card de tempo da página inicial quebra sem internet.** A server action `getApproxLocation` (`src/lib/serverActions.ts:14`) não trata a falha de `free.freeipapi.com`. O servidor responde 500, e o navegador recebe um erro não tratado (React #441). Depois disso, `/api/weather` também dá 500. Numa instalação sem acesso à internet, isso aparece em toda visita à página inicial.
- **`/api/favicon` responde 404** para cada fonte cujo ícone não consegue buscar. A imagem some (`hideBrokenImage`), mas cada fonte gera uma linha de erro no console.
- **A tela de setup sugere Transformers para os embeddings** mesmo quando a conexão recém-criada oferece um modelo de embeddings. Quem só clica em "Concluir" baixa um modelo do Hugging Face no primeiro uso.

Os dois primeiros estão em `KNOWN_OFFLINE`. O terceiro é contornado no teste, que escolhe o modelo de embeddings da conexão.

## Resultados

Três rodadas seguidas no container, em 07/11/2026: 7 de 7 passando em cada uma, cerca de 15 s por rodada (sem contar o `yarn build`).
