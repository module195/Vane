import { describe, expect, it, vi } from 'vitest';
import { FakeEmbedding, FakeLLM } from '@/__tests__/helpers/fakes';
import { StreamTextOutput } from '@/lib/models/types';

/* In-memory stand-in for the drizzle db: keeps the last update so the
   test can compare the saved blocks with what was streamed. */
const dbState = vi.hoisted(() => ({ updates: [] as Record<string, any>[] }));

vi.mock('@/lib/db', () => {
  const chain = (onSet?: (v: any) => void) => ({
    set: (v: any) => {
      onSet?.(v);
      return chain();
    },
    values: async () => undefined,
    where: () => chain(),
    execute: async () => undefined,
  });
  return {
    default: {
      query: { messages: { findFirst: async () => undefined } },
      insert: () => chain(),
      update: () => chain((v) => dbState.updates.push(v)),
      delete: () => chain(),
    },
  };
});

import SearchAgent from '../index';
import SessionManager from '@/lib/session';

const skipSearch = {
  classification: {
    skipSearch: true,
    personalSearch: false,
    academicSearch: false,
    discussionSearch: false,
    showWeatherWidget: false,
    showStockWidget: false,
    showCalculationWidget: false,
  },
  standaloneFollowUp: 'q',
};

const chunk = (contentChunk: string, done = false): StreamTextOutput => ({
  contentChunk,
  toolCallChunk: [],
  done,
});

const run = async (chunks: StreamTextOutput[]) => {
  dbState.updates = [];
  const llm = new FakeLLM({
    generateObject: () => skipSearch,
    streamText: () => chunks,
  });
  const session = SessionManager.createSession();
  const seen: any[] = [];
  session.subscribe((event, data) => seen.push({ event, data }));

  await new SearchAgent().searchAsync(session, {
    chatHistory: [],
    followUp: 'q',
    chatId: 'chat-1',
    messageId: 'msg-1',
    config: {
      sources: ['web'],
      fileIds: [],
      llm,
      embedding: new FakeEmbedding(),
      mode: 'speed',
      systemInstructions: '',
    },
  });

  return { seen, saved: dbState.updates.at(-1)! };
};

describe('SearchAgent writer stream', () => {
  /* OpenAI-compatible streams (LM Studio, Bifrost) close with an empty
     finish_reason chunk; it used to re-send the whole text once more. */
  it('sends no text update for empty chunks', async () => {
    const { seen, saved } = await run([
      chunk(''),
      chunk('Olá'),
      chunk(' mundo'),
      chunk('', true),
    ]);

    const textUpdates = seen.filter(
      (e) => e.event === 'data' && e.data.type !== 'block' && e.data.blockId,
    );
    expect(textUpdates).toHaveLength(2);

    const types = seen.map((e) => e.data?.type ?? e.event);
    expect(types.at(-1)).toBe('end');

    expect(saved.status).toBe('completed');
    expect(saved.responseBlocks).toEqual([
      expect.objectContaining({ type: 'text', data: 'Olá mundo' }),
    ]);
  });

  it('streams only the new text of each token, and saves the full answer', async () => {
    const tokens = Array.from({ length: 300 }, (_, i) => ` palavra${i}`);
    const { seen, saved } = await run(tokens.map((t) => chunk(t)));

    const updates = seen.filter((e) => e.data?.blockId);
    expect(updates.map((e) => e.data.type)).toEqual(
      Array(tokens.length - 1).fill('appendText'),
    );
    expect(updates.map((e) => e.data.delta)).toEqual(tokens.slice(1));

    // Wire size grows linearly with the answer, not with its square.
    const answer = tokens.join('');
    const wire = updates.reduce(
      (n, e) => n + JSON.stringify(e.data).length + 1,
      0,
    );
    expect(wire).toBeLessThan(answer.length + 120 * tokens.length);

    expect(saved.responseBlocks).toEqual([
      expect.objectContaining({ type: 'text', data: answer }),
    ]);
  });
});
