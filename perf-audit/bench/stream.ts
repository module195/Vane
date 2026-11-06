/* Measures the internal answer stream (/api/chat and /api/reconnect).

   Runs the real SearchAgent with a fake writer LLM that streams N tokens,
   on a throwaway SQLite in a temp DATA_DIR (no network, no model). The
   live stream is read through POST /api/reconnect subscribed before the
   agent starts (same serialization as /api/chat), and a second reconnect
   is opened halfway through the answer to measure the replay.

   Usage: npx tsx perf-audit/bench/stream.ts [--tokens 2000] [--runs 5] */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? Number(process.argv[i + 1]) : def;
};

const TOKENS = arg('tokens', 2000);
const RUNS = arg('runs', 5);

const WORDS = [
  ' o',
  ' Rust',
  ' usa',
  ' ownership',
  ' para',
  ' garantir',
  ' segurança',
  ' de',
  ' memória',
  ' sem',
  ' coletor',
  ' [1]',
  '.',
  '\n\n##',
  ' Concorrência',
];
const tokens = Array.from(
  { length: TOKENS },
  (_, i) => WORDS[i % WORDS.length],
);
const expectedText = tokens.join('');

const setupDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-stream-bench-'));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.symlinkSync(path.resolve('drizzle'), path.join(dir, 'drizzle'));
  process.env.DATA_DIR = dir;
  return dir;
};

type Capture = {
  lines: number;
  bytes: number;
  text: string;
  types: Record<string, number>;
};

/* Reads an NDJSON response body to the end, counting bytes and lines, and
   rebuilds the answer text the way the client does. */
const readStream = async (res: Response): Promise<Capture> => {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let bytes = 0;
  let lines = 0;
  const types: Record<string, number> = {};
  const blocks = new Map<string, any>();
  const { applyPatch } = await import('rfc6902');
  const handle = (line: string) => {
    if (!line.trim()) return;
    lines++;
    const msg = JSON.parse(line);
    types[msg.type] = (types[msg.type] ?? 0) + 1;
    if (msg.type === 'block')
      blocks.set(msg.block.id, structuredClone(msg.block));
    else if (msg.type === 'updateBlock') {
      const b = blocks.get(msg.blockId);
      if (b) applyPatch(b, msg.patch);
    } else if (msg.type === 'appendText') {
      const b = blocks.get(msg.blockId);
      if (b) b.data += msg.delta;
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    parts.forEach(handle);
  }
  handle(buf);
  const text = [...blocks.values()].find((b) => b.type === 'text')?.data ?? '';
  return { lines, bytes, text, types };
};

const main = async () => {
  setupDataDir();
  await import('../../src/lib/db/migrate');
  const { default: SessionManager } = await import('../../src/lib/session');
  const { default: SearchAgent } = await import('../../src/lib/agents/search');
  const { POST: reconnect } =
    await import('../../src/app/api/reconnect/[id]/route');
  const { FakeLLM, FakeEmbedding } =
    await import('../../src/__tests__/helpers/fakes');

  const openReconnect = (id: string) =>
    reconnect(
      new Request(`http://bench/api/reconnect/${id}`, { method: 'POST' }),
      {
        params: Promise.resolve({ id }),
      },
    );

  const results: any[] = [];

  for (let run = 0; run < RUNS; run++) {
    const session = SessionManager.createSession();
    let midReconnect: Promise<Capture> | null = null;

    class BenchLLM extends FakeLLM {
      async *streamText(input: any): AsyncGenerator<any> {
        this.calls.push({ kind: 'streamText', input });
        // Real OpenAI-compatible streams open with an empty role chunk and
        // close with an empty finish_reason chunk.
        yield { contentChunk: '', toolCallChunk: [] };
        for (let i = 0; i < tokens.length; i++) {
          if (i === Math.floor(tokens.length / 2)) {
            midReconnect = openReconnect(session.id).then(readStream);
            await new Promise((r) => setTimeout(r, 0));
          }
          yield { contentChunk: tokens[i], toolCallChunk: [] };
        }
        yield { contentChunk: '', toolCallChunk: [], done: true };
      }
    }

    const llm = new BenchLLM({
      generateObject: () => ({
        classification: {
          skipSearch: true,
          personalSearch: false,
          academicSearch: false,
          discussionSearch: false,
          showWeatherWidget: false,
          showStockWidget: false,
          showCalculationWidget: false,
        },
        standaloneFollowUp: 'q',
      }),
    });

    const live = openReconnect(session.id).then(readStream);
    await new Promise((r) => setTimeout(r, 0));

    const t0 = performance.now();
    await new SearchAgent().searchAsync(session, {
      chatHistory: [],
      followUp: 'q',
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
    const liveCap = await live;
    const ms = performance.now() - t0;
    const midCap = await midReconnect!;
    const endCap = await openReconnect(session.id).then(readStream);

    const retained = (session as any).events
      ? Buffer.byteLength(JSON.stringify((session as any).events))
      : 0;

    if (liveCap.text !== expectedText) throw new Error('live text mismatch');
    if (midCap.text !== expectedText)
      throw new Error('mid reconnect text mismatch');
    if (endCap.text !== expectedText)
      throw new Error('end reconnect text mismatch');

    results.push({
      run,
      liveLines: liveCap.lines,
      liveBytes: liveCap.bytes,
      liveTypes: liveCap.types,
      midReconnectLines: midCap.lines,
      midReconnectBytes: midCap.bytes,
      endReconnectLines: endCap.lines,
      endReconnectBytes: endCap.bytes,
      retainedEventBytes: retained,
      agentMs: Math.round(ms),
    });
  }

  const stat = (k: string) => {
    const v = results.map((r) => r[k]);
    const mean = v.reduce((a, b) => a + b, 0) / v.length;
    return { min: Math.min(...v), max: Math.max(...v), mean: Math.round(mean) };
  };

  console.log(
    `tokens=${TOKENS} answerChars=${expectedText.length} runs=${RUNS}`,
  );
  console.log('liveTypes', results[0].liveTypes);
  for (const k of [
    'liveLines',
    'liveBytes',
    'midReconnectLines',
    'midReconnectBytes',
    'endReconnectLines',
    'endReconnectBytes',
    'retainedEventBytes',
    'agentMs',
  ]) {
    console.log(k.padEnd(20), JSON.stringify(stat(k)));
  }
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
