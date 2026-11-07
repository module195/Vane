/* G1-04: a tool name the model made up or a tool that throws used to crash
   the whole answer. They now come back to the model as a tool result that
   says what went wrong. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActionRegistry from '../researcher/actions/registry';
import { z } from 'zod';

const cfg = {
  researchBlockId: 'r',
  fileIds: [],
  mode: 'balanced',
} as any;

afterEach(() => {
  vi.restoreAllMocks();
  ActionRegistry.unregisterWhere((n) => n.startsWith('test_'));
});

const quietWarn = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('ActionRegistry.execute', () => {
  it('turns an unknown tool name into a note for the model', async () => {
    const warn = quietWarn();
    const out = await ActionRegistry.execute('test_made_up', {}, cfg);
    expect(out).toMatchObject({ type: 'search_results', results: [] });
    expect((out as any).note).toMatch(/test_made_up/);
    expect(warn).toHaveBeenCalled();
  });

  it('turns a throwing tool into a note, without the error message', async () => {
    quietWarn();
    ActionRegistry.register({
      name: 'test_throws',
      schema: z.object({}),
      enabled: () => true,
      getToolDescription: () => '',
      getDescription: () => '',
      execute: async () => {
        throw new TypeError('secret user query inside');
      },
    } as any);

    const out = await ActionRegistry.execute('test_throws', {}, cfg);
    expect(out).toMatchObject({ type: 'search_results', results: [] });
    expect((out as any).note).toMatch(/test_throws/);
    expect((out as any).note).toMatch(/TypeError/);
    expect((out as any).note).not.toMatch(/secret/);
  });

  it('still propagates an abort', async () => {
    ActionRegistry.register({
      name: 'test_aborts',
      schema: z.object({}),
      enabled: () => true,
      getToolDescription: () => '',
      getDescription: () => '',
      execute: async () => {
        throw new DOMException('aborted', 'AbortError');
      },
    } as any);

    await expect(
      ActionRegistry.execute('test_aborts', {}, cfg),
    ).rejects.toThrow(/aborted/);
  });

  it('keeps results in call order when one call fails', async () => {
    quietWarn();
    ActionRegistry.register({
      name: 'test_ok',
      schema: z.object({}),
      enabled: () => true,
      getToolDescription: () => '',
      getDescription: () => '',
      execute: async () => ({ type: 'done' }),
    } as any);

    const out = await ActionRegistry.executeAll(
      [
        { id: '1', name: 'test_nope', arguments: {} },
        { id: '2', name: 'test_ok', arguments: {} },
      ],
      cfg,
    );
    expect(out[0]).toMatchObject({ type: 'search_results' });
    expect(out[1]).toEqual({ type: 'done' });
  });
});
