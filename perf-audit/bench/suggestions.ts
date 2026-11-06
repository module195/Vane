/* Measures "answer ended -> follow-up suggestions available".

   Before: the client got messageEnd, then POSTed /api/suggestions; the
   route loaded the chat model (LM Studio lists its models over HTTP) and
   called the model. After: SearchAgent generates them right after the
   writer and sends them on the same stream (answerEnd -> suggestion block).

   Everything runs locally against a fake LM Studio / SearXNG HTTP server
   with fixed latencies (no real model): the chat completion for the
   suggestions takes --llm ms and GET /v1/models takes --models ms. The
   real SearchAgent runs on a throwaway SQLite (temp DATA_DIR) with the
   real LM Studio provider; the "before" request goes through a local HTTP
   server hosting the real /api/suggestions route handler, with the same
   chat history the old client sent.

   Usage: npx tsx perf-audit/bench/suggestions.ts [--runs 5] [--llm 300] [--models 5] */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? Number(process.argv[i + 1]) : def;
};

const RUNS = arg('runs', 5);
const LLM_MS = arg('llm', 300);
const MODELS_MS = arg('models', 5);
/* Latency of the other model calls (classifier, researcher, writer). */
const OTHER_MS = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const classification = {
  classification: {
    skipSearch: false,
    personalSearch: false,
    academicSearch: false,
    discussionSearch: false,
    showWeatherWidget: false,
    showStockWidget: false,
    showCalculationWidget: false,
  },
  standaloneFollowUp: 'Rust para web?',
};

const chunk = (delta: Record<string, any>, finish: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'x',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'm',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const readBody = (req: http.IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });

/* Fake LM Studio (OpenAI-compatible) + SearXNG. */
const startFakeBackend = () =>
  new Promise<string>((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.endsWith('/models')) {
        await sleep(MODELS_MS);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'm' }] }));
        return;
      }
      if (req.method === 'GET' && url.startsWith('/search')) {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            results: [
              {
                title: 'Rust na web',
                url: 'https://a.test/rust',
                // Similar enough to the query for the speed-mode reranker.
                content: 'rust web async',
              },
            ],
            suggestions: [],
          }),
        );
        return;
      }
      if (req.method === 'POST' && url.endsWith('/chat/completions')) {
        const body = JSON.parse(await readBody(req));
        const system = String(body.messages?.[0]?.content ?? '');
        if (!body.stream) {
          const isSuggestions = system.includes('suggestion generator');
          await sleep(isSuggestions ? LLM_MS : OTHER_MS);
          const content = isSuggestions
            ? { suggestions: ['Axum ou Actix?', 'Rust no front-end?'] }
            : classification;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              id: 'x',
              object: 'chat.completion',
              created: 0,
              model: 'm',
              choices: [
                {
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: JSON.stringify(content),
                  },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
          return;
        }
        await sleep(OTHER_MS);
        res.setHeader('Content-Type', 'text/event-stream');
        if (body.tools?.length) {
          const searched = body.messages.some((m: any) => m.role === 'tool');
          const call = searched
            ? { name: 'done', arguments: '{}' }
            : { name: 'web_search', arguments: '{"queries":["rust web"]}' };
          res.write(
            chunk({
              tool_calls: [
                { index: 0, id: 'c1', type: 'function', function: call },
              ],
            }),
          );
          res.write(chunk({}, 'tool_calls'));
        } else {
          for (const t of ['Rust ', 'serve ', 'para ', 'web [1].']) {
            res.write(chunk({ content: t }));
          }
          res.write(chunk({}, 'stop'));
        }
        res.end('data: [DONE]\n\n');
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });

/* Hosts a Next route handler on a local HTTP port (the old client's hop). */
const startRouteServer = (handler: (req: Request) => Promise<Response>) =>
  new Promise<string>((resolve) => {
    const server = http.createServer(async (req, res) => {
      const body = await readBody(req);
      const response = await handler(
        new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      );
      res.statusCode = response.status;
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`),
    );
  });

const stats = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    min: Math.round(sorted[0]),
    median: Math.round(sorted[Math.floor(sorted.length / 2)]),
    max: Math.round(sorted[sorted.length - 1]),
    mean: Math.round(mean),
  };
};

const main = async () => {
  const backend = await startFakeBackend();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-sugg-bench-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.symlinkSync(path.resolve('drizzle'), path.join(dir, 'drizzle'));
  process.env.DATA_DIR = dir;
  process.env.SEARXNG_API_URL = backend;

  await import('../../src/lib/db/migrate');
  const { default: configManager } = await import('../../src/lib/config');
  const provider = configManager.addModelProvider('lmstudio', 'bench', {
    baseURL: backend,
  });
  const { default: ModelRegistry } =
    await import('../../src/lib/models/registry');
  const { default: SessionManager } = await import('../../src/lib/session');
  const { default: SearchAgent } = await import('../../src/lib/agents/search');
  const { POST: suggestionsRoute } =
    await import('../../src/app/api/suggestions/route');
  const { FakeEmbedding } = await import('../../src/__tests__/helpers/fakes');

  const routeURL = await startRouteServer(suggestionsRoute);

  const before: number[] = [];
  const after: number[] = [];

  for (let run = 0; run < RUNS; run++) {
    const llm = await new ModelRegistry().loadChatModel(provider.id, 'm');
    const session = SessionManager.createSession();
    const marks: Record<string, number> = {};
    let suggestions: string[] = [];
    session.subscribe((event, data) => {
      const now = performance.now();
      if (event === 'data' && data.type === 'answerEnd') marks.answerEnd = now;
      if (
        event === 'data' &&
        data.type === 'block' &&
        data.block.type === 'suggestion'
      ) {
        marks.suggestions = now;
        suggestions = data.block.data;
      }
    });

    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: 'Rust serve para web?',
      chatId: `bench-${run}`,
      messageId: `m-${run}`,
      config: {
        llm,
        embedding: new FakeEmbedding(),
        sources: ['web'],
        mode: 'speed',
        fileIds: [],
        systemInstructions: '',
      },
    });

    if (!marks.answerEnd || !marks.suggestions || suggestions.length === 0) {
      throw new Error(`run ${run}: no suggestions on the stream`);
    }
    after.push(marks.suggestions - marks.answerEnd);

    // Old flow, timed from the moment the client had messageEnd.
    const answer = session.getAllBlocks().find((b) => b.type === 'text')!
      .data as string;
    const t0 = performance.now();
    const res = await fetch(`${routeURL}/api/suggestions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chatHistory: [
          ['human', 'Rust serve para web?'],
          ['assistant', answer],
        ],
        chatModel: { providerId: provider.id, key: 'm' },
      }),
    });
    const body = await res.json();
    if (!Array.isArray(body.suggestions) || body.suggestions.length === 0) {
      throw new Error(`run ${run}: /api/suggestions failed`);
    }
    before.push(performance.now() - t0);
  }

  console.log(
    JSON.stringify(
      {
        runs: RUNS,
        suggestionLLMms: LLM_MS,
        modelListMs: MODELS_MS,
        beforeMessageEndToSuggestionsMs: stats(before),
        afterAnswerEndToSuggestionsMs: stats(after),
        rawBefore: before.map(Math.round),
        rawAfter: after.map(Math.round),
      },
      null,
      2,
    ),
  );
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
