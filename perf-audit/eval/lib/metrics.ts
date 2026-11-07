/* Per-task latency, token and cost figures for the eval (G1-01). Built
   from the benchmark's InstrumentedLLM records, which keep timings, sizes
   and server-reported token counts, never prompt or answer text. */
import crypto from 'node:crypto';
import type { LLMCallStat } from '@/lib/benchmark/instrument';

export type Tokens = {
  prompt: number;
  completion: number;
  reasoning: number;
  /** Calls whose server reported usage; the rest count as zero. */
  callsWithUsage: number;
};

export type StageStat = {
  calls: number;
  ms: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
};

export type TaskMetrics = {
  tokens: Tokens;
  byStage: Record<string, StageStat>;
  /** Bytes of the session events the client would receive. */
  streamBytes: number;
};

export const taskMetrics = (
  calls: LLMCallStat[],
  streamBytes: number,
): TaskMetrics => {
  const tokens: Tokens = {
    prompt: 0,
    completion: 0,
    reasoning: 0,
    callsWithUsage: 0,
  };
  const byStage: Record<string, StageStat> = {};
  for (const c of calls) {
    const u = c.usage ?? {};
    const p = u.promptTokens ?? 0;
    const o = u.completionTokens ?? 0;
    const r = u.reasoningTokens ?? 0;
    if (c.usage) tokens.callsWithUsage += 1;
    tokens.prompt += p;
    tokens.completion += o;
    tokens.reasoning += r;
    const s = (byStage[c.label ?? 'outro'] ??= {
      calls: 0,
      ms: 0,
      promptTokens: 0,
      completionTokens: 0,
      reasoningTokens: 0,
    });
    s.calls += 1;
    s.ms += c.ms;
    s.promptTokens += p;
    s.completionTokens += o;
    s.reasoningTokens += r;
  }
  return { tokens, byStage, streamBytes };
};

export type Price = { inputPerM: number; outputPerM: number };

/** From EVAL_PRICE_INPUT_PER_M / EVAL_PRICE_OUTPUT_PER_M (USD per million
 *  tokens). A local model has no price: then cost stays null. */
export const readPrice = (): Price | undefined => {
  const i = Number(process.env.EVAL_PRICE_INPUT_PER_M);
  const o = Number(process.env.EVAL_PRICE_OUTPUT_PER_M);
  return Number.isFinite(i) && Number.isFinite(o) && (i > 0 || o > 0)
    ? { inputPerM: i, outputPerM: o }
    : undefined;
};

/** Reasoning tokens are billed as output. Null without a price, or when
 *  the server reported no token counts (a cost of 0 would mislead). */
export const costOf = (t: Tokens, price: Price | undefined) =>
  price && t.callsWithUsage > 0
    ? (t.prompt * price.inputPerM +
        (t.completion + t.reasoning) * price.outputPerM) /
      1_000_000
    : null;

const sortKeys = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .map((k) => [k, sortKeys((v as any)[k])]),
        )
      : v;

/** Short hash of what makes two runs comparable (models, scraper...). */
export const configHash = (config: Record<string, unknown>) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(sortKeys(config)))
    .digest('hex')
    .slice(0, 12);

export type RunRow = {
  mode: string;
  ok: boolean;
  totalMs: number;
  firstTokenMs: number | null;
  tokens: { prompt: number; completion: number; reasoning: number };
};

export type ModeStats = {
  runs: number;
  failures: number;
  meanTotalMs: number | null;
  meanFirstTokenMs: number | null;
  meanPromptTokens: number | null;
  meanCompletionTokens: number | null;
  meanReasoningTokens: number | null;
};

const mean = (xs: number[]) =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

/** Means over the tasks that finished; failures are counted, not averaged
 *  in (a failed task's time says nothing about latency). */
export const modeSummary = (rows: RunRow[]): Record<string, ModeStats> => {
  const out: Record<string, ModeStats> = {};
  for (const mode of [...new Set(rows.map((r) => r.mode))]) {
    const all = rows.filter((r) => r.mode === mode);
    const ok = all.filter((r) => r.ok);
    out[mode] = {
      runs: all.length,
      failures: all.length - ok.length,
      meanTotalMs: mean(ok.map((r) => r.totalMs)),
      meanFirstTokenMs: mean(
        ok.flatMap((r) => (r.firstTokenMs === null ? [] : [r.firstTokenMs])),
      ),
      meanPromptTokens: mean(ok.map((r) => r.tokens.prompt)),
      meanCompletionTokens: mean(ok.map((r) => r.tokens.completion)),
      meanReasoningTokens: mean(ok.map((r) => r.tokens.reasoning)),
    };
  }
  return out;
};

const ROWS: [keyof ModeStats, string][] = [
  ['meanTotalMs', 'tempo total (ms)'],
  ['meanFirstTokenMs', 'até o 1º token (ms)'],
  ['meanPromptTokens', 'tokens de entrada'],
  ['meanCompletionTokens', 'tokens de saída'],
  ['meanReasoningTokens', 'tokens de raciocínio'],
];

/** Markdown rows comparing two runs' per-mode means. */
export const latencyTable = (
  ref: Record<string, ModeStats>,
  now: Record<string, ModeStats>,
): string[] => {
  const lines = [
    '| Modo | Medida | Referência | Nova | Diferença |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const mode of Object.keys(now)) {
    const a = ref[mode];
    const b = now[mode];
    if (!a) continue;
    for (const [k, name] of ROWS) {
      const x = a[k];
      const y = b[k];
      const d =
        x !== null && y !== null && x !== 0
          ? `${y >= x ? '+' : ''}${Math.round(((y - x) / x) * 100)}%`
          : '-';
      lines.push(`| ${mode} | ${name} | ${x ?? '-'} | ${y ?? '-'} | ${d} |`);
    }
    lines.push(`| ${mode} | falhas | ${a.failures} | ${b.failures} | |`);
  }
  return lines;
};
