import { afterEach, describe, expect, it, vi } from 'vitest';
import z from 'zod';
import OpenAILLM from '@/lib/models/providers/openai/openaiLLM';
import LMStudioLLM from '@/lib/models/providers/lmstudio/lmstudioLLM';
import LemonadeLLM from '@/lib/models/providers/lemonade/lemonadeLLM';
import GeminiLLM from '@/lib/models/providers/gemini/geminiLLM';
import OllamaLLM from '@/lib/models/providers/ollama/ollamaLLM';
import { structuredReasoning } from '@/lib/models/utils/reasoningControl';

const schema = z.object({ ok: z.boolean() });
const messages = [
  { role: 'system' as const, content: 'sys' },
  { role: 'user' as const, content: 'hi' },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const okReply = () =>
  Response.json({
    id: 'x',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: '{"ok": true}', refusal: null },
      },
    ],
  });

/* Records each request body. reject(body) returning a message answers 400. */
const captureOpenAI = (reject?: (body: any) => string | undefined) => {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const err = reject?.(body);
      if (err) {
        return Response.json(
          { error: { message: err, type: 'invalid_request_error' } },
          { status: 400 },
        );
      }
      return okReply();
    }),
  );
  return bodies;
};

const captureOllama = (reject?: (body: any) => string | undefined) => {
  const bodies: any[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const err = reject?.(body);
      if (err) return Response.json({ error: err }, { status: 400 });
      return Response.json({
        model: 'm',
        created_at: '',
        message: { role: 'assistant', content: '{"ok": true}' },
        done: true,
      });
    }),
  );
  return bodies;
};

const lmstudio = (model: string) =>
  new LMStudioLLM({ apiKey: 'k', model, baseURL: 'http://lms/v1' });

describe('LLM_STRUCTURED_REASONING', () => {
  it('defaults to "default" and accepts off / low', () => {
    expect(structuredReasoning()).toBe('default');
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'OFF');
    expect(structuredReasoning()).toBe('off');
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'low');
    expect(structuredReasoning()).toBe('low');
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'banana');
    expect(structuredReasoning()).toBe('default');
  });
});

describe('default mode keeps today’s requests', () => {
  it.each([
    ['LM Studio', () => lmstudio('qwen3.6-35b-a3b')],
    ['OpenAI', () => new OpenAILLM({ apiKey: 'k', model: 'gpt-5-mini' })],
    [
      'Gemini',
      () =>
        new GeminiLLM({
          apiKey: 'k',
          model: 'gemini-2.5-flash',
          baseURL: 'http://gemini/v1',
        }),
    ],
  ])('%s', async (_name, make) => {
    const bodies = captureOpenAI();
    await make().generateObject({ schema, messages });

    expect(bodies[0].chat_template_kwargs).toBeUndefined();
    expect(bodies[0].reasoning_effort).toBeUndefined();
    expect(bodies[0].messages).toEqual(messages);
  });

  it('Ollama only sends think:false for the known reasoning models', async () => {
    const bodies = captureOllama();
    await new OllamaLLM({
      baseURL: 'http://o',
      model: 'llama3.2',
    }).generateObject({ schema, messages });
    expect(bodies[0].think).toBeUndefined();
  });
});

describe('off mode', () => {
  it('LM Studio asks the chat template not to think and adds /no_think for Qwen3', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    const bodies = captureOpenAI();
    await lmstudio('qwen3.6-35b-a3b').generateObject({ schema, messages });

    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0].messages.at(-1)).toEqual({
      role: 'user',
      content: 'hi\n\n/no_think',
    });
    expect(bodies[0].messages[0]).toEqual(messages[0]);
  });

  it('does not add /no_think for other model families', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    const bodies = captureOpenAI();
    await new LemonadeLLM({
      apiKey: 'k',
      model: 'deepseek-r1-distill',
      baseURL: 'http://lemonade/v1',
    }).generateObject({ schema, messages });

    expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(bodies[0].messages).toEqual(messages);
  });

  it('gpt-oss cannot stop thinking, so it gets the lowest effort', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    const bodies = captureOpenAI();
    await lmstudio('openai/gpt-oss-20b').generateObject({ schema, messages });
    expect(bodies[0].reasoning_effort).toBe('low');
  });

  it('OpenAI reasoning models get the lowest effort they accept', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    const bodies = captureOpenAI();
    await new OpenAILLM({ apiKey: 'k', model: 'gpt-5-mini' }).generateObject({
      schema,
      messages,
    });
    await new OpenAILLM({ apiKey: 'k', model: 'o4-mini' }).generateObject({
      schema,
      messages,
    });
    await new OpenAILLM({ apiKey: 'k', model: 'gpt-4.1' }).generateObject({
      schema,
      messages,
    });

    expect(bodies[0].reasoning_effort).toBe('minimal');
    expect(bodies[1].reasoning_effort).toBe('low');
    expect(bodies[2].reasoning_effort).toBeUndefined();
    expect(bodies[2].chat_template_kwargs).toBeUndefined();
  });

  it('Gemini sends reasoning_effort none', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    const bodies = captureOpenAI();
    await new GeminiLLM({
      apiKey: 'k',
      model: 'gemini-2.5-flash',
      baseURL: 'http://gemini/v1',
    }).generateObject({ schema, messages });
    expect(bodies[0].reasoning_effort).toBe('none');
  });

  it('a 400 retries once without the parameters and remembers it', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = captureOpenAI((b) =>
      b.reasoning_effort
        ? 'Unrecognized request argument: reasoning_effort'
        : undefined,
    );
    const llm = new GeminiLLM({
      apiKey: 'k',
      model: 'gemini-2.5-pro',
      baseURL: 'http://gemini/v1',
    });

    await expect(llm.generateObject({ schema, messages })).resolves.toEqual({
      ok: true,
    });
    await llm.generateObject({ schema, messages });

    expect(bodies.map((b) => b.reasoning_effort)).toEqual([
      'none',
      undefined,
      undefined,
    ]);
  });

  it('a 400 that persists without the parameters is still thrown', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = captureOpenAI(() => 'context length exceeded');

    await expect(
      lmstudio('qwen3-8b').generateObject({ schema, messages }),
    ).rejects.toThrow(/context length/);
    expect(bodies).toHaveLength(2);
  });

  it('Ollama sends think:false for any model', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    const bodies = captureOllama();
    await new OllamaLLM({
      baseURL: 'http://o',
      model: 'my-thinker',
    }).generateObject({ schema, messages });
    expect(bodies[0].think).toBe(false);
  });

  it('Ollama retries without think when the model rejects it', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bodies = captureOllama((b) =>
      'think' in b ? '"llama3.2" does not support thinking' : undefined,
    );
    await expect(
      new OllamaLLM({ baseURL: 'http://o', model: 'llama3.2' }).generateObject({
        schema,
        messages,
      }),
    ).resolves.toEqual({ ok: true });
    expect(bodies.map((b) => b.think)).toEqual([false, undefined]);
  });
});

describe('low mode', () => {
  it('asks for low effort instead of turning thinking off', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'low');
    const bodies = captureOpenAI();
    await lmstudio('qwen3.6-35b-a3b').generateObject({ schema, messages });

    expect(bodies[0].reasoning_effort).toBe('low');
    expect(bodies[0].chat_template_kwargs).toBeUndefined();
    expect(bodies[0].messages).toEqual(messages);
  });

  it('Ollama uses think:"low" for gpt-oss and false otherwise', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'low');
    const bodies = captureOllama();
    await new OllamaLLM({
      baseURL: 'http://o',
      model: 'gpt-oss:20b',
    }).generateObject({ schema, messages });
    await new OllamaLLM({
      baseURL: 'http://o',
      model: 'qwen3:8b',
    }).generateObject({ schema, messages });
    expect(bodies.map((b) => b.think)).toEqual(['low', false]);
  });
});

describe('streamed steps are untouched', () => {
  it('generateText keeps its request in off mode', async () => {
    vi.stubEnv('LLM_STRUCTURED_REASONING', 'off');
    const bodies = captureOpenAI();
    await lmstudio('qwen3-8b').generateText({ messages });
    expect(bodies[0].chat_template_kwargs).toBeUndefined();
    expect(bodies[0].messages).toEqual(messages);
  });
});
