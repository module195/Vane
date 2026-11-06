import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const config = vi.hoisted(() => ({ firecrawl: null as any }));

vi.mock('@/lib/config/serverRegistry', () => ({
  getSearxngURL: () => 'http://searxng.test',
  getSearchProvider: () => 'searxng',
}));
vi.mock('@/lib/firecrawl', async (orig) => ({
  ...(await orig<any>()),
  getFirecrawlConfig: () => config.firecrawl,
}));
vi.mock('@/lib/security/urlGuard', async (orig) => ({
  ...(await orig<any>()),
  assertPublicHttpURL: async () => undefined,
  fetchPublicURL: (url: string, init: RequestInit) => fetch(url, init),
}));

import { runWithAbortSignal } from '../abortScope';
import { searchSearxng } from '../searxng';
import { searchWeb, searchRetry } from '../webSearch';
import { searchFirecrawl } from '../firecrawlSearch';
import Scraper from '../scraper';
import OpenAILLM from '../models/providers/openai/openaiLLM';
import OllamaLLM from '../models/providers/ollama/ollamaLLM';

/* fetch stand-in that hangs until its signal aborts, like a slow server. */
const hangingFetch = vi.fn(
  (_url: any, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    }),
);

beforeEach(() => {
  hangingFetch.mockClear();
  vi.stubGlobal('fetch', hangingFetch);
  config.firecrawl = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const abortSoon = (controller: AbortController) =>
  setTimeout(() => controller.abort(), 5);

describe('network helpers inside an abort scope', () => {
  it('SearXNG request is aborted with the session, not reported as a timeout', async () => {
    const controller = new AbortController();
    abortSoon(controller);
    const err = await runWithAbortSignal(controller.signal, () =>
      searchSearxng('q'),
    ).catch((e) => e);

    expect(err.name).toBe('AbortError');
    expect(err.message).not.toMatch(/timed out/);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it('searchWeb does not retry a cancelled search', async () => {
    searchRetry.delaysMs = [1, 1];
    const controller = new AbortController();
    abortSoon(controller);
    await runWithAbortSignal(controller.signal, () => searchWeb('q')).catch(
      () => undefined,
    );
    expect(hangingFetch).toHaveBeenCalledTimes(1);

    // Already cancelled: no request at all.
    hangingFetch.mockClear();
    await runWithAbortSignal(controller.signal, () => searchWeb('q')).catch(
      () => undefined,
    );
    expect(hangingFetch).toHaveBeenCalledTimes(0);
  });

  it('Firecrawl search is aborted with the session', async () => {
    config.firecrawl = { apiURL: 'http://fc.test' };
    const controller = new AbortController();
    abortSoon(controller);
    const err = await runWithAbortSignal(controller.signal, () =>
      searchFirecrawl('q'),
    ).catch((e) => e);
    expect(err.name).toBe('AbortError');
  });

  it('page download (fetch and Firecrawl scrape) is aborted with the session', async () => {
    for (const fc of [null, { apiURL: 'http://fc.test' }]) {
      config.firecrawl = fc;
      hangingFetch.mockClear();
      const controller = new AbortController();
      abortSoon(controller);
      const start = Date.now();
      const res = await runWithAbortSignal(controller.signal, () =>
        Scraper.scrape('https://example.com/page'),
      );
      expect(res.title).toBe('Failed to scrape');
      expect(Date.now() - start).toBeLessThan(1000);
      expect(hangingFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('outside a scope nothing changes (no extra signal)', async () => {
    hangingFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ results: [], suggestions: [] })),
    );
    await searchSearxng('q');
    const init = hangingFetch.mock.calls[0][1]!;
    expect(init.signal!.aborted).toBe(false);
  });
});

describe('LLM providers inside an abort scope', () => {
  it('OpenAI-compatible provider aborts its HTTP request with the session', async () => {
    const llm = new OpenAILLM({
      apiKey: 'k',
      model: 'm',
      baseURL: 'http://openai.test/v1',
    });
    for (const call of [
      () => llm.generateText({ messages: [] }),
      () => llm.generateObject({ messages: [], schema: z.object({}) }),
      async () => {
        for await (const _ of llm.streamText({ messages: [] })) break;
      },
    ]) {
      hangingFetch.mockClear();
      const controller = new AbortController();
      abortSoon(controller);
      const err = await runWithAbortSignal(controller.signal, call).catch(
        (e) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(hangingFetch).toHaveBeenCalledTimes(1);
      expect(
        (hangingFetch.mock.calls[0][1] as RequestInit).signal!.aborted,
      ).toBe(true);
    }
  });

  it('Ollama provider aborts its HTTP request with the session', async () => {
    const llm = new OllamaLLM({ model: 'm', baseURL: 'http://ollama.test' });
    const controller = new AbortController();
    abortSoon(controller);
    const err = await runWithAbortSignal(controller.signal, () =>
      llm.generateText({ messages: [] }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    expect((hangingFetch.mock.calls[0][1] as RequestInit).signal!.aborted).toBe(
      true,
    );
  });
});
