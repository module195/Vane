/* G1-04: a failure of the classifier or of the quality-mode result picker
   (a small local model that returns invalid JSON, a server that refuses
   json_schema) used to end the whole search with an error. Now each one
   falls back to a default path and the answer still comes. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEmbedding,
  FakeLLM,
  createFakeSession,
} from '@/__tests__/helpers/fakes';

vi.mock('@/lib/searxng', () => ({
  searchSearxng: async () => ({
    results: [0, 1, 2, 3, 4].map((i) => ({
      title: `R${i}`,
      url: `https://r${i}.test/`,
      content: `result ${i} ${['rust', 'go', 'web', 'tokio', 'memory'][i]}`,
    })),
    suggestions: [],
  }),
}));
const { scrapeMock } = vi.hoisted(() => ({ scrapeMock: vi.fn() }));
vi.mock('@/lib/scraper', () => ({ default: { scrape: scrapeMock } }));

import { classify } from '../classifier';
import { executeSearch } from '../researcher/actions/search/baseSearch';

beforeEach(() => {
  scrapeMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const broken = () =>
  new FakeLLM({
    generateObject: () => {
      throw new Error('Invalid JSON from model');
    },
  });

describe('classifier failure', () => {
  it('falls back to a web search on the original question', async () => {
    const out = await classify({
      llm: broken(),
      enabledSources: ['web'],
      query: 'Quanto custa um Raspberry Pi 5?',
      chatHistory: [],
    });
    expect(out).toEqual({
      classification: {
        skipSearch: false,
        personalSearch: false,
        academicSearch: false,
        discussionSearch: false,
        showWeatherWidget: false,
        showStockWidget: false,
        showCalculationWidget: false,
      },
      searchQueries: [],
      standaloneFollowUp: 'Quanto custa um Raspberry Pi 5?',
    });
    expect(console.warn).toHaveBeenCalled();
  });

  it('does not log the question', async () => {
    await classify({
      llm: broken(),
      enabledSources: ['web'],
      query: 'segredo do usuário',
      chatHistory: [],
    });
    const logged = vi.mocked(console.warn).mock.calls.flat().join(' ');
    expect(logged).not.toContain('segredo do usuário');
  });
});

describe('quality picker failure', () => {
  it('reads the first 3 results instead of failing the search', async () => {
    scrapeMock.mockImplementation(async (url: string) => ({
      title: url,
      content: `# ${url}\nBody of ${url}.`,
    }));
    const llm = new FakeLLM({
      generateObject: (input, i) => {
        if (i === 0) throw new Error('Invalid JSON from model');
        const user = input.messages[1].content as string;
        return {
          extracted_facts: `- fact from ${user.match(/Body of (\S+)\./)?.[1]}`,
        };
      },
    });

    const results = await executeSearch({
      queries: ['rust'],
      mode: 'quality',
      researchBlock: {
        id: 'r',
        type: 'research',
        data: { subSteps: [] },
      } as any,
      session: createFakeSession() as any,
      llm,
      embedding: new FakeEmbedding(),
    });

    expect(scrapeMock.mock.calls.map((c) => c[0])).toEqual([
      'https://r0.test/',
      'https://r1.test/',
      'https://r2.test/',
    ]);
    expect(results).toHaveLength(3);
    expect(console.warn).toHaveBeenCalled();
  });
});
