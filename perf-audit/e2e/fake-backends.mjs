/* Deterministic stand-ins for the services Vane talks to, for the
   end-to-end tests: an OpenAI-compatible LLM and embedding server (LM Studio
   style, so the model list comes from /v1/models) and a SearXNG JSON
   endpoint. Nothing here calls a real model or search engine.

   - Structured calls (response_format.json_schema) get a minimal object
     built from the schema.
   - Tool calls: uploads_search first when it is offered, then web_search,
     then done.
   - The writer's streamed answer cites [1] and [2] and names the model, so
     a test can tell which model answered.
   - GET /__writer returns the messages of the last writer call, so a test
     can check what context reached the model (the uploaded file, say).

   Run alone: node perf-audit/e2e/fake-backends.mjs [port] */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const CHAT_MODELS = ['fake-chat', 'fake-chat-2'];
export const EMBEDDING_MODEL = 'fake-embed';

const fromSchema = (s, key = '') => {
  if (!s) return null;
  if (s.anyOf)
    return fromSchema(
      s.anyOf.find((x) => x.type !== 'null') || s.anyOf[0],
      key,
    );
  if (s.enum) return s.enum[0];
  if (s.const !== undefined) return s.const;
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(s.properties || {}))
      o[k] = fromSchema(v, k);
    return o;
  }
  if (t === 'array') {
    const n = Math.max(1, s.minItems || 1);
    return Array.from({ length: n }, () => fromSchema(s.items, key));
  }
  if (t === 'string') return /quer/i.test(key) ? 'vane teste busca' : 'teste';
  if (t === 'number' || t === 'integer') return s.minimum ?? 0;
  if (t === 'boolean') return false;
  return null;
};

/* 64-dimensional character histogram: similar texts get similar vectors. */
const vec = (text) => {
  const v = new Array(64).fill(0);
  for (let i = 0; i < text.length; i++) v[text.charCodeAt(i) % 64] += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
};

const chunk = (delta, finish = null) => ({
  id: 'x',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'fake',
  choices: [{ index: 0, delta, finish_reason: finish }],
});

export const answerFor = (model) =>
  `Resposta de ${model}: o Vane é um motor de respostas que busca na web [1]. Ele resume as fontes [2].`;

export const startFakeBackends = (port = 0) =>
  new Promise((resolve) => {
    const state = { writer: null, requests: [] };

    const sse = (res, chunks) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    const json = (res, body, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      const url = new URL(req.url, 'http://x');
      const j = body ? JSON.parse(body) : {};
      state.requests.push(`${req.method} ${url.pathname}`);

      if (url.pathname === '/__writer') return json(res, state.writer);

      if (url.pathname === '/search') {
        const q = url.searchParams.get('q') || '';
        return json(res, {
          results: [1, 2, 3, 4].map((i) => ({
            title: `Resultado ${i} sobre ${q}`,
            url: `https://example.org/${i}`,
            /* Distinct letters per result, so the character-histogram
               embeddings do not merge them as near duplicates. */
            content: `Trecho ${i} sobre ${q}: ${'abcdefghijklmnopqrstuvwx'
              .slice((i - 1) * 6, i * 6)
              .repeat(12)}`,
            engine: 'fake',
          })),
          suggestions: [],
        });
      }

      if (url.pathname.endsWith('/models')) {
        return json(res, {
          object: 'list',
          data: [...CHAT_MODELS, EMBEDDING_MODEL].map((id) => ({
            id,
            object: 'model',
          })),
        });
      }

      if (url.pathname.endsWith('/embeddings')) {
        const inputs = Array.isArray(j.input) ? j.input : [j.input];
        return json(res, {
          object: 'list',
          model: EMBEDDING_MODEL,
          data: inputs.map((t, i) => ({
            object: 'embedding',
            index: i,
            embedding: vec(String(t)),
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      }

      if (url.pathname.endsWith('/chat/completions')) {
        const usage = {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        };
        if (j.response_format?.json_schema) {
          const content = JSON.stringify(
            fromSchema(j.response_format.json_schema.schema),
          );
          if (j.stream)
            return sse(res, [
              chunk({ role: 'assistant', content }),
              chunk({}, 'stop'),
            ]);
          return json(res, {
            id: 'x',
            object: 'chat.completion',
            model: j.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
              },
            ],
            usage,
          });
        }
        if (j.tools?.length) {
          const names = j.tools.map((t) => t.function.name);
          const used = new Set(
            (j.messages || [])
              .flatMap((m) => m.tool_calls || [])
              .map((c) => c.function?.name),
          );
          const name =
            ['uploads_search', 'web_search'].find(
              (n) => names.includes(n) && !used.has(n),
            ) ?? (names.includes('done') ? 'done' : names[0]);
          const tool = j.tools.find((t) => t.function.name === name);
          const args = JSON.stringify(
            fromSchema(tool.function.parameters) || {},
          );
          return sse(res, [
            chunk({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${name}_${state.requests.length}`,
                  type: 'function',
                  function: { name, arguments: args },
                },
              ],
            }),
            chunk({}, 'tool_calls'),
          ]);
        }
        state.writer = { model: j.model, messages: j.messages };
        const text = answerFor(j.model);
        return sse(res, [
          chunk({ role: 'assistant', content: '' }),
          ...text.match(/.{1,12}/gs).map((p) => chunk({ content: p })),
          chunk({}, 'stop'),
        ]);
      }

      res.writeHead(404);
      res.end();
    });

    server.listen(port, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        state,
        close: () => new Promise((r) => server.close(r)),
      }),
    );
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startFakeBackends(Number(process.argv[2] || 4555));
  console.log('fake backends on', port);
}
