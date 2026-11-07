import { Message } from '@/lib/types';

/**
 * Reasoning for the structured JSON steps (generateObject: classifier,
 * picker, extractor, widgets, suggestions, media). On local thinking models
 * these steps spend thousands of reasoning tokens to return a few dozen
 * characters of JSON. The researcher and the writer stream text and are
 * never affected.
 *
 * LLM_STRUCTURED_REASONING:
 * - default (or unset): requests stay as they were.
 * - off: ask the provider not to think; models that cannot stop thinking
 *   (OpenAI o-series / gpt-5, gpt-oss) get the lowest effort they accept.
 * - low: ask for low reasoning effort.
 *
 * Each provider translates the intent into its own parameter. A server that
 * answers 400 to the parameter gets one retry without it, and that instance
 * stops sending it.
 */
export type StructuredReasoning = 'default' | 'off' | 'low';

export const structuredReasoning = (): StructuredReasoning => {
  const v = process.env.LLM_STRUCTURED_REASONING?.trim().toLowerCase();
  return v === 'off' || v === 'low' ? v : 'default';
};

export const isGptOss = (model: string): boolean => /gpt-oss/i.test(model);

/* Qwen3 chat templates honour a /no_think soft switch in the user turn. It
   is the fallback for servers that ignore chat_template_kwargs (LM Studio
   bug tracker #1990). */
export const isQwen3 = (model: string): boolean => /qwen3/i.test(model);

export const appendNoThink = (messages: Message[]): Message[] => {
  const i = messages.map((m) => m.role).lastIndexOf('user');
  if (i < 0) return messages;
  return messages.map((m, j) =>
    j === i ? { ...m, content: `${m.content}\n\n/no_think` } : m,
  ) as Message[];
};

/** What an OpenAI-compatible request adds for a reasoning intent. */
export type ReasoningRequest = {
  params: Record<string, unknown>;
  noThink?: boolean;
};

export const NO_REASONING_CHANGE: ReasoningRequest = { params: {} };

/* An HTTP 400 from the OpenAI SDK (status) or the Ollama client
   (status_code). */
export const isBadRequest = (err: any): boolean =>
  err?.status === 400 || err?.status_code === 400;
