import { describe, expect, it, vi } from 'vitest';
import { FakeEmbedding, embedDeterministic } from '@/__tests__/helpers/fakes';

vi.mock('@/lib/uploads/manager', async () => {
  const { embedDeterministic } = await import('@/__tests__/helpers/fakes');
  return {
    default: {
      getFile: (id: string) => ({ id, name: `${id}.txt` }),
      getFileChunks: (id: string) =>
        id === 'novo'
          ? [{ content: 'rust novo', embedding: embedDeterministic('rust novo') }]
          : // Embedded earlier with another model: different dimension.
            [{ content: 'rust antigo', embedding: [0.1, 0.2, 0.3] }],
    },
  };
});

import UploadStore from '../store';

describe('UploadStore with embeddings of another dimension', () => {
  it('skips mismatched chunks with a warning instead of throwing', async () => {
    expect(embedDeterministic('x').length).not.toBe(3);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new UploadStore({
      embeddingModel: new FakeEmbedding(),
      fileIds: ['antigo', 'novo'],
    });

    const results = await store.query(['rust'], 10);

    expect(results.map((r) => r.content)).toEqual(['rust novo']);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0].join(' '));
    expect(msg).toMatch(/dimension/i);
    expect(msg).not.toContain('rust antigo');
    warn.mockRestore();
  });
});
