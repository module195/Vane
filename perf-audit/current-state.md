# Fase 4: estado atual

Medido em 07/11/2026 no container da auditoria (4 CPUs, Node 22.23, Yarn 1.22, Docker 29.9), sobre o commit `15495d3` (código igual a `78f19ff`: master `02bd0c7` + os dois commits locais de correção). O roteiro pede `npm`; usei `yarn`, porque o lockfile é `yarn.lock` e o CI e os Dockerfiles usam `yarn install --frozen-lockfile`.

## 1. Instalação, lint, tipos, testes e build

| Etapa | Resultado | Tempo |
|---|---|---|
| `yarn install --frozen-lockfile` | OK; 4 avisos "Workspaces can only be enabled in private projects" (vêm de pacotes, não do projeto) | 90 s (cache frio) |
| `yarn lint` (`eslint .`) | **Falha aqui**: 255 erros e 278 avisos, mas 531 das 533 linhas vêm de `.claude/worktrees/` (worktrees locais de agentes, fora do git). O `eslint.config.mjs` não ignora `.claude/**`. Num checkout limpo, como no CI, isso não acontece. | 231 s |
| `eslint . --ignore-pattern '.claude/worktrees/**'` | OK: 0 erros, 15 avisos (9 `react-hooks/exhaustive-deps`, 5 `no-img-element`, 1 `no-location-assign-relative-destination`, 1 diretiva `eslint-disable` sem uso em `MessageBox.tsx:3`) | — |
| `npx tsc --noEmit` | OK, sem erros | 16 s |
| `yarn test` (vitest) | OK: 57 arquivos, 407 testes | 29 s |
| `yarn i18n:check` | OK: 282 chaves em cada idioma, 0 avisos | <1 s |
| `yarn build` (`next build --webpack`) | OK. Único aviso: "React 18 support is deprecated in Next.js 16 and will be removed in Next.js 17". 25 rotas (24 dinâmicas, `manifest.webmanifest` estática) e o proxy (middleware). | 142 s |

Tamanhos: `node_modules` 2,2 GB; `.next` 1,2 GB, dos quais 556 MB são cache; `.next/standalone` 642 MB.

**Achado:** o lint local depende de onde o repositório está. Basta acrescentar `.claude/**` ao `globalIgnores` do `eslint.config.mjs` (mudança de uma linha, sem efeito no CI).

## 2. CI (`.github/`)

- `ci.yaml` roda em todo PR e em push na `master`: lint, `tsc`, testes, i18n e build, em Node 24. Os últimos runs na `master` passaram (run 21, de 07/11, sobre `02bd0c7`).
- `docker-build.yaml` roda em push na `master`/`canary` e em releases. **Ele falha em todos os runs recentes (#14, #15, #16)** em cerca de 18 s, no passo `docker/login-action@v2`, com `Username and password required`: o fork não tem os segredos do Docker Hub. Mesmo com os segredos, as tags apontam para `itzcrazykns1337/vane:*`, o namespace do upstream (`docker-build.yaml:47-77,115-119`), onde o fork não pode publicar.
- Consequência: **nenhuma imagem do fork é publicada**, e o `docker-compose.yaml:3` usa `itzcrazykns1337/vane:latest`, a imagem do upstream. Quem sobe pelo compose não recebe nenhuma correção do fork. Isso explica a impressão de que "o Vane não atualizou".
- Avisos: `actions/checkout@v3`, `docker/login-action@v2` e `docker/setup-buildx-action@v2` usam Node 20, que está obsoleto nos runners.
- Possíveis caminhos: publicar no GHCR (`ghcr.io/module195/vane`) com o `GITHUB_TOKEN` e apontar o compose para lá; ou não publicar imagem e mudar o compose para `build: .`. As duas opções mudam o CI e a distribuição, então dependem da sua decisão.

## 3. Dependências

### `yarn audit`: 25 avisos (2 críticos, 5 altos, 15 moderados, 3 baixos) em 1.080 pacotes

Separados pelo que vai para produção:

| Pacote | Severidade | Caminho | Vai para produção? | Leitura |
|---|---|---|---|---|
| `pdfjs-dist` <6.2.108 | alta | `officeparser > pdfjs-dist` | **Sim** | Execução de JS ao abrir um PDF malicioso. O upload de PDF passa por `officeparser` (`uploads/manager.ts:8`). É o item que mais importa. |
| `sharp` <0.35.5 (3 avisos) | alta | `@huggingface/transformers > sharp` | Sim, mas só no provedor Transformers (embeddings locais), que não processa imagens do usuário | Vulnerabilidades da libvips, libheif e librsvg. Risco baixo no uso atual. |
| `fflate` <0.8.3 | moderada | `jspdf > fflate` | No cliente (exportar PDF) | Loop infinito com ZIP malformado; o Vane só gera PDF, não lê ZIP. |
| `baseline-browser-mapping` <2.11.0 | moderada | `next > …` | Build | Encerramento do processo com entrada inválida. |
| `tinypool` ≤2.1.0 (2, críticos), `vitest`/`@vitest/mocker` (3) | crítica/moderada | `vitest` | Não (só testes) | Afetam quem roda os testes com entrada maliciosa. |
| `zod` <4.6.6, `esbuild`, `minimatch` | alta/moderada | `drizzle-kit` | Não (ferramenta de dev) | O `zod` do app já é 4.6.7; o vulnerável é o 3.25.76 que vem com o `drizzle-kit` 0.18. |
| `@babel/core`, `postcss-selector-parser` | baixa/moderada | `eslint-config-next`, `tailwindcss` | Não | Ferramentas de build. |

### Desatualizadas (`yarn outdated`): 39 pacotes

- **Só patch/minor dentro do intervalo do `package.json`** (seguro, `yarn upgrade` resolve): `rfc6902` 5.2→5.4, `ollama` 0.6.3→0.6.4, `officeparser` 6.0.7→6.1.1, `mammoth` 1.12→1.13, `@radix-ui/react-tooltip`, `lightweight-charts`, `motion` 12.38→12.43, `prettier`, `autoprefixer`, `yahoo-finance2` 3.14→3.15, `yet-another-react-lightbox`, `react-syntax-highlighter`, `@tailwindcss/typography`, `jsdom` 29.0→29.1, e `openai` 6.33→6.49. O `openai` é dependência principal, e as notas da 6.x precisam ser lidas antes de subir, por causa do `encoding_format` e do `$schema` (#1233).
- **Major disponível** (dependências principais; cada uma é uma decisão sua): `react`/`react-dom` 18→19 (o Next 17 vai exigir), `openai` 6→7, `better-sqlite3` 11→13, `@huggingface/transformers` 3→4, `@google/genai` 1→3, `drizzle-kit` 0.18→0.31 (corrigiria os avisos de dev), `vitest` 3→5 (corrigiria os críticos de dev), `eslint` 9→10, `typescript` 5.9→7, `tailwindcss` 3→4, `lucide-react`, `markdown-to-jsx` 7→9, `sonner`, `tailwind-merge`, `next-themes`, `react-text-to-speech`, `officeparser` 6→8 (traria um `pdfjs-dist` corrigido, a confirmar).

### Duplicadas

99 dos 938 pacotes do lockfile aparecem em mais de uma versão. As que pesam no bundle ou no servidor: `zod` (3.25.76 via `drizzle-kit` e 4.6.7 no app; só a 4 vai para produção), `pdfjs-dist` (5.4.296 e 5.7.284), `sharp` (0.34.5 e 0.35.5), `esbuild` (0.15 via `drizzle-kit` e 0.28) e `postcss` (8.5.23 e 8.5.32). Nenhuma duplicata vem do código do Vane; todas vêm de dependências transitivas.

## 4. O app rodando

Não há LLM nem SearXNG reais neste container. Para exercitar os fluxos usei um servidor falso (fora do repositório) que responde como um endpoint compatível com OpenAI (`/v1/models`, `/v1/chat/completions` com JSON schema, ferramentas e streaming, `/v1/embeddings`) e como SearXNG (`/search`). O Vane foi configurado pela API, como a interface faz: provedor LM Studio apontando para o servidor falso, URL do SearXNG e setup concluído. Isso testa o encanamento, não a qualidade das respostas.

### Sem Docker (`.next/standalone`, `node server.js`, `DATA_DIR` vazio)

| Fluxo | Resultado |
|---|---|
| Início | Pronto em 0,7 s; as 4 migrações rodaram (`0000`–`0003`) |
| Guarda de origem | POST com `Origin` de outro site → 403 (esperado) |
| Busca speed / balanced / quality (`/api/chat`) | OK: blocos `research`, `source` e `text`, depois `messageEnd`. No balanced, a leitura das 2 páginas falha (sem internet) e o fluxo segue. |
| `/api/search` | OK, com `message` e `sources` |
| `/api/search` sem `chatModel` | **500** "An error has occurred." (issue #1170 do upstream, confirmada) |
| Sugestões (`/api/suggestions`) | OK |
| Upload de `.txt` + busca com o arquivo | OK (upload e embeddings); o modelo falso não escolhe a ferramenta de arquivos, então a busca no arquivo não foi exercitada |
| Histórico (`/api/chats`, `/c/[id]`, `/library`, `/discover`) | OK (200) |
| Apagar conversa | OK |
| Reconnect de sessão inexistente | 404 (esperado) |

**Bug confirmado em execução:** os vetores de embedding vazam para o stream e para o banco. Nos modos speed e balanced, as mensagens NDJSON contêm `"embedding":[…]` em cada resultado da pesquisa, e a coluna `messages.responseBlocks` gravada no SQLite também (balanced: 7,5 kB por mensagem com vetores de 64 dimensões do servidor falso; com o bge-m3 de 1.024 dimensões, cada resultado carrega cerca de 20 kB a mais). No quality o campo aparece vazio (`"embedding":[]`). A origem é `baseSearch.ts:290`, com o `delete` de `:443` agindo só sobre o objeto original (G1-03 em `improvements.md`).

### Com Docker

| Imagem | Build | Tamanho | Pronto em | Fluxos |
|---|---|---|---|---|
| `Dockerfile.slim` (SearXNG externo) | OK, 334 s sem cache | 743 MB em disco (190 MB comprimida) | 2,0 s | speed, balanced e quality OK |
| `Dockerfile` (SearXNG embutido) | OK, 313 s sem cache | 1,04 GB (258 MB comprimida) | 2,9 s | speed OK. O SearXNG embutido responde JSON em `:8080`; os resultados vieram vazios porque o container não tem internet. |

Os builds usaram cópias dos Dockerfiles, fora do repositório, que só acrescentam a confiança no certificado do proxy deste ambiente. Os Dockerfiles do projeto não foram alterados.

Observações sobre as imagens:
- Os dois containers rodam como **root** (`uid=0`), e Node é 24.5.0 (issue #1219 do upstream: CVE corrigido em versões posteriores).
- Na imagem completa, o SearXNG sobe com o **servidor de desenvolvimento do Flask** (`entrypoint.sh:17`, `python -m flask run`), não com o uWSGI; o `uwsgi.ini` é copiado (`Dockerfile:102`) e não usado. O `flask run` usa threads por padrão, mas o próprio Flask avisa que esse servidor não serve para produção; pode virar gargalo quando o researcher faz buscas em paralelo. É hipótese: precisa de medição antes de qualquer mudança.
- O SearXNG tenta baixar listas do ClearURLs e registra os motores `ahmia` e `torch` com erro; isso só gera ruído no log.

## 5. Resumo do que vira trabalho

| Achado | Tipo | Precisa da sua aprovação? |
|---|---|---|
| Imagens do fork nunca são publicadas e o compose usa a imagem do upstream | Distribuição/CI | Sim (muda CI e compose) |
| `pdfjs-dist` vulnerável no caminho de upload de PDF | Segurança | Sim (subir `officeparser` é troca de dependência) |
| Vetores de embedding no stream e no banco | Bug de desempenho | Não para corrigir; a correção não muda prompts nem fontes, mas mudo o formato salvo de `responseBlocks` (remove um campo interno) |
| `/api/search` responde 500 sem `chatModel` | Bug | Não (passa a responder 400, como a documentação promete) |
| Lint local lê `.claude/worktrees` | Ferramenta | Não |
| SearXNG embutido no servidor de desenvolvimento do Flask | Desempenho (hipótese) | Medir primeiro |
| Containers como root, Node 24.5.0 | Segurança | Sim (imagem base) |
