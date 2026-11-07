/* Automatic checks for one eval answer. No LLM involved. */

export type EvalRecord = {
  id: string;
  group: string;
  mode: 'speed' | 'balanced' | 'quality';
  query: string;
  expectSkipSearch: boolean;
  answer: string;
  sources: { title?: string; url?: string; content: string }[];
  error?: string;
  /** Chat path only: whether any streamed or saved block carried an
      embedding vector (see baseSearch.ts, G1-03 in improvements.md). */
  leaks?: { embeddingInStream: boolean; embeddingInDb: boolean };
};

export type CheckResult = { name: string; pass: boolean; detail?: string };

/* Reasoning models may stream <think> blocks; the UI hides them, so do we. */
export const visibleAnswer = (answer: string) =>
  answer.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/* [1], [2][3], [1, 2] and [1,2,3] are all citation forms the UI links. */
export const citedNumbers = (text: string): number[] => {
  const out: number[] = [];
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    m[1].split(',').forEach((n) => out.push(Number(n.trim())));
  }
  return out;
};

const PT = new Set(
  'que não para uma com são está também pelo pela mais como isso ele ela é ao de do da dos das em no na nos nas foi foram ser tem pode entre sobre qual quais quem'.split(
    ' ',
  ),
);
const EN = new Set(
  'the and is are was were with that this for of which it has have to in on be by from can'.split(
    ' ',
  ),
);

export const guessLanguage = (text: string): 'pt' | 'en' | 'unknown' => {
  const words = text
    .replace(/site:\S+/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .toLowerCase()
    .split(/[^\p{L}]+/u);
  let pt = 0;
  let en = 0;
  for (const w of words) {
    if (PT.has(w)) pt++;
    if (EN.has(w)) en++;
  }
  if (pt === en) return 'unknown';
  return pt > en ? 'pt' : 'en';
};

const outsideCode = (text: string) => {
  const lines: string[] = [];
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) lines.push(line);
  }
  return { lines, fencesBalanced: !inFence };
};

export const runChecks = (
  rec: EvalRecord,
  reference?: EvalRecord,
): CheckResult[] => {
  const text = visibleAnswer(rec.answer);
  const results: CheckResult[] = [];

  results.push({
    name: 'sem-erro',
    pass: !rec.error && text.length > 0,
    detail: rec.error,
  });

  const cited = citedNumbers(text);
  const bad = cited.filter((n) => n < 1 || n > rec.sources.length);
  results.push({
    name: 'citacoes-validas',
    pass: bad.length === 0,
    detail: bad.length
      ? `fora de 1..${rec.sources.length}: ${[...new Set(bad)].join(', ')}`
      : undefined,
  });

  if (rec.sources.length === 0) {
    results.push({
      name: 'sem-citacao-sem-busca',
      pass: cited.length === 0,
      detail: cited.length ? `${cited.length} citações sem fontes` : undefined,
    });
  }

  if (rec.expectSkipSearch) {
    results.push({
      name: 'busca-pulada',
      pass: rec.sources.length === 0,
      detail: rec.sources.length ? `${rec.sources.length} fontes` : undefined,
    });
  }

  const qLang = guessLanguage(rec.query);
  const aLang = guessLanguage(text);
  if (qLang !== 'unknown') {
    results.push({
      name: 'mesmo-idioma',
      pass: aLang === qLang,
      detail: `pergunta=${qLang} resposta=${aLang}`,
    });
  }

  /* A page the scraper could not read comes back as this placeholder;
     it must never reach the answer as a citable source. */
  const failed = rec.sources.filter(
    (s) =>
      s.title === 'Failed to scrape' ||
      /^# \S+\n\nError scraping content\.$/.test(s.content ?? ''),
  );
  results.push({
    name: 'sem-fonte-de-erro',
    pass: failed.length === 0,
    detail: failed.length
      ? failed.map((s) => s.url ?? '?').join(', ')
      : undefined,
  });

  if (rec.leaks) {
    const leak = rec.leaks.embeddingInStream || rec.leaks.embeddingInDb;
    results.push({
      name: 'sem-vetores-nos-blocos',
      pass: !leak,
      detail: leak
        ? `stream=${rec.leaks.embeddingInStream} banco=${rec.leaks.embeddingInDb}`
        : undefined,
    });
  }

  const { lines, fencesBalanced } = outsideCode(text);
  results.push({ name: 'markdown-blocos-fechados', pass: fencesBalanced });
  const h1 = lines.find((l) => /^#\s/.test(l));
  results.push({
    name: 'sem-titulo-principal',
    pass: !h1,
    detail: h1?.slice(0, 80),
  });

  if (rec.mode === 'quality' && reference) {
    const refLen = visibleAnswer(reference.answer).length;
    const ratio = refLen ? text.length / refLen : 1;
    results.push({
      name: 'tamanho-quality-30pct',
      pass: ratio >= 0.7 && ratio <= 1.3,
      detail: `${Math.round(ratio * 100)}% da referência`,
    });
  }

  return results;
};
