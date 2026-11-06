import { z } from 'zod';
import SessionManager from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  chatId: z.string().min(1),
  messageId: z.string().min(1),
});

/* Stops the answer being produced for a message (the Stop button). The
   in-flight LLM calls and downloads are aborted; the open /api/chat
   stream then receives messageEnd, and the message is saved with what
   was produced so far. Closing the tab does not call this: a reload must
   be able to resume the answer. */
export const POST = async (req: Request) => {
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));

  if (!parsed.success) {
    return Response.json({ message: 'Invalid request body' }, { status: 400 });
  }

  const session = SessionManager.getSessionForMessage(
    parsed.data.chatId,
    parsed.data.messageId,
  );

  if (!session) {
    return Response.json({ message: 'Session not found' }, { status: 404 });
  }

  session.cancel();

  return Response.json({ ok: true }, { status: 200 });
};
