/* A config.json that does not parse (a write cut short by a crash or a
   full disk, a hand edit with a stray comma) used to be overwritten with
   the defaults right away: providers, API keys and every setting were
   gone, with no copy left to recover them from. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let dir: string;
let savedDataDir: string | undefined;
const dataDir = () => path.join(dir, 'data');
const configFile = () => path.join(dataDir(), 'config.json');

const load = async () => {
  vi.resetModules();
  return (await import('@/lib/config')).default;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-cfg-recovery-'));
  fs.mkdirSync(dataDir());
  savedDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dir;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = savedDataDir;
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a config.json that does not parse', () => {
  const broken = '{"version": 1, "setupComplete": true, "modelProviders": [';

  it('is kept as a backup before the defaults are written', async () => {
    fs.writeFileSync(configFile(), broken);
    const config = await load();

    const backups = fs
      .readdirSync(dataDir())
      .filter((f) => f.startsWith('config.json.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(dataDir(), backups[0]), 'utf-8')).toBe(
      broken,
    );

    /* The app still starts, on the defaults. */
    expect(config.getConfig('setupComplete')).toBe(false);
    expect(() =>
      JSON.parse(fs.readFileSync(configFile(), 'utf-8')),
    ).not.toThrow();
  });

  it('names the backup in the log', async () => {
    fs.writeFileSync(configFile(), broken);
    await load();
    const logged = [
      ...vi.mocked(console.error).mock.calls,
      ...vi.mocked(console.log).mock.calls,
    ]
      .flat()
      .join(' ');
    expect(logged).toMatch(/config\.json\.corrupt-/);
  });
});

describe('saving the config', () => {
  it('leaves no temporary file behind and the file always parses', async () => {
    const config = await load();
    config.updateConfig('preferences.theme', 'dark');
    expect(
      JSON.parse(fs.readFileSync(configFile(), 'utf-8')).preferences.theme,
    ).toBe('dark');
    expect(
      fs.readdirSync(dataDir()).filter((f) => f !== 'config.json'),
    ).toEqual([]);
  });
});
