import { describe, expect, it } from 'vitest';
import { createNdjsonParser, readNdjsonStream } from '@/lib/hooks/ndjson';

const collect = () => {
  const seen: any[] = [];
  return { seen, parser: createNdjsonParser((m) => seen.push(m)) };
};

describe('createNdjsonParser', () => {
  it('handles each line once when a network chunk splits a line', () => {
    const { seen, parser } = collect();

    parser.push(
      '{"type":"block","n":1}\n{"type":"updateBlock","n":2}\n{"type":"mess',
    );
    parser.push('ageEnd"}\n');

    expect(seen).toEqual([
      { type: 'block', n: 1 },
      { type: 'updateBlock', n: 2 },
      { type: 'messageEnd' },
    ]);
  });

  it('handles a line split over many chunks and multi-byte text', () => {
    const { seen, parser } = collect();
    const line = JSON.stringify({ type: 'appendText', delta: 'ação ✓' }) + '\n';

    for (const ch of line) parser.push(ch);

    expect(seen).toEqual([{ type: 'appendText', delta: 'ação ✓' }]);
  });

  it('parses a last line without a trailing newline on flush', () => {
    const { seen, parser } = collect();

    parser.push('{"a":1}\n{"b":2}');
    expect(seen).toEqual([{ a: 1 }]);

    parser.flush();
    expect(seen).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('skips a malformed line without dropping the next ones', () => {
    const { seen, parser } = collect();

    parser.push('not json\n{"ok":true}\n');

    expect(seen).toEqual([{ ok: true }]);
  });
});

describe('readNdjsonStream', () => {
  it('reads a body whose byte chunks split lines and characters', async () => {
    const bytes = new TextEncoder().encode(
      '{"type":"block","data":"ação"}\n{"type":"messageEnd"}\n',
    );
    // Cut inside "ç" (2 bytes) and inside the second line.
    const cuts = [0, 27, 40, bytes.length];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < cuts.length - 1; i++) {
          controller.enqueue(bytes.slice(cuts[i], cuts[i + 1]));
        }
        controller.close();
      },
    });

    const seen: any[] = [];
    await readNdjsonStream(body, (m) => seen.push(m));

    expect(seen).toEqual([
      { type: 'block', data: 'ação' },
      { type: 'messageEnd' },
    ]);
  });
});
