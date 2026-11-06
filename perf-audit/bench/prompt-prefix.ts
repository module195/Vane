/* Measures how much of the researcher system prompt stays byte-identical
   between two consecutive iterations of the same query. Prefix caches
   (OpenAI, Gemini, llama.cpp/LM Studio KV cache, Ollama) can only reuse the
   tokens before the first differing byte.

   Run: npx tsx perf-audit/bench/prompt-prefix.ts */
import { getResearcherPrompt } from '@/lib/prompts/search/researcher';

const sharedPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

const actionDesc = '<tool name="web_search">Search the web.</tool>';
const maxIteration = { speed: 2, balanced: 6, quality: 25 } as const;

const main = async () => {
  for (const mode of ['speed', 'balanced', 'quality'] as const) {
    const p1 = await getResearcherPrompt(
      actionDesc,
      mode,
      0,
      maxIteration[mode],
      [],
    );
    const p2 = await getResearcherPrompt(
      actionDesc,
      mode,
      1,
      maxIteration[mode],
      [],
    );
    const shared = sharedPrefix(p1, p2);
    console.log(
      `${mode.padEnd(8)} prompt ${p1.length} chars, shared prefix it1->it2 ${shared} chars (${((shared / p1.length) * 100).toFixed(1)}%)`,
    );
  }
};

main();
