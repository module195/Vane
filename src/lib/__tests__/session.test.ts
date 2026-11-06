import { describe, expect, it } from 'vitest';
import { applyPatch } from 'rfc6902';
import SessionManager from '../session';
import { TextBlock } from '../types';

describe('SessionManager', () => {
  it('applies JSON patches to blocks and sends late subscribers a snapshot', () => {
    const session = SessionManager.createSession();
    const block: TextBlock = { id: 'b1', type: 'text', data: 'Olá' };

    session.emitBlock(block);
    session.updateBlock('b1', [
      { op: 'replace', path: '/data', value: 'Olá mundo' },
    ]);
    session.emit('end', {});

    expect((session.getBlock('b1') as TextBlock).data).toBe('Olá mundo');
    expect(SessionManager.getSession(session.id)).toBe(session);

    const seen: string[] = [];
    const unsubscribe = session.subscribe((event, data) =>
      seen.push(`${event}:${data.type ?? ''}:${data.block?.data ?? ''}`),
    );
    // The patch is folded into the block: one event per block, not per patch.
    expect(seen).toEqual(['data:block:Olá mundo', 'end::']);

    session.emit('data', { type: 'researchComplete' });
    expect(seen.at(-1)).toBe('data:researchComplete:');

    unsubscribe();
    session.emit('data', { type: 'after' });
    expect(seen.at(-1)).toBe('data:researchComplete:');
  });

  it('sends a constant-size snapshot however many updates came before', () => {
    const session = SessionManager.createSession();
    session.emitBlock({ id: 't', type: 'text', data: '' });
    for (let i = 0; i < 500; i++) {
      const data = (session.getBlock('t') as TextBlock).data + `w${i} `;
      session.updateBlock('t', [{ op: 'replace', path: '/data', value: data }]);
    }

    const seen: any[] = [];
    session.subscribe((event, data) => seen.push({ event, data }));

    expect(seen).toHaveLength(1);
    expect(seen[0].data.block.data.startsWith('w0 w1 ')).toBe(true);
  });

  it('loses and duplicates nothing between the snapshot and live events', () => {
    const session = SessionManager.createSession();
    const words = Array.from({ length: 40 }, (_, i) => `p${i} `);
    const expected = words.join('');

    session.emitBlock({ id: 'r', type: 'source', data: [] });
    session.emit('data', { type: 'researchComplete' });
    session.emitBlock({ id: 't', type: 'text', data: '' });

    const push = (w: string) => {
      const data = (session.getBlock('t') as TextBlock).data + w;
      session.updateBlock('t', [{ op: 'replace', path: '/data', value: data }]);
    };

    words.slice(0, 15).forEach(push);

    // Rebuild the client's view from a mid-answer subscription.
    const blocks = new Map<string, any>();
    const order: string[] = [];
    session.subscribe((event, data) => {
      order.push(data?.type ?? event);
      if (data?.type === 'block') {
        blocks.set(data.block.id, structuredClone(data.block));
      } else if (data?.type === 'updateBlock') {
        applyPatch(blocks.get(data.blockId), data.patch);
      }
    });

    words.slice(15).forEach(push);
    session.emit('end', {});

    expect(blocks.get('t').data).toBe(expected);
    // researchComplete keeps its place between the source and text blocks.
    expect(order.slice(0, 3)).toEqual(['block', 'researchComplete', 'block']);
    expect(order.filter((t) => t === 'updateBlock')).toHaveLength(25);
    expect(order.at(-1)).toBe('end');
  });

  it('replays the error of a failed answer', () => {
    const session = SessionManager.createSession();
    // No subscriber yet (the client left): must not throw.
    expect(() => session.emit('error', { data: 'boom' })).not.toThrow();

    const seen: any[] = [];
    session.subscribe((event, data) => seen.push({ event, data }));

    expect(seen).toEqual([{ event: 'error', data: { data: 'boom' } }]);
  });
});
