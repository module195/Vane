import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionManager from '../session';
import { createSessionStream } from '../sessionStream';

const lines = async (readable: ReadableStream<Uint8Array>) =>
  (await new Response(readable).text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).type);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSessionStream', () => {
  it('sends keepalive lines while the answer is silent and stops on end', async () => {
    const session = SessionManager.createSession();
    const ttlTimers = vi.getTimerCount(); // the session TTL
    const onTerminal = vi.fn();
    const stream = createSessionStream(session, {
      signal: new AbortController().signal,
      keepaliveMs: 1000,
      onTerminal,
    });

    session.emitBlock({ id: 'r', type: 'research', data: { subSteps: [] } });
    vi.advanceTimersByTime(3500); // silent research phase
    session.emitBlock({ id: 't', type: 'text', data: 'a' });
    session.appendBlockText('t', 'b');
    session.emit('end', {});

    expect(vi.getTimerCount()).toBe(ttlTimers);
    vi.advanceTimersByTime(5000);

    expect(await lines(stream)).toEqual([
      'block',
      'keepalive',
      'keepalive',
      'keepalive',
      'block',
      'appendText',
      'messageEnd',
    ]);
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('clears the keepalive on error', async () => {
    const session = SessionManager.createSession();
    const ttlTimers = vi.getTimerCount(); // the session TTL
    const stream = createSessionStream(session, {
      signal: new AbortController().signal,
      keepaliveMs: 1000,
    });

    session.emit('error', { data: 'boom' });

    expect(vi.getTimerCount()).toBe(ttlTimers);
    const text = await new Response(stream).text();
    expect(JSON.parse(text)).toEqual({ type: 'error', data: 'boom' });
  });

  it('clears the keepalive and unsubscribes when the client aborts', async () => {
    const session = SessionManager.createSession();
    const ttlTimers = vi.getTimerCount(); // the session TTL
    const controller = new AbortController();
    const stream = createSessionStream(session, {
      signal: controller.signal,
      keepaliveMs: 1000,
    });

    vi.advanceTimersByTime(1000);
    controller.abort();

    expect(vi.getTimerCount()).toBe(ttlTimers);
    // Events after the abort are not written and do not throw.
    session.emitBlock({ id: 't', type: 'text', data: 'late' });
    session.emit('end', {});

    expect(await lines(stream)).toEqual(['keepalive']);
  });

  it('sends the snapshot of a finished session and closes without a timer', async () => {
    const session = SessionManager.createSession();
    const ttlTimers = vi.getTimerCount(); // the session TTL
    session.emitBlock({ id: 't', type: 'text', data: '' });
    for (let i = 0; i < 100; i++) session.appendBlockText('t', `w${i} `);
    session.emit('end', {});

    const stream = createSessionStream(session, {
      signal: new AbortController().signal,
    });

    expect(vi.getTimerCount()).toBe(ttlTimers);
    const text = await new Response(stream).text();
    const messages = text
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(messages.map((m) => m.type)).toEqual(['block', 'messageEnd']);
    expect(messages[0].block.data).toMatch(/^w0 w1 .* w99 $/);
  });
});
