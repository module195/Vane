import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelAnswer, getSuggestions } from '../actions';

const respond = (status: number, body: unknown) =>
  vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => 'x' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('getSuggestions', () => {
  it('returns the suggestions on success', async () => {
    vi.stubGlobal('fetch', respond(200, { suggestions: ['a', 'b'] }));

    expect(await getSuggestions([])).toEqual(['a', 'b']);
  });

  it('returns an empty list when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      respond(500, { message: 'An error occurred while generating' }),
    );

    expect(await getSuggestions([])).toEqual([]);
  });

  it('returns an empty list when the body has no suggestions', async () => {
    vi.stubGlobal('fetch', respond(200, {}));

    expect(await getSuggestions([])).toEqual([]);
  });

  it('returns an empty list when the network fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    expect(await getSuggestions([])).toEqual([]);
  });
});

describe('cancelAnswer', () => {
  it('posts the chat and message ids to the cancel route', async () => {
    const fetchMock = respond(200, { ok: true });
    vi.stubGlobal('fetch', fetchMock);

    expect(await cancelAnswer('c1', 'm1')).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/chat/cancel');
    expect(JSON.parse(init.body as string)).toEqual({
      chatId: 'c1',
      messageId: 'm1',
    });
  });

  it('never throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    expect(await cancelAnswer('c1', 'm1')).toBe(false);
  });
});
