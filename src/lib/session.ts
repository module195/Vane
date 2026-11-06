import { EventEmitter } from 'stream';
import { applyPatch } from 'rfc6902';
import { Block } from './types';

const sessions =
  (global as any)._sessionManagerSessions || new Map<string, SessionManager>();
/* "chatId:messageId" -> session id of the answer being produced for it,
   so the UI can stop an answer without knowing the server session id. */
const sessionsByMessage: Map<string, string> =
  (global as any)._sessionManagerByMessage || new Map<string, string>();
if (process.env.NODE_ENV !== 'production') {
  (global as any)._sessionManagerSessions = sessions;
  (global as any)._sessionManagerByMessage = sessionsByMessage;
}

const messageKey = (chatId: string, messageId: string) =>
  `${chatId}:${messageId}`;

class SessionManager {
  private static sessions: Map<string, SessionManager> = sessions;
  readonly id: string;
  private blocks = new Map<string, Block>();
  /* Number of blocks that existed when researchComplete fired, so the
     snapshot replays it in the same place; null until it fires. */
  private researchCompleteAt: number | null = null;
  /* The writer finished (follow-up suggestions may still be coming). */
  private answerEnded = false;
  /* The 'end' or 'error' event, once the answer is over. */
  private terminal: { event: string; data: any } | null = null;
  private emitter = new EventEmitter();
  private TTL_MS = 30 * 60 * 1000;
  /* Owns the answer's cancellation: SearchAgent runs under this signal
     (see lib/abortScope.ts). Only an explicit cancel() or a long stretch
     with nobody listening aborts it; a dropped connection or a page
     reload does not, so the reload can resume the answer. */
  private abortController = new AbortController();
  private subscribers = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  static IDLE_ABORT_MS = 5 * 60 * 1000;

  constructor(id?: string) {
    this.id = id ?? crypto.randomUUID();

    setTimeout(() => {
      SessionManager.sessions.delete(this.id);
      for (const [key, id] of sessionsByMessage) {
        if (id === this.id) sessionsByMessage.delete(key);
      }
    }, this.TTL_MS);
  }

  static getSession(id: string): SessionManager | undefined {
    return this.sessions.get(id);
  }

  static getAllSessions(): SessionManager[] {
    return Array.from(this.sessions.values());
  }

  static createSession(): SessionManager {
    const session = new SessionManager();
    this.sessions.set(session.id, session);
    return session;
  }

  /* Marks this session as the one answering chatId/messageId. A rewrite
     of the same message replaces the previous binding. */
  bindMessage(chatId: string, messageId: string) {
    sessionsByMessage.set(messageKey(chatId, messageId), this.id);
  }

  static getSessionForMessage(
    chatId: string,
    messageId: string,
  ): SessionManager | undefined {
    const id = sessionsByMessage.get(messageKey(chatId, messageId));
    return id ? this.sessions.get(id) : undefined;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /* Stops the answer: in-flight LLM calls and downloads are aborted and
     SearchAgent saves what was produced so far. No-op once it is over. */
  cancel() {
    clearTimeout(this.idleTimer);
    if (this.terminal || this.signal.aborted) return;
    this.abortController.abort();
  }

  /* Nobody has listened for IDLE_ABORT_MS (tab closed and never
     reopened): stop spending tokens on an answer nobody will read. */
  private armIdleTimer() {
    clearTimeout(this.idleTimer);
    if (this.terminal) return;
    this.idleTimer = setTimeout(
      () => this.cancel(),
      SessionManager.IDLE_ABORT_MS,
    );
    this.idleTimer.unref?.();
  }

  removeAllListeners() {
    this.emitter.removeAllListeners();
  }

  emit(event: string, data: any) {
    if (event === 'data' && data?.type === 'researchComplete') {
      this.researchCompleteAt = this.blocks.size;
    } else if (event === 'data' && data?.type === 'answerEnd') {
      this.answerEnded = true;
    } else if (event === 'end' || event === 'error') {
      this.terminal = { event, data };
      clearTimeout(this.idleTimer);
    }
    // An 'error' with no listener (the client left) makes EventEmitter
    // throw, which skipped saving the failed message.
    if (event === 'error' && this.emitter.listenerCount('error') === 0) return;
    this.emitter.emit(event, data);
  }

  emitBlock(block: Block) {
    this.blocks.set(block.id, block);
    this.emit('data', {
      type: 'block',
      block: block,
    });
  }

  getBlock(blockId: string): Block | undefined {
    return this.blocks.get(blockId);
  }

  updateBlock(blockId: string, patch: any[]) {
    const block = this.blocks.get(blockId);

    if (block) {
      applyPatch(block, patch);
      this.blocks.set(blockId, block);
      this.emit('data', {
        type: 'updateBlock',
        blockId: blockId,
        patch: patch,
      });
    }
  }

  /* Appends streamed text to a text block and sends only the new piece.
     A 'replace' patch carried the whole answer on every token, so the
     stream grew with the square of the answer length. */
  appendBlockText(blockId: string, delta: string) {
    const block = this.blocks.get(blockId);

    if (!block || block.type !== 'text' || !delta) return;

    block.data += delta;
    this.emit('data', {
      type: 'appendText',
      blockId,
      delta,
    });
  }

  getAllBlocks() {
    return Array.from(this.blocks.values());
  }

  /* Calls the listener with a snapshot of the session (one 'block' event
     per block with its current content, researchComplete if it fired, and
     the final 'end'/'error' if the answer is over), then with every live
     event. The snapshot replaces the old replay of every buffered event:
     a long answer sent thousands of patches on reconnect. Snapshot and
     subscription happen in the same synchronous call, so no event can be
     lost or delivered twice between them. */
  subscribe(listener: (event: string, data: any) => void): () => void {
    const handler = (event: string) => (data: any) => listener(event, data);
    const dataHandler = handler('data');
    const endHandler = handler('end');
    const errorHandler = handler('error');

    this.emitter.on('data', dataHandler);
    this.emitter.on('end', endHandler);
    this.emitter.on('error', errorHandler);
    this.subscribers++;
    clearTimeout(this.idleTimer);

    let index = 0;
    for (const block of this.blocks.values()) {
      if (index === this.researchCompleteAt) {
        listener('data', { type: 'researchComplete' });
      }
      listener('data', { type: 'block', block });
      index++;
    }
    if (this.researchCompleteAt !== null && this.researchCompleteAt >= index) {
      listener('data', { type: 'researchComplete' });
    }
    if (this.answerEnded) {
      listener('data', { type: 'answerEnd' });
    }
    if (this.terminal) {
      listener(this.terminal.event, this.terminal.data);
    }

    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.emitter.off('data', dataHandler);
      this.emitter.off('end', endHandler);
      this.emitter.off('error', errorHandler);
      this.subscribers--;
      if (this.subscribers === 0) this.armIdleTimer();
    };
  }
}

export default SessionManager;
