/* G1-16: a large upload went out as one embedding request with every chunk
   (Ollama/LM Studio answer 500/502 or time out) and bypassed the limiter
   shared with the searches. The embedding model was not recorded either. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbedding } from '@/__tests__/helpers/fakes';

class SlowEmbedding extends FakeEmbedding {
  inFlight = 0;
  peak = 0;
  async embedText(texts: string[]) {
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 5));
      return await super.embedText(texts);
    } finally {
      this.inFlight -= 1;
    }
  }
}

describe('upload embeddings', () => {
  let root: string;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-upemb-'));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sends a large file in batches through the shared limiter and records the model', async () => {
    const { default: UploadManager, UPLOAD_EMBED_BATCH } = await import(
      '../manager'
    );
    const { EMBEDDING_CONCURRENCY } = await import(
      '@/lib/models/utils/embeddingLimiter'
    );
    const embedding = new SlowEmbedding();
    const manager = new UploadManager({
      embeddingModel: embedding,
      embeddingModelInfo: { providerId: 'p1', key: 'nomic-embed' },
    });

    /* A long document: ~6000 sentences, a few hundred 512-token chunks. */
    const words = Array.from(
      { length: 6000 },
      (_, i) => `Frase ${i} sobre memória e concorrência em Rust. `,
    );
    const started = performance.now();
    const [res] = await manager.processFiles([
      new File([words.join('')], 'grande.txt', { type: 'text/plain' }),
    ]);
    const total = embedding.calls.reduce((n, c) => n + c.length, 0);
    console.log(
      `[perf] upload: ${total} chunks, ${embedding.calls.length} requests, biggest ${Math.max(...embedding.calls.map((c) => c.length))}, peak in flight ${embedding.peak}, ${(performance.now() - started).toFixed(0)} ms`,
    );

    expect(embedding.calls.length).toBeGreaterThan(1);
    expect(Math.max(...embedding.calls.map((c) => c.length))).toBeLessThanOrEqual(
      UPLOAD_EMBED_BATCH,
    );
    expect(embedding.peak).toBeLessThanOrEqual(EMBEDDING_CONCURRENCY);

    const chunks = UploadManager.getFileChunks(res.fileId);
    expect(chunks).toHaveLength(total);
    expect(chunks.map((c) => c.content)).toEqual(embedding.calls.flat());

    const content = JSON.parse(
      fs.readFileSync(UploadManager.getFile(res.fileId)!.contentPath, 'utf-8'),
    );
    expect(content.embeddingModel).toEqual({
      providerId: 'p1',
      key: 'nomic-embed',
      dims: chunks[0].embedding.length,
    });
  });
});
