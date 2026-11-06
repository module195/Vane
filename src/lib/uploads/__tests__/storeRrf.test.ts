import { describe, expect, it, vi } from 'vitest';
import BaseEmbedding from '@/lib/models/base/embedding';

/* Reciprocal-rank fusion over several queries, with fixed vectors so the
   per-query rankings are known exactly. Each chunk is a one-hot vector and
   each query weights the dimensions, so a query ranks the chunks by its
   weights. */

const files: Record<
  string,
  { name: string; chunks: { content: string; embedding: number[] }[] }
> = {
  f1: {
    name: 'a.txt',
    chunks: [
      { content: 'A', embedding: [1, 0, 0, 0] },
      { content: 'B', embedding: [0, 1, 0, 0] },
      { content: 'C', embedding: [0, 0, 1, 0] },
      { content: 'D', embedding: [0, 0, 0, 1] },
    ],
  },
  f2: {
    name: 'b.txt',
    // Same text as a chunk of f1, but a different file.
    chunks: [{ content: 'A', embedding: [1, 0, 0, 0] }],
  },
};

vi.mock('@/lib/uploads/manager', () => ({
  default: {
    getFile: (id: string) => (files[id] ? { id, name: files[id].name } : null),
    getFileChunksCached: async (id: string) => files[id].chunks,
  },
}));

import UploadStore from '../store';

class FixedEmbedding extends BaseEmbedding<{}> {
  constructor(private vectors: Record<string, number[]>) {
    super({});
  }
  async embedText(texts: string[]) {
    return texts.map((t) => this.vectors[t]);
  }
  async embedChunks() {
    return [];
  }
}

const embedding = new FixedEmbedding({
  q1: [4, 3, 2, 1], // A > B > C > D
  q2: [1, 3, 4, 2], // C > B > D > A
});

describe('UploadStore.query reciprocal-rank fusion', () => {
  it('fuses the same chunk across queries and sums 1/(k + rank), k = 60', async () => {
    const store = await UploadStore.create({
      embeddingModel: embedding,
      fileIds: ['f1'],
    });

    const results = await store.query(['q1', 'q2'], 10);

    /* A: 1/61 + 1/64 = 0.032018   B: 1/62 + 1/62 = 0.032258
       C: 1/63 + 1/61 = 0.032266   D: 1/64 + 1/63 = 0.031498 */
    expect(results.map((r) => r.content)).toEqual(['C', 'B', 'A', 'D']);
  });

  it('returns each chunk once', async () => {
    const store = await UploadStore.create({
      embeddingModel: embedding,
      fileIds: ['f1'],
    });
    const results = await store.query(['q1', 'q2', 'q1'], 10);
    expect(results).toHaveLength(4);
  });

  it('keeps chunks with the same text from different files apart', async () => {
    const store = await UploadStore.create({
      embeddingModel: embedding,
      fileIds: ['f1', 'f2'],
    });
    const results = await store.query(['q1'], 10);
    expect(
      results.map((r) => `${r.metadata.fileId}:${r.content}`).sort(),
    ).toEqual(['f1:A', 'f1:B', 'f1:C', 'f1:D', 'f2:A']);
  });
});
