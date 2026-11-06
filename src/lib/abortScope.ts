import { AsyncLocalStorage } from 'node:async_hooks';

/* Cancellation of a chat answer. SearchAgent runs the whole pipeline
   inside runWithAbortSignal(session.signal, ...); the LLM providers and
   the network helpers (SearXNG, Firecrawl, page scraper) read the signal
   from here, so it does not have to be threaded through every classifier,
   widget, research action and writer signature. Code running outside a
   scope (Discover, media search, /api/search, the benchmark) sees no
   signal and behaves as before. */
const storage = new AsyncLocalStorage<AbortSignal>();

export const runWithAbortSignal = <T>(
  signal: AbortSignal | undefined,
  fn: () => T,
): T => (signal ? storage.run(signal, fn) : fn());

/** The signal of the enclosing scope, if any. */
export const currentAbortSignal = (): AbortSignal | undefined =>
  storage.getStore();

/** The scope's signal combined with a local one (a timeout, typically). */
export const withScopeSignal = (
  signal?: AbortSignal,
): AbortSignal | undefined => {
  const scope = currentAbortSignal();
  if (!scope) return signal;
  if (!signal) return scope;
  return AbortSignal.any([scope, signal]);
};

/* fetch that also aborts with the enclosing scope. Given to the LLM SDK
   clients (OpenAI-compatible, Ollama) so every request they make, streamed
   or not, stops when the answer is cancelled. Resolved at call time so
   tests can stub the global fetch. */
export const scopedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: withScopeSignal(init?.signal ?? undefined),
  });

/** True when the enclosing scope was cancelled. */
export const isScopeAborted = (): boolean =>
  currentAbortSignal()?.aborted ?? false;

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'AbortError';
  }
}

/** Throws a CancelledError when the enclosing scope was cancelled. */
export const throwIfScopeAborted = () => {
  if (isScopeAborted()) throw new CancelledError();
};

/** setTimeout as a promise that rejects as soon as the scope is cancelled. */
export const scopedSleep = (ms: number) =>
  new Promise<void>((resolve, reject) => {
    const signal = currentAbortSignal();
    if (signal?.aborted) return reject(new CancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
