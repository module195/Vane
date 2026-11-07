import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAIEmbedding from '@/lib/models/providers/openai/openaiEmbedding';
import OllamaEmbedding from '@/lib/models/providers/ollama/ollamaEmbedding';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/* A server that never answers, but honours the abort signal. */
const hangingFetch = vi.fn(
  (_input: any, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(init.signal!.reason),
      );
    }),
);

describe('embedding request timeout (LLM_TIMEOUT_MS)', () => {
  it('sets the OpenAI-compatible embedding client timeout', () => {
    vi.stubEnv('LLM_TIMEOUT_MS', '1234');
    const emb = new OpenAIEmbedding({
      apiKey: 'k',
      model: 'm',
      baseURL: 'http://h/v1',
    });
    expect(emb.openAIClient.timeout).toBe(1234);
  });

  it('aborts an Ollama embedding call whose headers do not arrive in time', async () => {
    vi.stubEnv('LLM_TIMEOUT_MS', '50');
    vi.stubGlobal('fetch', hangingFetch);

    const emb = new OllamaEmbedding({ baseURL: 'http://ollama', model: 'm' });

    await expect(emb.embedText(['oi'])).rejects.toThrow(
      /timed out after 50 ms/,
    );
  });
});
