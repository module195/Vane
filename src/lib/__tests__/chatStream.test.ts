import { describe, expect, it, vi } from 'vitest';
import { FakeLLM } from '@/__tests__/helpers/fakes';
import { StreamTextOutput } from '@/lib/models/types';

/* End-to-end check of the internal answer stream: POST /api/chat with a
   fake writer, then POST /api/reconnect on the finished session. */
vi.mock('@/lib/db', () => {
  const chain: any = () => ({
    set: () => chain(),
    values: async () => undefined,
    where: () => chain(),
    execute: async () => undefined,
  });
  return {
    default: {
      query: {
        messages: { findFirst: async () => undefined },
        chats: { findFirst: () => ({ execute: async () => ({}) }) },
      },
      insert: () => chain(),
      update: () => chain(),
      delete: () => chain(),
    },
  };
});

const holder = vi.hoisted(() => ({ llm: null as any }));
vi.mock('@/lib/models/registry', () => ({
  default: class {
    async loadChatModel() {
      return holder.llm;
    }
    async loadEmbeddingModel() {
      return {};
    }
  },
}));

import { POST as chat } from '@/app/api/chat/route';
import { POST as reconnect } from '@/app/api/reconnect/[id]/route';
import SessionManager from '@/lib/session';

const chunk = (contentChunk: string, done = false): StreamTextOutput => ({
  contentChunk,
  toolCallChunk: [],
  done,
});

const parse = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('answer stream routes', () => {
  it('streams text deltas once each, then replays a compact snapshot', async () => {
    holder.llm = new FakeLLM({
      generateObject: () => ({
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
      }),
      // OpenAI-compatible shape: empty role chunk first, empty finish last.
      streamText: () => [
        chunk(''),
        chunk('Olá'),
        chunk(' mundo'),
        chunk('', true),
      ],
    });

    const sessionsBefore = new Set(SessionManager.getAllSessions());
    const res = await chat(
      new Request('http://x/api/chat', {
        method: 'POST',
        body: JSON.stringify({
          message: { messageId: 'm', chatId: 'c', content: 'q' },
          optimizationMode: 'speed',
          chatModel: { providerId: 'p', key: 'k' },
          embeddingModel: { providerId: 'p', key: 'e' },
        }),
      }),
    );
    const live = parse(await res.text());

    expect(live.map((m) => m.type)).toEqual([
      'researchComplete',
      'block',
      'appendText',
      'appendText',
      // Writer done; no sources here, so no suggestions follow.
      'answerEnd',
      'messageEnd',
    ]);
    expect(live.filter((m) => m.delta).map((m) => m.delta)).toEqual([
      'Olá',
      ' mundo',
    ]);

    const session = SessionManager.getAllSessions().find(
      (s) => !sessionsBefore.has(s),
    )!;
    const replay = parse(
      await (
        await reconnect(
          new Request(`http://x/api/reconnect/${session.id}`, {
            method: 'POST',
          }),
          { params: Promise.resolve({ id: session.id }) },
        )
      ).text(),
    );

    expect(replay).toEqual([
      { type: 'researchComplete' },
      {
        type: 'block',
        block: expect.objectContaining({ type: 'text', data: 'Olá mundo' }),
      },
      { type: 'answerEnd' },
      { type: 'messageEnd' },
    ]);
  });

  it('answers 404 for an unknown session', async () => {
    const res = await reconnect(
      new Request('http://x/api/reconnect/nope', { method: 'POST' }),
      { params: Promise.resolve({ id: 'nope' }) },
    );
    expect(res.status).toBe(404);
  });
});
