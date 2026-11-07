import { describe, expect, it } from 'vitest';
import {
  configHash,
  modeSummary,
  costOf,
  taskMetrics,
  latencyTable,
} from '../lib/metrics';

const call = (over: any = {}) => ({
  kind: 'generateObject',
  startMs: 0,
  ms: 100,
  inputChars: 10,
  outputChars: 5,
  ...over,
});

describe('métricas por tarefa (G1-01)', () => {
  it('soma tokens e agrupa as chamadas por etapa', () => {
    const m = taskMetrics(
      [
        call({
          label: 'classifier',
          ms: 900,
          usage: {
            promptTokens: 100,
            completionTokens: 10,
            reasoningTokens: 300,
          },
        }),
        call({
          label: 'researcher',
          kind: 'streamText',
          ms: 2000,
          firstChunkMs: 400,
          usage: { promptTokens: 1000, completionTokens: 50 },
        }),
        call({ label: 'researcher', kind: 'streamText', ms: 1000 }),
        call({ kind: 'generateObject', ms: 50 }),
      ] as any,
      12_345,
    );
    expect(m.tokens).toEqual({
      prompt: 1100,
      completion: 60,
      reasoning: 300,
      callsWithUsage: 2,
    });
    expect(m.streamBytes).toBe(12_345);
    expect(m.byStage).toEqual({
      classifier: {
        calls: 1,
        ms: 900,
        promptTokens: 100,
        completionTokens: 10,
        reasoningTokens: 300,
      },
      researcher: {
        calls: 2,
        ms: 3000,
        promptTokens: 1000,
        completionTokens: 50,
        reasoningTokens: 0,
      },
      outro: {
        calls: 1,
        ms: 50,
        promptTokens: 0,
        completionTokens: 0,
        reasoningTokens: 0,
      },
    });
  });

  it('calcula custo só com preço informado', () => {
    const t = {
      prompt: 1_000_000,
      completion: 500_000,
      reasoning: 500_000,
      callsWithUsage: 1,
    };
    expect(costOf(t, undefined)).toBeNull();
    expect(
      costOf({ ...t, callsWithUsage: 0 }, { inputPerM: 1, outputPerM: 1 }),
    ).toBeNull();
    /* Reasoning is billed as output. */
    expect(costOf(t, { inputPerM: 0.2, outputPerM: 1 })).toBeCloseTo(1.2);
  });

  it('o hash muda com o modelo e não com a ordem das chaves', () => {
    const a = configHash({
      chat: 'qwen',
      embedding: 'nomic',
      scraper: 'readability',
    });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(
      configHash({ scraper: 'readability', embedding: 'nomic', chat: 'qwen' }),
    ).toBe(a);
    expect(
      configHash({ chat: 'gemma', embedding: 'nomic', scraper: 'readability' }),
    ).not.toBe(a);
  });

  it('resume por modo com falhas contadas à parte', () => {
    const s = modeSummary([
      {
        mode: 'speed',
        ok: true,
        totalMs: 1000,
        firstTokenMs: 400,
        tokens: { prompt: 10, completion: 5, reasoning: 0 },
      },
      {
        mode: 'speed',
        ok: true,
        totalMs: 3000,
        firstTokenMs: null,
        tokens: { prompt: 30, completion: 15, reasoning: 20 },
      },
      {
        mode: 'speed',
        ok: false,
        totalMs: 90000,
        firstTokenMs: null,
        tokens: { prompt: 0, completion: 0, reasoning: 0 },
      },
    ] as any);
    expect(s.speed).toEqual({
      runs: 3,
      failures: 2 - 1,
      meanTotalMs: 2000,
      meanFirstTokenMs: 400,
      meanPromptTokens: 20,
      meanCompletionTokens: 10,
      meanReasoningTokens: 10,
    });
  });

  it('monta a tabela de latência entre duas rodadas', () => {
    const ref = {
      speed: {
        runs: 2,
        failures: 0,
        meanTotalMs: 2000,
        meanFirstTokenMs: 800,
        meanPromptTokens: 100,
        meanCompletionTokens: 10,
        meanReasoningTokens: 50,
      },
    };
    const now = {
      speed: {
        runs: 2,
        failures: 1,
        meanTotalMs: 1500,
        meanFirstTokenMs: 600,
        meanPromptTokens: 90,
        meanCompletionTokens: 10,
        meanReasoningTokens: 0,
      },
    };
    const md = latencyTable(ref as any, now as any).join('\n');
    expect(md).toContain('| speed | tempo total (ms) | 2000 | 1500 | -25% |');
    expect(md).toContain('| speed | falhas | 0 | 1 |');
  });
});
