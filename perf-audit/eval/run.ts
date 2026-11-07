/* Runs the quality-eval questions through Vane's search agent and saves
   one answer per question and mode.

   Usage (from the repo root):
     EVAL_CHAT_MODEL=qwen/qwen3-8b EVAL_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5 \
       npx tsx perf-audit/eval/run.ts --label referencia-1 [--record] \
       [--modes speed,balanced,quality] [--ids A01,B08]

   --record   go to the real SearxNG (EVAL_SEARXNG_UPSTREAM) and real pages,
              and save what comes back. Without it, only recorded data is used.
   Output: perf-audit/eval/runs/<label>/<id>.<mode>.json and summary.json.
   Each task records time to first token, tokens (input, output, reasoning,
   when the server reports them), calls per stage and stream bytes; set
   EVAL_PRICE_INPUT_PER_M / EVAL_PRICE_OUTPUT_PER_M (USD) to get a cost.
   summary.json carries a configHash: runs with different hashes used
   different models or scraper and are not comparable.

   The agent is APISearchAgent, the same pipeline /api/search uses
   (classifier, widgets, researcher, writer). Nothing in src/ is changed:
   models, SearxNG URL, upload folder and scraper are swapped from here. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchScraper, SearxngReplayServer } from './lib/replay';

type Question = {
  id: string;
  group: string;
  query: string;
  sources: ('web' | 'academic' | 'discussions')[];
  files?: string[];
  history?: [string, string][];
  expectSkipSearch?: boolean;
};

type Mode = 'speed' | 'balanced' | 'quality';

const ROOT = path.resolve(__dirname, '..', '..');
const EVAL_DIR = path.join(ROOT, 'perf-audit', 'eval');
const FIXTURES = path.join(ROOT, 'perf-audit', 'fixtures', 'eval');

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const get = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const label = get('label');
  if (!label || !/^[a-zA-Z0-9._-]+$/.test(label)) {
    throw new Error('--label is required (letters, digits, . _ -)');
  }
  return {
    label,
    record: args.includes('--record'),
    modes: (get('modes') ?? 'speed,balanced,quality').split(',') as Mode[],
    ids: get('ids')?.split(','),
  };
};

const main = async () => {
  const opts = parseArgs();
  const outDir = path.join(EVAL_DIR, 'runs', opts.label);
  fs.mkdirSync(outDir, { recursive: true });

  /* Isolated data dir: fresh config.json and an empty uploads folder, so the
     run never reads or writes the user's own chats, files or settings. */
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-eval-'));
  process.env.DATA_DIR = dataDir;
  fs.mkdirSync(path.join(dataDir, 'data'), { recursive: true });

  const searxng = new SearxngReplayServer({
    mode: opts.record ? 'record' : 'replay',
    fixturesDir: path.join(FIXTURES, 'searxng'),
    upstreamURL: process.env.EVAL_SEARXNG_UPSTREAM,
  });
  const searxngURL = await searxng.start();

  /* Imported after DATA_DIR is set: the config module reads it on load. */
  const { default: configManager } = await import('@/lib/config');
  configManager.updateConfig('search.searxngURL', searxngURL);
  /* Web search always goes through the SearxNG stand-in, even when
     FIRECRAWL_API_URL is set (that env only changes the page scraper). */
  configManager.updateConfig('search.provider', 'searxng');

  const { default: UploadManager } = await import('@/lib/uploads/manager');
  UploadManager.uploadsDir = path.join(dataDir, 'uploads');
  UploadManager.uploadedFilesRecordPath = path.join(
    UploadManager.uploadsDir,
    'uploaded_files.json',
  );

  const { default: Scraper } = await import('@/lib/scraper');
  const scraper = patchScraper(Scraper as any, {
    mode: opts.record ? 'record' : 'replay',
    fixturesDir: path.join(FIXTURES, 'pages'),
  });

  const { default: SessionManager } = await import('@/lib/session');
  const { default: APISearchAgent } = await import('@/lib/agents/search/api');
  const { createModels, readModelEnv } = await import('./lib/models');
  const { InstrumentedLLM, newRecorder } =
    await import('@/lib/benchmark/instrument');
  const { runTraced } = await import('@/lib/trace');
  const { configHash, costOf, modeSummary, readPrice, taskMetrics } =
    await import('./lib/metrics');
  const price = readPrice();

  const modelEnv = readModelEnv();
  const { llm, embedding } = createModels(modelEnv);

  const questions: Question[] = JSON.parse(
    fs.readFileSync(path.join(EVAL_DIR, 'questions.json'), 'utf-8'),
  ).questions.filter((q: Question) => !opts.ids || opts.ids.includes(q.id));

  /* Each upload fixture is processed once per run, like a user upload. */
  const uploadManager = new UploadManager({ embeddingModel: embedding });
  const fileIds = new Map<string, string>();
  const fileIdFor = async (name: string) => {
    if (fileIds.has(name)) return fileIds.get(name)!;
    const buf = fs.readFileSync(path.join(FIXTURES, 'uploads', name));
    const ext = name.split('.').pop()!.toLowerCase();
    const [res] = await uploadManager.processFiles([
      new File([buf], name, { type: MIME[ext] }),
    ]);
    fileIds.set(name, res.fileId);
    return res.fileId;
  };

  const summary: any[] = [];

  for (const q of questions) {
    for (const mode of opts.modes) {
      const missesBefore = searxng.misses.length;
      const pageMissesBefore = scraper.misses.length;
      const statsBefore = llm.stats.length;
      const started = performance.now();
      let firstTokenMs: number | null = null;
      let streamBytes = 0;
      /* Times every call and collects the token counts the server reports
         (only sizes and counts; no prompt or answer text). */
      const rec = newRecorder();
      const taskLLM = new InstrumentedLLM(llm, rec);

      const session = SessionManager.createSession();
      const result = await new Promise<{
        message: string;
        sources: any[];
        error?: string;
      }>(async (resolve) => {
        let message = '';
        let sources: any[] = [];
        session.subscribe((event: string, data: any) => {
          if (event === 'data')
            streamBytes += Buffer.byteLength(JSON.stringify(data));
          if (event === 'data' && data.type === 'response') {
            if (firstTokenMs === null)
              firstTokenMs = performance.now() - started;
            message += data.data;
          } else if (event === 'data' && data.type === 'searchResults') {
            sources = data.data;
          } else if (event === 'end') {
            resolve({ message, sources });
          } else if (event === 'error') {
            resolve({ message, sources, error: JSON.stringify(data) });
          }
        });

        try {
          const ids = await Promise.all((q.files ?? []).map(fileIdFor));
          const run = () =>
            new APISearchAgent().searchAsync(session, {
              chatHistory: (q.history ?? []).map(([role, content]) => ({
                role: role === 'human' ? 'user' : 'assistant',
                content,
              })),
              followUp: q.query,
              config: {
                llm: taskLLM,
                embedding,
                sources: q.sources,
                mode,
                fileIds: ids,
                systemInstructions: '',
              },
              chatId: crypto.randomUUID(),
              messageId: crypto.randomUUID(),
            });
          await runTraced((e) => rec.events.push(e), run);
        } catch (err: any) {
          resolve({
            message: '',
            sources: [],
            error: String(err?.message ?? err),
          });
        }
      });

      const calls = llm.stats.slice(statsBefore);
      const metrics = taskMetrics(rec.llm, streamBytes);
      const record = {
        id: q.id,
        group: q.group,
        mode,
        query: q.query,
        expectSkipSearch: q.expectSkipSearch ?? false,
        answer: result.message,
        sources: result.sources.map((s: any) => ({
          title: s.metadata?.title,
          url: s.metadata?.url,
          content: s.content,
        })),
        error: result.error,
        timing: {
          totalMs: Math.round(performance.now() - started),
          firstTokenMs: firstTokenMs === null ? null : Math.round(firstTokenMs),
        },
        llmCalls: {
          count: calls.length,
          byKind: calls.reduce<Record<string, number>>((acc, c) => {
            acc[c.kind] = (acc[c.kind] ?? 0) + 1;
            return acc;
          }, {}),
          byStage: metrics.byStage,
        },
        tokens: metrics.tokens,
        costUSD: costOf(metrics.tokens, price),
        streamBytes: metrics.streamBytes,
        replayMisses: {
          searxng: searxng.misses.slice(missesBefore),
          pages: scraper.misses.slice(pageMissesBefore),
        },
      };

      fs.writeFileSync(
        path.join(outDir, `${q.id}.${mode}.json`),
        JSON.stringify(record, null, 2),
      );
      summary.push({
        id: q.id,
        mode,
        ok: !result.error,
        totalMs: record.timing.totalMs,
        firstTokenMs: record.timing.firstTokenMs,
        tokens: metrics.tokens,
        costUSD: record.costUSD,
        llmCalls: record.llmCalls.count,
        sources: record.sources.length,
        searxngMisses: record.replayMisses.searxng.length,
        pageMisses: record.replayMisses.pages.length,
      });
      console.log(
        `${q.id} ${mode.padEnd(8)} ${record.timing.totalMs}ms ttft=${record.timing.firstTokenMs ?? '-'}ms tokens=${metrics.tokens.prompt}/${metrics.tokens.completion}/${metrics.tokens.reasoning} calls=${record.llmCalls.count} sources=${record.sources.length}` +
          (result.error ? ' ERRO' : ''),
      );
    }
  }

  const totalSearches = searxng.hits.length + searxng.misses.length;
  const model = {
    endpoint: modelEnv.baseURL,
    chat: modelEnv.chatModel,
    embedding: `${modelEnv.embeddingProvider}:${modelEnv.embeddingModel}`,
  };
  const scraperKind = process.env.FIRECRAWL_API_URL
    ? 'firecrawl'
    : 'readability';
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        label: opts.label,
        recordedAt: new Date().toISOString(),
        record: opts.record,
        model,
        scraper: scraperKind,
        configHash: configHash({
          model,
          scraper: scraperKind,
          record: opts.record,
        }),
        price: price ?? null,
        byMode: modeSummary(summary),
        searxngMissRate: totalSearches
          ? searxng.misses.length / totalSearches
          : 0,
        pageMisses: scraper.misses.length,
        runs: summary,
      },
      null,
      2,
    ),
  );

  await searxng.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  /* The scraper keeps a browser alive for 30 s; do not wait for it. */
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
