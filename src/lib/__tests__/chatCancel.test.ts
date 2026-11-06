import { describe, expect, it } from 'vitest';
import SessionManager from '@/lib/session';
import { POST as cancelRoute } from '@/app/api/chat/cancel/route';

const post = (body: unknown) =>
  cancelRoute(
    new Request('http://localhost/api/chat/cancel', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  );

describe('POST /api/chat/cancel', () => {
  it('cancels the session answering that message', async () => {
    const session = SessionManager.createSession();
    session.bindMessage('chat-a', 'msg-a');

    const res = await post({ chatId: 'chat-a', messageId: 'msg-a' });

    expect(res.status).toBe(200);
    expect(session.signal.aborted).toBe(true);
  });

  it('a newer answer for the same message (rewrite) takes over the key', async () => {
    const old = SessionManager.createSession();
    old.bindMessage('chat-b', 'msg-b');
    const current = SessionManager.createSession();
    current.bindMessage('chat-b', 'msg-b');

    await post({ chatId: 'chat-b', messageId: 'msg-b' });

    expect(current.signal.aborted).toBe(true);
    expect(old.signal.aborted).toBe(false);
  });

  it('answers 404 for an unknown message and 400 for a bad body', async () => {
    expect((await post({ chatId: 'x', messageId: 'y' })).status).toBe(404);
    expect((await post({ chatId: 'x' })).status).toBe(400);
  });
});
