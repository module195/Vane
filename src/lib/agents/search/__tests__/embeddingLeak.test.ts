/* G1-03: the embedding vector of each search result is ranking state. It
   used to ride along in the research block, so every updateBlock sent the
   vectors of all results again to the browser and the block saved in the
   messages row kept them. Real models give 768 to 4096 floats per result. */
import { describe, expect, it, vi } from 'vitest';
import {
  FakeEmbedding,
  FakeLLM,
  createFakeSession,
} from '@/__tests__/helpers/fakes';

vi.mock('@/lib/searxng', () => ({
  searchSearxng: async (q: string) => ({
    results: [1, 2, 3, 4].map((i) => ({
      title: `${q} ${i}`,
      url: `https://r${i}.test/${encodeURIComponent(q)}`,
      content: `${q} rust web ${'go '.repeat(i)}`,
    })),
    suggestions: [],
  }),
}));
vi.mock('@/lib/scraper', () => ({ default: { scrape: vi.fn() } }));

import { executeSearch } from '../researcher/actions/search/baseSearch';

const run = async (mode: 'speed' | 'balanced') => {
  const session = createFakeSession();
  const researchBlock = {
    id: 'research',
    type: 'research' as const,
    data: { subSteps: [] as any[] },
  };
  const results = await executeSearch({
    queries: ['rust web', 'go concurrency'],
    mode,
    researchBlock: researchBlock as any,
    session: session as any,
    llm: new FakeLLM({}),
    embedding: new FakeEmbedding(),
  });
  return { session, researchBlock, results };
};

describe.each(['speed', 'balanced'] as const)(
  'search results in %s mode',
  (mode) => {
    it('send no embedding vector to the browser', async () => {
      const { session } = await run(mode);
      expect(session.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(session.events)).not.toContain('"embedding"');
    });

    it('keep no embedding vector in the research block that gets saved', async () => {
      const { researchBlock } = await run(mode);
      const reading = researchBlock.data.subSteps.flatMap(
        (s: any) => s.reading ?? [],
      );
      expect(reading.length).toBeGreaterThan(0);
      expect(JSON.stringify(researchBlock)).not.toContain('"embedding"');
    });

    it('still return the results to the researcher without vectors', async () => {
      const { results } = await run(mode);
      expect(results.length).toBeGreaterThan(0);
      for (const r of results) expect(r.metadata.embedding).toBeUndefined();
    });
  },
);
