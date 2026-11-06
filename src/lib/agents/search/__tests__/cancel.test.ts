import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEmbedding, FakeLLM } from '@/__tests__/helpers/fakes';
import { StreamTextOutput } from '@/lib/models/types';

/* Records every update of the messages row. */
const dbState = vi.hoisted(() => ({
  updates: [] as Record<string, any>[],
  /* Column names in each update's where clause. */
  whereColumns: [] as string[][],
}));

/* Collects the column names a drizzle condition refers to. */
const columnsOf = (cond: any): string[] => {
  const names = new Set<string>();
  const seen = new Set<any>();
  const walk = (v: any) => {
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (typeof v.name === 'string' && v.table) names.add(v.name);
    for (const k of Object.keys(v)) if (k !== 'table') walk(v[k]);
  };
  walk(cond);
  return [...names];
};

vi.mock('@/lib/db', () => {
  const chain = (onSet?: (v: any) => void) => ({
    set: (v: any) => {
      onSet?.(v);
      return chain();
    },
    values: async () => undefined,
    where: (cond: any) => {
      onWhere?.(cond);
      return chain();
    },
    execute: async () => undefined,
  });
  let onWhere: ((cond: any) => void) | undefined;
  return {
    default: {
      query: { messages: { findFirst: async () => undefined } },
      insert: () => chain(),
      update: () => {
        onWhere = (cond) => {
          dbState.whereColumns.push(columnsOf(cond));
          onWhere = undefined;
        };
        return chain((v) => dbState.updates.push(v));
      },
      delete: () => chain(),
    },
  };
});

/* SearXNG stand-in that counts requests and, like the real fetch, fails
   when the scope's signal is aborted during the request. */
const searx = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@/lib/searxng', async () => {
  const { scopedSleep } = await import('@/lib/abortScope');
  return {
    searchSearxng: vi.fn(async (q: string) => {
      searx.calls++;
      await scopedSleep(5);
      return {
        results: [
          { title: `R ${q}`, url: `https://r.test/${searx.calls}`, content: q },
        ],
        suggestions: [],
      };
    }),
  };
});

import SearchAgent from '../index';
import SessionManager from '@/lib/session';

const classification = {
  classification: {
    skipSearch: false,
    personalSearch: false,
    academicSearch: false,
    discussionSearch: false,
    showWeatherWidget: false,
    showStockWidget: false,
    showCalculationWidget: false,
  },
  standaloneFollowUp: 'q',
};

const toolCall = (id: string, name: string, args: any): StreamTextOutput => ({
  contentChunk: '',
  toolCallChunk: [{ id, name, arguments: args }],
});

const input = (llm: FakeLLM) => ({
  chatHistory: [],
  followUp: 'q',
  chatId: 'chat-1',
  messageId: 'msg-1',
  config: {
    sources: ['web' as const],
    fileIds: [],
    llm,
    embedding: new FakeEmbedding(),
    mode: 'quality' as const,
    systemInstructions: '',
  },
});

const waitFor = async (cond: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 2));
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const lastUpdate = () => dbState.updates[dbState.updates.length - 1];

beforeEach(() => {
  dbState.updates = [];
  dbState.whereColumns = [];
  searx.calls = 0;
});

describe('cancelling an answer', () => {
  it('stops the researcher loop: no LLM call or search after cancel', async () => {
    // Quality mode: up to 25 iterations, each a search plus a page
    // picker call (which picks nothing); uncancelled it makes 51 calls.
    const llm = new FakeLLM({
      latencyMs: 10,
      generateObject: (_input, i) =>
        i === 0 ? classification : { picked_indices: [] },
      streamText: (_input, i) => [
        toolCall(`c${i}`, 'web_search', { queries: [`query ${i}`] }),
      ],
    });
    const session = SessionManager.createSession();
    const events: string[] = [];
    let updatesAtEnd = -1;
    session.subscribe((event) => {
      events.push(event);
      if (event === 'end') updatesAtEnd = dbState.updates.length;
    });

    const run = new SearchAgent().searchAsync(session, input(llm));

    await waitFor(() => llm.calls.length >= 3);
    const llmBefore = llm.calls.length;
    const searchBefore = searx.calls;
    session.cancel();
    await run;
    await sleep(100);

    expect(llmBefore).toBeGreaterThan(0);
    expect(searchBefore).toBeGreaterThan(0);
    expect(llm.calls.length - llmBefore).toBe(0);
    expect(searx.calls - searchBefore).toBe(0);

    // The answer ends normally for the client and the row is saved with
    // the blocks produced so far, not left 'answering'.
    expect(events.at(-1)).toBe('end');
    expect(events).not.toContain('error');
    expect(lastUpdate().status).toBe('completed');
    expect(
      lastUpdate().responseBlocks.some((b: any) => b.type === 'research'),
    ).toBe(true);
    // Saved before 'end', so a client that refetches on messageEnd sees
    // it, and only if this session still owns the row (a rewrite may have
    // taken it over).
    expect(updatesAtEnd).toBe(dbState.updates.length);
    expect(dbState.whereColumns.at(-1)).toContain('backendId');
  });

  it('stops the writer mid-answer and keeps the text written so far', async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({
      contentChunk: `w${i} `,
      toolCallChunk: [],
    }));
    const llm = new FakeLLM({
      latencyMs: 5,
      generateObject: () => ({
        ...classification,
        classification: { ...classification.classification, skipSearch: true },
      }),
      streamText: () => chunks,
    });
    const session = SessionManager.createSession();
    session.subscribe(() => undefined);

    const run = new SearchAgent().searchAsync(session, input(llm));

    await waitFor(() => session.getAllBlocks().some((b) => b.type === 'text'));
    await sleep(20);
    session.cancel();
    await run;

    const text = session.getAllBlocks().find((b) => b.type === 'text')!
      .data as string;
    const written = text.trim().split(' ').length;
    await sleep(100);

    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(50);
    // Nothing was appended after the cancel.
    expect(
      (session.getAllBlocks().find((b) => b.type === 'text')!.data as string)
        .trim()
        .split(' ').length,
    ).toBe(written);
    expect(lastUpdate().status).toBe('completed');
    expect(
      lastUpdate().responseBlocks.find((b: any) => b.type === 'text').data,
    ).toBe(text);
  });
});

describe('session lifetime vs. cancellation', () => {
  it('a client disconnect does not cancel the session', () => {
    const session = SessionManager.createSession();
    const off = session.subscribe(() => undefined);
    off();
    expect(session.signal.aborted).toBe(false);
  });

  it('cancels after a long period with no subscriber, not before', () => {
    vi.useFakeTimers();
    try {
      const session = SessionManager.createSession();
      const off = session.subscribe(() => undefined);
      off();
      vi.advanceTimersByTime(4 * 60 * 1000);
      expect(session.signal.aborted).toBe(false);

      // A reload reconnects in time: the timer is reset.
      const off2 = session.subscribe(() => undefined);
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(session.signal.aborted).toBe(false);

      off2();
      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      expect(session.signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not arm the idle timer once the answer is over', () => {
    vi.useFakeTimers();
    try {
      const session = SessionManager.createSession();
      const off = session.subscribe(() => undefined);
      session.emit('end', {});
      off();
      vi.advanceTimersByTime(6 * 60 * 1000);
      expect(session.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
