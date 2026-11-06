import { applyPatch } from 'rfc6902';
import { Block } from '@/lib/types';

/* Applies one block event of the answer stream to a message's blocks and
   returns the new list (the input is not mutated, so it is safe inside a
   React state updater). Other event types return the list unchanged.

   - block: adds the block, or replaces it when the id exists (the
     reconnect snapshot re-sends blocks the client may already have);
   - updateBlock: RFC 6902 patch on a block;
   - appendText: appends a text delta to a text block. */
export const applyBlockEvent = (blocks: Block[], data: any): Block[] => {
  if (data.type === 'block') {
    const index = blocks.findIndex((b) => b.id === data.block.id);
    if (index === -1) return [...blocks, data.block];
    const next = [...blocks];
    next[index] = data.block;
    return next;
  }

  if (data.type === 'updateBlock') {
    return blocks.map((block) => {
      if (block.id !== data.blockId) return block;
      const updated = structuredClone(block);
      applyPatch(updated, data.patch);
      return updated;
    });
  }

  if (data.type === 'appendText') {
    return blocks.map((block) =>
      block.id === data.blockId && block.type === 'text'
        ? { ...block, data: block.data + data.delta }
        : block,
    );
  }

  return blocks;
};
