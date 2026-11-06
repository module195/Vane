import { beforeAll, describe, expect, it, vi } from 'vitest';

/* Snapshots of every prompt, so any change to wording, order or the
   variable parts shows up in review and must pass the quality eval. */

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
});

describe('prompts', () => {
  it('classifier', async () => {
    const { classifierPrompt } = await import('../search/classifier');
    expect(classifierPrompt).toMatchSnapshot();
  });

  it.each(['speed', 'balanced', 'quality'] as const)(
    'researcher (%s)',
    async (mode) => {
      const { getResearcherPrompt } = await import('../search/researcher');
      expect(
        getResearcherPrompt('<tool name="x">desc</tool>', mode, 0, 6, []),
      ).toMatchSnapshot();
    },
  );

  it.each(['speed', 'balanced', 'quality'] as const)(
    'researcher prompt (%s) keeps a byte-identical prefix across iterations (prefix cache)',
    async (mode) => {
      const { getResearcherPrompt } = await import('../search/researcher');
      const files: string[] = [];
      const a = getResearcherPrompt('d', mode, 0, 6, files);
      const b = getResearcherPrompt('d', mode, 1, 6, files);
      let i = 0;
      while (a[i] === b[i]) i++;
      // Before: the iteration counter sat in the opening lines and only
      // ~420-450 chars (7-15%) were shared. Now only the last line differs.
      expect(a.slice(i).trim().split('\n')).toHaveLength(1);
      expect(i / a.length).toBeGreaterThan(0.95);
    },
  );

  it.each([
    ['speed', false],
    ['quality', false],
    ['balanced', true],
  ] as const)('writer (%s, skipSearch=%s)', async (mode, skip) => {
    const { getWriterPrompt } = await import('../search/writer');
    expect(
      getWriterPrompt('<ctx/>', 'Seja breve.', mode, skip),
    ).toMatchSnapshot();
  });

  it('suggestions', async () => {
    const { suggestionGeneratorPrompt } = await import('../suggestions');
    // The date inside is computed once, when the module loads.
    expect(
      suggestionGeneratorPrompt.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/, '<date>'),
    ).toMatchSnapshot();
  });

  it('media', async () => {
    const image = await import('../media/image');
    const video = await import('../media/videos');
    expect({ image, video }).toMatchSnapshot();
  });
});
