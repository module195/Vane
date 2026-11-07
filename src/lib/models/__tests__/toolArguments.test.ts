/* G1-04: tool-call arguments that are not valid JSON made generateText
   throw and fail the whole request. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import OpenAILLM from '@/lib/models/providers/openai/openaiLLM';

afterEach(() => {
  vi.restoreAllMocks();
});

const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

const llmWith = (create: (...a: any[]) => any) => {
  const llm = new OpenAILLM({
    apiKey: 'k',
    model: 'm',
    baseURL: 'http://h/v1',
  });
  (llm.openAIClient.chat.completions as any).create = vi.fn(create);
  return llm;
};

describe('OpenAI tool-call arguments that are not valid JSON', () => {
  it('generateText falls back to {} instead of throwing', async () => {
    const warn = quietWarn();
    const llm = llmWith(async () => ({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            content: '',
            tool_calls: [
              {
                type: 'function',
                id: 'c1',
                function: {
                  name: 'web_search',
                  arguments: '{"queries": [oops',
                },
              },
            ],
          },
        },
      ],
    }));

    const out = await llm.generateText({
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(out.toolCalls).toEqual([
      { id: 'c1', name: 'web_search', arguments: {} },
    ]);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0])).not.toContain('oops');
  });

  it('streamText already tolerates malformed arguments (partial-json)', async () => {
    quietWarn();
    const chunk = (args: string, index = 0, first = false, done = false) => ({
      choices: [
        {
          finish_reason: done ? 'tool_calls' : null,
          delta: {
            content: '',
            tool_calls: [
              {
                index,
                ...(first ? { id: 'c1' } : {}),
                function: {
                  ...(first ? { name: 'web_search' } : {}),
                  arguments: args,
                },
              },
            ],
          },
        },
      ],
    });
    const llm = llmWith(async () =>
      (async function* () {
        yield chunk('{"queries": ["a"]', 0, true);
        yield chunk('}}} not json', 0, false, true);
      })(),
    );

    const seen: any[] = [];
    for await (const part of llm.streamText({
      messages: [{ role: 'user', content: 'x' }],
    }))
      seen.push(...part.toolCallChunk);

    expect(seen.at(0)?.arguments).toEqual({ queries: ['a'] });
    expect(seen.at(-1)?.name).toBe('web_search');
    expect(seen.at(-1)?.arguments).toEqual({ queries: ['a'] });
  });
});
