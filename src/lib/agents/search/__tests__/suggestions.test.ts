import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbedding, FakeLLM } from '@/__tests__/helpers/fakes';
import { StreamTextOutput } from '@/lib/models/types';

const dbState = vi.hoisted(() => ({
  updates: [] as Record<string, any>[],
}));

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

vi.mock('@/lib/searxng', () => ({
  searchSearxng: vi.fn(async () => ({
    results: [{ title: 'A', url: 'https://a.test/1', content: 'rust web' }],
    suggestions: [],
  })),
}));

const llmHolder = vi.hoisted(() => ({ llm: null as any }));
vi.mock('@/lib/models/registry', () => ({
  default: class {
    async loadChatModel() {
      return llmHolder.llm;
    }
  },
}));

import SearchAgent from '../index';
import SessionManager from '@/lib/session';
import { createSessionStream } from '@/lib/sessionStream';
import { POST as suggestionsRoute } from '@/app/api/suggestions/route';

const classification = (skipSearch: boolean) => ({
  classification: {
    skipSearch,
    personalSearch: false,
    academicSearch: false,
    discussionSearch: false,
    showWeatherWidget: false,
    showStockWidget: false,
    showCalculationWidget: false,
  },
  standaloneFollowUp: 'q',
});

const toolCall = (id: string, name: string, args: any): StreamTextOutput => ({
  contentChunk: '',
  toolCallChunk: [{ id, name, arguments: args }],
});

/* Classifier, then (with search) one web_search and done, then the
   writer, then the suggestion generator. */
const makeLLM = (opts: {
  skipSearch: boolean;
  latencyMs?: number;
  suggestions?: () => any;
}) =>
  new FakeLLM({
    latencyMs: opts.latencyMs,
    generateObject: (input) =>
      input.messages[0].content.includes('suggestion')
        ? (opts.suggestions?.() ?? { suggestions: ['s1', 's2'] })
        : classification(opts.skipSearch),
    streamText: (input, i) => {
      if (input.tools && input.tools.length > 0) {
        return i === 0
          ? [toolCall('c1', 'web_search', { queries: ['rust web'] })]
          : [toolCall('c2', 'done', {})];
      }
      return [
        { contentChunk: 'The ', toolCallChunk: [] },
        { contentChunk: 'answer.', toolCallChunk: [] },
      ];
    },
  });

const input = (llm: FakeLLM) => ({
  chatHistory: [
    { role: 'user' as const, content: 'earlier q' },
    { role: 'assistant' as const, content: 'earlier a' },
  ],
  followUp: 'q',
  chatId: 'chat-1',
  messageId: 'msg-1',
  config: {
    sources: ['web' as const],
    fileIds: [],
    llm,
    embedding: new FakeEmbedding(),
    mode: 'speed' as const,
    systemInstructions: '',
  },
});

const suggestionCalls = (llm: FakeLLM) =>
  llm.calls.filter(
    (c) =>
      c.kind === 'generateObject' &&
      (c.input.messages[0].content as string).includes('suggestion'),
  );

const record = (session: SessionManager) => {
  const seen: { event: string; data: any; at: number }[] = [];
  session.subscribe((event, data) =>
    seen.push({ event, data, at: performance.now() }),
  );
  return seen;
};

const label = (e: { event: string; data: any }) =>
  e.event === 'data'
    ? e.data.type === 'block'
      ? `block:${e.data.block.type}`
      : e.data.type
    : e.event;

beforeEach(() => {
  dbState.updates = [];
});

describe('follow-up suggestions generated on the server', () => {
  it('emits answerEnd, then the suggestion block, then end; and saves them', async () => {
    const llm = makeLLM({ skipSearch: false });
    const session = SessionManager.createSession();
    const seen = record(session);

    await new SearchAgent().searchAsync(session, input(llm));

    const labels = seen.map(label).filter((l) => l !== 'appendText');
    const answerEnd = labels.indexOf('answerEnd');
    expect(answerEnd).toBeGreaterThan(labels.indexOf('block:text'));
    expect(labels.slice(answerEnd)).toEqual([
      'answerEnd',
      'block:suggestion',
      'end',
    ]);
    expect(
      seen.find((e) => label(e) === 'block:suggestion')!.data.block.data,
    ).toEqual(['s1', 's2']);

    // The answer is saved as completed at answerEnd, then with the
    // suggestions once they exist.
    expect(dbState.updates.at(-1)!.status).toBe('completed');
    expect(
      dbState.updates
        .at(-1)!
        .responseBlocks.find((b: any) => b.type === 'suggestion').data,
    ).toEqual(['s1', 's2']);
  });

  it('sends the model exactly what /api/suggestions sent for the same chat', async () => {
    const llm = makeLLM({ skipSearch: false });
    const session = SessionManager.createSession();
    await new SearchAgent().searchAsync(session, input(llm));
    const serverSide = suggestionCalls(llm)[0].input.messages;

    // The client used to post its history plus [query, answer text].
    const routeLLM = makeLLM({ skipSearch: false });
    llmHolder.llm = routeLLM;
    await suggestionsRoute(
      new Request('http://localhost/api/suggestions', {
        method: 'POST',
        body: JSON.stringify({
          chatHistory: [
            ['human', 'earlier q'],
            ['assistant', 'earlier a'],
            ['human', 'q'],
            ['assistant', 'The answer.'],
          ],
          chatModel: { providerId: 'p', key: 'k' },
        }),
      }),
    );

    expect(serverSide).toEqual(suggestionCalls(routeLLM)[0].input.messages);
  });

  it('makes no suggestion call without sources (same rule as the client)', async () => {
    const llm = makeLLM({ skipSearch: true });
    const session = SessionManager.createSession();
    const seen = record(session);

    await new SearchAgent().searchAsync(session, input(llm));

    expect(suggestionCalls(llm)).toHaveLength(0);
    expect(seen.map(label).slice(-2)).toEqual(['answerEnd', 'end']);
  });

  it('a failed suggestion call still ends the answer, with an empty list', async () => {
    const llm = makeLLM({
      skipSearch: false,
      suggestions: () => {
        throw new Error('bad json');
      },
    });
    const session = SessionManager.createSession();
    const seen = record(session);

    await new SearchAgent().searchAsync(session, input(llm));

    expect(seen.map(label).slice(-3)).toEqual([
      'answerEnd',
      'block:suggestion',
      'end',
    ]);
    expect(seen.at(-2)!.data.block.data).toEqual([]);
    expect(dbState.updates.at(-1)!.status).toBe('completed');
  });

  it('a reconnect after the answer ended gets answerEnd in the snapshot', async () => {
    const llm = makeLLM({ skipSearch: false });
    const session = SessionManager.createSession();
    await new SearchAgent().searchAsync(session, input(llm));

    const late: string[] = [];
    session.subscribe((event, data) => late.push(label({ event, data })));

    expect(late.slice(-3)).toEqual(['block:suggestion', 'answerEnd', 'end']);
  });

  it('the chat stream forwards answerEnd to the client', async () => {
    const session = SessionManager.createSession();
    const stream = createSessionStream(session, {
      signal: new AbortController().signal,
    });
    session.emit('data', { type: 'answerEnd' });
    session.emit('end', {});
    const text = await new Response(stream).text();
    expect(
      text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).type),
    ).toEqual(['answerEnd', 'messageEnd']);
  });

  it('suggestions are ready one model latency after the answer ends', async () => {
    const L = 50;
    const llm = makeLLM({ skipSearch: false, latencyMs: L });
    const session = SessionManager.createSession();
    const seen = record(session);

    await new SearchAgent().searchAsync(session, input(llm));

    const answerEnd = seen.find((e) => label(e) === 'answerEnd')!.at;
    const ready = seen.find((e) => label(e) === 'block:suggestion')!.at;
    expect(ready - answerEnd).toBeGreaterThanOrEqual(L - 5);
    expect(ready - answerEnd).toBeLessThan(L + 40);
  });
});
