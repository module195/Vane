/* Runs the quality-eval questions through Vane's search agent and saves
   one answer per question and mode.

   Usage (from the repo root):
     EVAL_CHAT_MODEL=qwen/qwen3-8b EVAL_EMBEDDING_MODEL=text-embedding-nomic-embed-text-v1.5 \
       npx tsx perf-audit/eval/run.ts --label referencia-1 [--record] \
       [--modes speed,balanced,quality] [--ids A01,B08] [--path chat|api] [--resume]

   --record   go to the real SearxNG (EVAL_SEARXNG_UPSTREAM) and real pages,
              and save what comes back. Without it, only recorded data is used.
   --path     chat (default): SearchAgent, the pipeline behind /api/chat and
              the UI, with the database writes it does. api: APISearchAgent,
              behind /api/search. The two writers differ, so a change to one
              path is not covered by a run of the other.
   --resume   keep answers already saved under this label and run only the
              missing ones; refuses if the configuration hash changed.
   Output: perf-audit/eval/runs/<label>/<id>.<mode>.json and summary.json.

   Each answer records time to first token, research and writing time,
   tokens (prompt, completion, reasoning) as the server reports them, LLM
   and embedding call counts, the size of the stream and of what is saved,
   and whether an embedding vector leaked into the blocks.
   Nothing in src/ is changed: models, SearxNG URL, upload folder, database
   and scraper are swapped from here. */
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchScraper, SearxngReplayServer } from './lib/replay';
import type { LLMCallStat } from '@/lib/benchmark/instrument';

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
/* EVAL_FIXTURES_DIR only exists for smoke tests of the harness itself. */
const FIXTURES =
  process.env.EVAL_FIXTURES_DIR ??
  path.join(ROOT, 'perf-audit', 'fixtures', 'eval');

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
  const evalPath = (get('path') ?? 'chat') as 'chat' | 'api';
  if (evalPath !== 'chat' && evalPath !== 'api')
    throw new Error('--path must be chat or api');
  return {
    label,
    record: args.includes('--record'),
    resume: args.includes('--resume'),
    evalPath,
    modes: (get('modes') ?? 'speed,balanced,quality').split(',') as Mode[],
    ids: get('ids')?.split(','),
  };
};

/* Hash of everything that should make two runs comparable: model setup,
   agent path, questions, judge prompt and the prompts in src/. A change in
   any of them is a new configuration (search_evals does the same). */
const hashFiles = (dir: string, h: crypto.Hash) => {
  for (const f of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) {
      if (f.name !== '__tests__') hashFiles(p, h);
    } else {
      h.update(f.name).update(fs.readFileSync(p));
    }
  }
};

const configHash = (parts: Record<string, unknown>) => {
  const h = crypto.createHash('sha256').update(JSON.stringify(parts));
  h.update(fs.readFileSync(path.join(EVAL_DIR, 'questions.json')));
  h.update(fs.readFileSync(path.join(EVAL_DIR, 'judge-prompt.md')));
  hashFiles(path.join(ROOT, 'src', 'lib', 'prompts'), h);
  return h.digest('hex').slice(0, 12);
};

const gitHead = () => {
  try {
    const head = execSync('git rev-parse --short HEAD', { cwd: ROOT })
      .toString()
      .trim();
    const dirty = execSync('git status --porcelain -- src', { cwd: ROOT })
      .toString()
      .trim();
    return dirty ? `${head}+alterado` : head;
  } catch {
    return 'desconhecido';
  }
};

const EMBEDDING_RE = /"embedding":\[\s*-?\d/;

const sumUsage = (calls: LLMCallStat[]) => {
  const total = {
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    reasoningChars: 0,
    callsWithUsage: 0,
  };
  for (const c of calls) {
    if (!c.usage) continue;
    total.callsWithUsage++;
    total.promptTokens += c.usage.promptTokens ?? 0;
    total.completionTokens += c.usage.completionTokens ?? 0;
    total.reasoningTokens += c.usage.reasoningTokens ?? 0;
    total.reasoningChars += c.usage.reasoningChars ?? 0;
  }
  return total;
};

const main = async () => {
  const opts = parseArgs();
  const outDir = path.join(EVAL_DIR, 'runs', opts.label);
  if (fs.existsSync(path.join(outDir, 'summary.json')) && !opts.resume) {
    throw new Error(
      `runs/${opts.label} already exists; use another --label or --resume`,
    );
  }
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

  /* The chat path saves each answer in the database, as the app does; the
     temporary DATA_DIR gets its own migrated db.sqlite. */
  const { runMigrations } = await import('@/lib/db/migrate');
  runMigrations();
  const { default: db } = await import('@/lib/db');
  const { messages } = await import('@/lib/db/schema');
  const { and, eq } = await import('drizzle-orm');

  const { default: SessionManager } = await import('@/lib/session');
  const { default: APISearchAgent } = await import('@/lib/agents/search/api');
  const { default: SearchAgent } = await import('@/lib/agents/search');
  const { InstrumentedLLM, InstrumentedEmbedding, newRecorder } =
    await import('@/lib/benchmark/instrument');
  const { runTraced } = await import('@/lib/trace');
  const { createModels, readModelEnv } = await import('./lib/models');

  const modelEnv = readModelEnv();
  const base = createModels(modelEnv);
  /* One recorder per answer; the wrappers read it through this holder. */
  let rec = newRecorder();
  const recProxy = new Proxy({} as ReturnType<typeof newRecorder>, {
    get: (_t, k) => (rec as any)[k],
  });
  const llm = new InstrumentedLLM(base.llm, recProxy);
  const embedding = new InstrumentedEmbedding(base.embedding, recProxy);

  const hash = configHash({
    path: opts.evalPath,
    endpoint: modelEnv.baseURL,
    chat: modelEnv.chatModel,
    embedding: `${modelEnv.embeddingProvider}:${modelEnv.embeddingModel}`,
    scraper: process.env.FIRECRAWL_API_URL ? 'firecrawl' : 'readability',
  });
  const prevSummary = path.join(outDir, 'summary.json');
  if (opts.resume && fs.existsSync(prevSummary)) {
    const prev = JSON.parse(fs.readFileSync(prevSummary, 'utf-8'));
    if (prev.configHash && prev.configHash !== hash) {
      throw new Error(
        `--resume: configuration changed (${prev.configHash} -> ${hash}); start a new label`,
      );
    }
  }

  const questions: Question[] = JSON.parse(
    fs.readFileSync(path.join(EVAL_DIR, 'questions.json'), 'utf-8'),
  ).questions.filter((q: Question) => !opts.ids || opts.ids.includes(q.id));

  /* Each upload fixture is processed once per run, like a user upload. */
  const uploadManager = new UploadManager({ embeddingModel: base.embedding });
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
      const outFile = path.join(outDir, `${q.id}.${mode}.json`);
      if (opts.resume && fs.existsSync(outFile)) {
        const old = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
        summary.push(old.summaryRow);
        console.log(`${q.id} ${mode.padEnd(8)} (mantida)`);
        continue;
      }

      const missesBefore = searxng.misses.length;
      const pageMissesBefore = scraper.misses.length;
      rec = newRecorder();
      const started = performance.now();
      const since = () => Math.round(performance.now() - started);
      let firstTokenMs: number | null = null;
      let researchDoneMs: number | null = null;
      let streamBytes = 0;
      let embeddingInStream = false;

      const chatId = crypto.randomUUID();
      const messageId = crypto.randomUUID();
      const session = SessionManager.createSession();
      const result = await new Promise<{
        message: string;
        sources: any[];
        error?: string;
      }>(async (resolve) => {
        let message = '';
        let sources: any[] = [];
        session.subscribe((event: string, data: any) => {
          if (event === 'data') {
            const raw = JSON.stringify(data);
            streamBytes += raw.length;
            if (!embeddingInStream && EMBEDDING_RE.test(raw))
              embeddingInStream = true;
            if (data.type === 'researchComplete') researchDoneMs ??= since();
            /* api path */
            if (data.type === 'response') {
              firstTokenMs ??= since();
              message += data.data;
            } else if (data.type === 'searchResults') {
              sources = data.data;
            }
            /* chat path */
            if (data.type === 'block' && data.block?.type === 'text')
              firstTokenMs ??= since();
          } else if (event === 'end') {
            if (opts.evalPath === 'chat') {
              const blocks = session.getAllBlocks() as any[];
              message = blocks
                .filter((b) => b.type === 'text')
                .map((b) => b.data)
                .join('');
              sources = blocks
                .filter((b) => b.type === 'source')
                .flatMap((b) => b.data ?? []);
            }
            resolve({ message, sources });
          } else if (event === 'error') {
            resolve({ message, sources, error: JSON.stringify(data) });
          }
        });

        try {
          const ids = await Promise.all((q.files ?? []).map(fileIdFor));
          const input = {
            chatHistory: (q.history ?? []).map(([role, content]) => ({
              role: (role === 'human' ? 'user' : 'assistant') as
                | 'user'
                | 'assistant',
              content,
            })),
            followUp: q.query,
            config: {
              llm,
              embedding,
              sources: q.sources,
              mode,
              fileIds: ids,
              systemInstructions: '',
            },
            chatId,
            messageId,
          };
          const agent =
            opts.evalPath === 'chat' ? new SearchAgent() : new APISearchAgent();
          await runTraced(
            (e) => rec.events.push(e),
            () => agent.searchAsync(session, input as any),
          );
        } catch (err: any) {
          resolve({
            message: '',
            sources: [],
            error: String(err?.message ?? err),
          });
        }
      });

      /* The chat agent saves after 'end'; give it a moment to land. */
      let storedBytes: number | null = null;
      let embeddingInDb = false;
      if (opts.evalPath === 'chat') {
        await new Promise((r) => setTimeout(r, 50));
        const row = await db.query.messages.findFirst({
          where: and(
            eq(messages.chatId, chatId),
            eq(messages.messageId, messageId),
          ),
        });
        const saved = JSON.stringify(row?.responseBlocks ?? []);
        storedBytes = saved.length;
        embeddingInDb = EMBEDDING_RE.test(saved);
      }

      const totalMs = since();
      const calls = rec.llm;
      const firstCall = [...calls].sort((a, b) => a.startMs - b.startMs)[0];
      const record = {
        id: q.id,
        group: q.group,
        mode,
        path: opts.evalPath,
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
          totalMs,
          firstTokenMs,
          /* First LLM call is the classifier on both paths. */
          classifyMs: firstCall ? firstCall.ms : null,
          researchMs: researchDoneMs,
          writeMs: researchDoneMs === null ? null : totalMs - researchDoneMs,
        },
        tokens: sumUsage(calls),
        llmCalls: {
          count: calls.length,
          errors: calls.filter((c) => c.error).length,
          byKind: calls.reduce<Record<string, number>>((acc, c) => {
            acc[c.kind] = (acc[c.kind] ?? 0) + 1;
            return acc;
          }, {}),
        },
        embeddingCalls: {
          count: rec.embedding.length,
          texts: rec.embedding.reduce((n, e) => n + e.texts, 0),
          ms: rec.embedding.reduce((n, e) => n + e.ms, 0),
        },
        bytes: { stream: streamBytes, stored: storedBytes },
        leaks:
          opts.evalPath === 'chat'
            ? { embeddingInStream, embeddingInDb }
            : undefined,
        replayMisses: {
          searxng: searxng.misses.slice(missesBefore),
          pages: scraper.misses.slice(pageMissesBefore),
        },
      } as any;
      record.summaryRow = {
        id: q.id,
        mode,
        ok: !result.error,
        totalMs,
        firstTokenMs,
        llmCalls: record.llmCalls.count,
        promptTokens: record.tokens.promptTokens,
        completionTokens: record.tokens.completionTokens,
        reasoningTokens: record.tokens.reasoningTokens,
        sources: record.sources.length,
        searxngMisses: record.replayMisses.searxng.length,
        pageMisses: record.replayMisses.pages.length,
      };

      fs.writeFileSync(outFile, JSON.stringify(record, null, 2));
      summary.push(record.summaryRow);
      console.log(
        `${q.id} ${mode.padEnd(8)} ${totalMs}ms 1º token=${firstTokenMs ?? '-'}ms calls=${record.llmCalls.count} tokens=${record.tokens.promptTokens}+${record.tokens.completionTokens} (raciocínio ${record.tokens.reasoningTokens}) sources=${record.sources.length}` +
          (result.error ? ' ERRO' : ''),
      );
    }
  }

  /* With --resume and a subset of --ids, keep the rows of the rest. */
  const mergedRuns = (() => {
    const rows = new Map<string, any>();
    if (opts.resume && fs.existsSync(prevSummary)) {
      for (const r of JSON.parse(fs.readFileSync(prevSummary, 'utf-8')).runs ??
        [])
        rows.set(`${r.id}.${r.mode}`, r);
    }
    for (const r of summary) rows.set(`${r.id}.${r.mode}`, r);
    return [...rows.values()];
  })();

  const totalSearches = searxng.hits.length + searxng.misses.length;
  fs.writeFileSync(
    path.join(outDir, 'summary.json'),
    JSON.stringify(
      {
        label: opts.label,
        configHash: hash,
        commit: gitHead(),
        path: opts.evalPath,
        recordedAt: new Date().toISOString(),
        record: opts.record,
        model: {
          endpoint: modelEnv.baseURL,
          chat: modelEnv.chatModel,
          embedding: `${modelEnv.embeddingProvider}:${modelEnv.embeddingModel}`,
        },
        scraper: process.env.FIRECRAWL_API_URL ? 'firecrawl' : 'readability',
        searxngMissRate: totalSearches
          ? searxng.misses.length / totalSearches
          : 0,
        pageMisses: scraper.misses.length,
        runs: mergedRuns,
      },
      null,
      2,
    ),
  );

  await searxng.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  /* Timers in the app (model-list cache, sessions) would keep node alive. */
  process.exit(0);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
