import type SessionManager from './session';

/* Interval of the keepalive line. Proxies and some browsers drop an idle
   HTTP stream after 30-60 s, and research with a local model can stay
   silent that long (upstream ItzCrazyKns/Vane #1051 uses 15 s too). */
export const KEEPALIVE_MS = 15_000;

type Options = {
  /* The request's abort signal: the client left. */
  signal: AbortSignal;
  keepaliveMs?: number;
  /* Called once when the answer ends or fails, before the stream closes. */
  onTerminal?: () => void;
};

/* Turns a session into the NDJSON stream read by useChat, shared by
   POST /api/chat and POST /api/reconnect/[id]. A late subscriber first
   gets the session snapshot (see SessionManager.subscribe). While the
   stream is open a {"type":"keepalive"} line is written every
   keepaliveMs; the client ignores it. The interval and the subscription
   are released on end, error and client abort. */
export const createSessionStream = (
  session: SessionManager,
  { signal, keepaliveMs = KEEPALIVE_MS, onTerminal }: Options,
): ReadableStream<Uint8Array> => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  let closed = false;
  // subscribe() sends the snapshot synchronously, so for a finished
  // session 'end' arrives before subscribe() returns: keep the unsubscribe
  // function in a mutable variable and release it once it exists.
  let disconnect: (() => void) | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;

  const send = (message: Record<string, any>) => {
    if (closed) return;
    // A write after the client cancelled the body rejects; nothing to do.
    writer
      .write(encoder.encode(JSON.stringify(message) + '\n'))
      .catch(() => undefined);
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    signal.removeEventListener('abort', close);
    disconnect?.();
    writer.close().catch(() => undefined);
  };

  disconnect = session.subscribe((event, data) => {
    if (closed) return;

    if (event === 'data') {
      if (data.type === 'block') {
        send({ type: 'block', block: data.block });
      } else if (data.type === 'updateBlock') {
        send({ type: 'updateBlock', blockId: data.blockId, patch: data.patch });
      } else if (data.type === 'appendText') {
        send({ type: 'appendText', blockId: data.blockId, delta: data.delta });
      } else if (data.type === 'researchComplete') {
        send({ type: 'researchComplete' });
      }
    } else if (event === 'end') {
      send({ type: 'messageEnd' });
      onTerminal?.();
      close();
    } else if (event === 'error') {
      send({ type: 'error', data: data.data });
      onTerminal?.();
      close();
    }
  });

  if (closed) {
    disconnect();
  } else if (signal.aborted) {
    close();
  } else {
    keepalive = setInterval(() => send({ type: 'keepalive' }), keepaliveMs);
    signal.addEventListener('abort', close);
  }

  return readable;
};
