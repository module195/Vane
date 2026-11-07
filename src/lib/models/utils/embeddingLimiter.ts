import { createLimiter } from '@/lib/utils/limit';

/**
 * Embedding requests allowed in flight at once, across every search and
 * upload in the process. Parallel search actions used to fire one request
 * per query at the same time, and a local server (Ollama) answers 502 when
 * flooded (upstream issue #1147). Three keeps one action's queries (at most
 * three) fully parallel.
 */
export const EMBEDDING_CONCURRENCY = 3;
/** A request still pending after this frees its slot (and fails) so one
 *  hung embedding server call cannot block every later search. */
export const EMBEDDING_TIMEOUT_MS = 120_000;
export const withEmbeddingSlot = createLimiter(EMBEDDING_CONCURRENCY, {
  timeoutMs: EMBEDDING_TIMEOUT_MS,
});
