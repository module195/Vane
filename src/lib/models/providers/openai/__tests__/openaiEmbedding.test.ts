import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import OpenAIEmbedding from '../openaiEmbedding';

/* A server like LM Studio: it ignores encoding_format and always replies
   with float arrays. */
const vector = [0.031, -0.052, 0.41, -0.2];
let server: http.Server;
let baseURL = '';
const bodies: any[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          object: 'list',
          model: 'm',
          data: parsed.input.map((_: string, index: number) => ({
            object: 'embedding',
            index,
            embedding: vector,
          })),
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => server.close());

describe('OpenAIEmbedding', () => {
  it('keeps the vectors of servers that ignore encoding_format', async () => {
    const emb = new OpenAIEmbedding({ apiKey: 'x', model: 'm', baseURL });

    expect(await emb.embedText(['a', 'b'])).toEqual([vector, vector]);
    expect(
      await emb.embedChunks([{ content: 'c', metadata: {} } as any]),
    ).toEqual([vector]);
    expect(bodies.every((b) => b.encoding_format === 'float')).toBe(true);
  });
});
