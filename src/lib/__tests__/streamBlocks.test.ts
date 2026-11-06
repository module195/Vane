import { describe, expect, it } from 'vitest';
import { applyBlockEvent } from '@/lib/hooks/streamBlocks';
import { Block } from '@/lib/types';

describe('applyBlockEvent', () => {
  it('adds a block, then appends text deltas to it', () => {
    let blocks: Block[] = [];
    blocks = applyBlockEvent(blocks, {
      type: 'block',
      block: { id: 't', type: 'text', data: 'Olá' },
    });
    blocks = applyBlockEvent(blocks, {
      type: 'appendText',
      blockId: 't',
      delta: ' mundo',
    });

    expect(blocks).toEqual([{ id: 't', type: 'text', data: 'Olá mundo' }]);
  });

  it('does not mutate the previous state (safe in a React updater)', () => {
    const before: Block[] = [
      { id: 't', type: 'text', data: 'a' },
      { id: 'r', type: 'research', data: { subSteps: [] } },
    ];
    const snapshot = structuredClone(before);

    applyBlockEvent(before, { type: 'appendText', blockId: 't', delta: 'b' });
    applyBlockEvent(before, {
      type: 'updateBlock',
      blockId: 'r',
      patch: [
        {
          op: 'add',
          path: '/data/subSteps/-',
          value: { id: 's', type: 'searching', searching: ['q'] },
        },
      ],
    });

    expect(before).toEqual(snapshot);
  });

  it('replaces a block re-sent by the reconnect snapshot', () => {
    const blocks: Block[] = [{ id: 't', type: 'text', data: 'old' }];

    const next = applyBlockEvent(blocks, {
      type: 'block',
      block: { id: 't', type: 'text', data: 'old and new' },
    });

    expect(next).toEqual([{ id: 't', type: 'text', data: 'old and new' }]);
  });

  it('ignores deltas for unknown or non-text blocks and other events', () => {
    const blocks: Block[] = [{ id: 's', type: 'source', data: [] }];

    expect(
      applyBlockEvent(blocks, { type: 'appendText', blockId: 's', delta: 'x' }),
    ).toEqual(blocks);
    expect(applyBlockEvent(blocks, { type: 'keepalive' })).toBe(blocks);
  });
});
