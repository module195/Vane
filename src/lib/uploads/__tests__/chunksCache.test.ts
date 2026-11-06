import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* The search path used to read and JSON.parse every .content.json
   synchronously on each call (6x per balanced query just for the prompt).
   getFileChunksCached parses a file once and reuses it while its mtime and
   size stay the same. */
describe('UploadManager.getFileChunksCached', () => {
  let root: string;
  const originalDataDir = process.env.DATA_DIR;

  const writeContent = (p: string, chunks: string[]) =>
    fs.writeFileSync(
      p,
      JSON.stringify({
        chunks: chunks.map((content) => ({ content, embedding: [1] })),
      }),
    );

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-chunks-cache-'));
    process.env.DATA_DIR = root;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const setup = async () => {
    const dir = path.join(root, 'data', 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const contentPath = path.join(dir, 'a.content.json');
    writeContent(contentPath, ['one', 'two']);
    fs.writeFileSync(
      path.join(dir, 'uploaded_files.json'),
      JSON.stringify({
        files: [
          {
            id: 'a',
            name: 'a.txt',
            filePath: path.join(dir, 'a.txt'),
            contentPath,
            uploadedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
    );
    const { default: UploadManager } = await import('../manager');
    return { UploadManager, contentPath };
  };

  it('parses a file once and reuses it', async () => {
    const { UploadManager, contentPath } = await setup();
    const readFile = vi.spyOn(fs.promises, 'readFile');

    const first = await UploadManager.getFileChunksCached('a');
    const second = await UploadManager.getFileChunksCached('a');

    expect(first.map((c) => c.content)).toEqual(['one', 'two']);
    expect(second).toBe(first);
    expect(
      readFile.mock.calls.filter(([p]) => p === contentPath),
    ).toHaveLength(1);
  });

  it('reads the file again when it changes on disk', async () => {
    const { UploadManager, contentPath } = await setup();
    await UploadManager.getFileChunksCached('a');

    writeContent(contentPath, ['changed', 'content', 'here']);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(contentPath, later, later);

    expect(
      (await UploadManager.getFileChunksCached('a')).map((c) => c.content),
    ).toEqual(['changed', 'content', 'here']);
  });

  it('does not keep a file larger than the cache budget', async () => {
    const { UploadManager, contentPath } = await setup();
    const size = fs.statSync(contentPath).size;
    UploadManager.chunksCacheMaxBytes = size - 1;
    const readFile = vi.spyOn(fs.promises, 'readFile');

    await UploadManager.getFileChunksCached('a');
    await UploadManager.getFileChunksCached('a');

    // Too big to keep: read every time, never cached.
    expect(
      readFile.mock.calls.filter(([p]) => p === contentPath),
    ).toHaveLength(2);
  });

  it('returns [] for an unknown file', async () => {
    const { UploadManager } = await setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await UploadManager.getFileChunksCached('missing')).toEqual([]);
  });
});
