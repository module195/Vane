/* Time spent reading uploaded files for one research query.

   Builds 5 synthetic uploads of ~2 MB .content.json each (768-dim vectors,
   written indented like UploadManager does) in a temp DATA_DIR, then simulates
   one balanced-mode query: 6 researcher prompts (each lists the first chunks
   of every file) plus one uploads_search call. Repeats the query several
   times in the same process, as a server would.

   Run: npx tsx perf-audit/bench/uploads-cache.ts */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILES = 5;
const DIM = 768;
const CHUNK_TEXT = 'lorem ipsum dolor sit amet '.repeat(19); // ~512 chars
const QUERIES = 8;
const ITERATIONS = 6; // balanced mode

const rand = (seed: number) => (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648 - 0.5;
};

const main = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-bench-uploads-'));
  process.env.DATA_DIR = root;
  const uploadsDir = path.join(root, 'data', 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });

  const r = rand(42);
  const records = [];
  for (let f = 0; f < FILES; f++) {
    const chunks: { content: string; embedding: number[] }[] = [];
    let size = 0;
    while (size < 2 * 1024 * 1024) {
      const chunk: { content: string; embedding: number[] } = {
        content: `${f}-${chunks.length} ${CHUNK_TEXT}`,
        embedding: Array.from({ length: DIM }, r),
      };
      size += JSON.stringify(chunk, null, 2).length;
      chunks.push(chunk);
    }
    const contentPath = path.join(uploadsDir, `f${f}.content.json`);
    fs.writeFileSync(contentPath, JSON.stringify({ chunks }, null, 2));
    records.push({
      id: `f${f}`,
      name: `file${f}.txt`,
      filePath: path.join(uploadsDir, `f${f}.txt`),
      contentPath,
      uploadedAt: new Date().toISOString(),
    });
  }
  fs.writeFileSync(
    path.join(uploadsDir, 'uploaded_files.json'),
    JSON.stringify({ files: records }, null, 2),
  );
  const totalMB =
    records.reduce((s, rec) => s + fs.statSync(rec.contentPath).size, 0) /
    1024 /
    1024;

  const { getResearcherPrompt } =
    await import('@/lib/prompts/search/researcher');
  const { default: UploadStore } = await import('@/lib/uploads/store');
  const BaseEmbedding = (await import('@/lib/models/base/embedding')).default;

  class RandomEmbedding extends BaseEmbedding<{}> {
    constructor() {
      super({});
    }
    async embedText(texts: string[]) {
      return texts.map(() => Array.from({ length: DIM }, r));
    }
    async embedChunks(chunks: any[]) {
      return this.embedText(chunks.map((c) => c.content));
    }
  }

  const fileIds = records.map((rec) => rec.id);
  const embedding = new RandomEmbedding();
  const times: number[] = [];

  for (let q = 0; q < QUERIES; q++) {
    const t0 = performance.now();
    for (let i = 0; i < ITERATIONS; i++) {
      await getResearcherPrompt('d', 'balanced', i, ITERATIONS, fileIds);
    }
    const S: any = UploadStore;
    const store = S.create
      ? await S.create({ embeddingModel: embedding, fileIds })
      : new S({ embeddingModel: embedding, fileIds });
    await store.query(['a', 'b', 'c'], 10);
    times.push(performance.now() - t0);
  }

  fs.rmSync(root, { recursive: true, force: true });

  const fmt = (n: number) => n.toFixed(1);
  const rest = times.slice(1);
  const mean = rest.reduce((s, t) => s + t, 0) / rest.length;
  console.log(
    `${FILES} files, ${totalMB.toFixed(1)} MB of .content.json, ${ITERATIONS} prompts + 1 uploads_search per query`,
  );
  console.log(`per query ms: ${times.map(fmt).join(', ')}`);
  console.log(
    `first ${fmt(times[0])} ms; next ${rest.length}: mean ${fmt(mean)}, min ${fmt(Math.min(...rest))}, max ${fmt(Math.max(...rest))}`,
  );
};

main();
