/* Characterization of ConfigManager (data/config.json) and of the config
   and providers routes, Phase 5 of the performance audit. Each test loads a
   fresh ConfigManager against its own temporary DATA_DIR, so the tests pin
   down what happens on first start, on restart, with env vars, and when the
   settings UI writes. No real provider is called. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const ENV_KEYS = [
  'SEARCH_PROVIDER',
  'SEARXNG_API_URL',
  'FIRECRAWL_API_URL',
  'BIFROST_ENABLED',
  'BIFROST_URL',
  'BIFROST_VIRTUAL_KEY',
  'BIFROST_MCP_ENABLED',
  'BIFROST_MCP_TOOLS',
];

let dir: string;
let savedEnv: Record<string, string | undefined>;
const configFile = () => path.join(dir, 'data', 'config.json');
const readFile = () => JSON.parse(fs.readFileSync(configFile(), 'utf-8'));
const writeFile = (cfg: unknown) =>
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));

/* Every env var a provider field can be seeded from, so a developer's
   OPENAI_API_KEY does not leak into the expectations. Read once, against a
   throwaway DATA_DIR (config and providers import each other, so config
   has to load first). */
let providerEnvKeys: string[] = [];
beforeAll(async () => {
  const before = process.env.DATA_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-cfg-keys-'));
  fs.mkdirSync(path.join(scratch, 'data'));
  process.env.DATA_DIR = scratch;
  vi.resetModules();
  await import('@/lib/config');
  const { getModelProvidersUIConfigSection } =
    await import('@/lib/models/providers');
  providerEnvKeys = getModelProvidersUIConfigSection().flatMap((p) =>
    p.fields.map((f: any) => f.env).filter(Boolean),
  ) as string[];
  if (before === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = before;
  fs.rmSync(scratch, { recursive: true, force: true });
});

const load = async () => {
  vi.resetModules();
  return (await import('@/lib/config')).default;
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-cfg-'));
  fs.mkdirSync(path.join(dir, 'data'));
  savedEnv = { DATA_DIR: process.env.DATA_DIR };
  process.env.DATA_DIR = dir;
  const keys = [...ENV_KEYS, ...providerEnvKeys];
  for (const k of keys) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const emptyFile = (over: Record<string, unknown> = {}) => ({
  version: 1,
  setupComplete: true,
  preferences: {},
  personalization: {},
  modelProviders: [],
  search: { provider: 'searxng', searxngURL: '', firecrawlURL: '' },
  bifrost: {},
  ...over,
});

describe('ConfigManager on disk', () => {
  it('writes DATA_DIR/data/config.json with defaults on first start', async () => {
    const cm = await load();
    expect(cm.configPath).toBe(configFile());
    expect(readFile()).toMatchObject({
      version: 1,
      setupComplete: false,
      preferences: {},
      personalization: {},
      search: { provider: 'searxng', searxngURL: '', firecrawlURL: '' },
      bifrost: {},
    });
    expect(cm.isSetupComplete()).toBe(false);
  });

  it('reads the saved file on restart and keeps it', async () => {
    const cm = await load();
    cm.updateConfig('search.searxngURL', 'http://searx:8080');
    cm.markSetupComplete();

    const again = await load();
    expect(again.getConfig('search.searxngURL')).toBe('http://searx:8080');
    expect(again.isSetupComplete()).toBe(true);
  });

  it('env vars only fill empty search fields; the saved value wins', async () => {
    process.env.SEARXNG_API_URL = 'http://from-env:8080';
    process.env.FIRECRAWL_API_URL = 'http://firecrawl:3002';
    writeFile(
      emptyFile({
        search: { provider: 'searxng', searxngURL: 'http://saved:8080' },
      }),
    );
    const cm = await load();
    expect(cm.getConfig('search.searxngURL')).toBe('http://saved:8080');
    expect(cm.getConfig('search.firecrawlURL')).toBe('http://firecrawl:3002');
    // The seeded value is written back to the file.
    expect(readFile().search.firecrawlURL).toBe('http://firecrawl:3002');
  });

  it('bifrost env never flips a switch the UI turned off', async () => {
    process.env.BIFROST_ENABLED = 'true';
    process.env.BIFROST_URL = 'http://bifrost:8080';
    writeFile(emptyFile({ bifrost: { enabled: false, url: '' } }));
    const cm = await load();
    expect(cm.getConfig('bifrost.enabled')).toBe(false);
    expect(cm.getConfig('bifrost.url')).toBe('http://bifrost:8080');
  });

  it('a bifrost switch from env is stored as a boolean; absent env writes nothing', async () => {
    process.env.BIFROST_MCP_ENABLED = 'true';
    const cm = await load();
    expect(cm.getConfig('bifrost.mcpEnabled')).toBe(true);
    expect(cm.getConfig('bifrost.url')).toBeUndefined();
  });

  it('adds the bifrost section to a file written before it existed', async () => {
    const old: any = emptyFile({
      search: { provider: 'searxng', searxngURL: 'http://s', firecrawlURL: '' },
    });
    delete old.bifrost;
    writeFile(old);
    const cm = await load();
    expect(cm.getCurrentConfig().bifrost).toEqual({});
    expect(cm.getConfig('search.searxngURL')).toBe('http://s');
  });

  it('a corrupt file is replaced by the defaults (the settings are lost)', async () => {
    fs.writeFileSync(configFile(), '{ "setupComplete": true, ');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const cm = await load();
    err.mockRestore();
    log.mockRestore();
    expect(cm.isSetupComplete()).toBe(false);
    expect(readFile().setupComplete).toBe(false);
  });

  it('seeds a provider from env once, even across restarts', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-not-a-real-key';
    const openai = (cm: any) =>
      cm
        .getCurrentConfig()
        .modelProviders.filter((p: any) => p.type === 'openai');

    const first = await load();
    expect(openai(first)).toHaveLength(1);
    expect(openai(first)[0].config.apiKey).toBe('sk-test-not-a-real-key');

    const again = await load();
    expect(openai(again)).toHaveLength(1);
  });

  it('getConfig walks dotted paths and falls back to the default', async () => {
    const cm = await load();
    expect(cm.getConfig('search.provider')).toBe('searxng');
    expect(cm.getConfig('search.missing', 'x')).toBe('x');
    expect(cm.getConfig('nope.deeper.still', 7)).toBe(7);
  });

  it('getCurrentConfig returns a copy', async () => {
    const cm = await load();
    cm.getCurrentConfig().search.provider = 'changed';
    expect(cm.getConfig('search.provider')).toBe('searxng');
  });

  it('updateConfig refuses prototype keys and empty segments', async () => {
    const cm = await load();
    expect(() => cm.updateConfig('__proto__.polluted', 1)).toThrow(
      /Invalid config key/,
    );
    expect(() => cm.updateConfig('search..x', 1)).toThrow(/Invalid config key/);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('a password field sent back as the mask keeps the stored value', async () => {
    const { SECRET_MASK } = await import('@/lib/config/secrets');
    const cm = await load();
    cm.updateUIConfig('bifrost.virtualKey', 'vk-secret');
    cm.updateUIConfig('bifrost.virtualKey', SECRET_MASK);
    expect(readFile().bifrost.virtualKey).toBe('vk-secret');
  });

  it('adds, updates (keeping masked keys) and removes a provider', async () => {
    const cm = await load();
    const { SECRET_MASK } = await import('@/lib/config/secrets');
    const stored = (id: string) =>
      readFile().modelProviders.find((x: any) => x.id === id);

    const p = cm.addModelProvider('openai', 'Minha OpenAI', {
      apiKey: 'sk-a',
      baseURL: 'https://api.openai.com/v1',
    });
    expect(p.hash).toBeTruthy();

    await cm.updateModelProvider(p.id, 'Renomeada', {
      apiKey: SECRET_MASK,
      baseURL: 'http://proxy/v1',
    });
    expect(stored(p.id).name).toBe('Renomeada');
    expect(stored(p.id).config).toEqual({
      apiKey: 'sk-a',
      baseURL: 'http://proxy/v1',
    });

    cm.addProviderModel(p.id, 'chat', {
      key: 'gpt-x',
      name: 'GPT X',
      type: 'chat',
    });
    expect(stored(p.id).chatModels).toEqual([{ key: 'gpt-x', name: 'GPT X' }]);
    cm.removeProviderModel(p.id, 'chat', 'gpt-x');
    expect(stored(p.id).chatModels).toEqual([]);

    cm.removeModelProvider(p.id);
    expect(stored(p.id)).toBeUndefined();
    await expect(cm.updateModelProvider('nope', 'x', {})).rejects.toThrow(
      'Provider not found',
    );
  });
});

describe('config and providers routes', () => {
  /* The routes ask every configured provider for its models; stub that so
     no network call is made. */
  const routes = async (providers: any[] = []) => {
    vi.resetModules();
    vi.doMock('@/lib/models/registry', () => ({
      default: class {
        getActiveProviders = async () => providers;
        addProvider = async (type: string, name: string, config: any) => {
          const cm = (await import('@/lib/config')).default;
          return cm.addModelProvider(type, name, config);
        };
      },
    }));
    const config = await import('@/app/api/config/route');
    const prov = await import('@/app/api/providers/route');
    const cm = (await import('@/lib/config')).default;
    return { config, prov, cm };
  };

  const req = (body: unknown) => ({ json: async () => body }) as any;

  afterEach(() => {
    vi.doUnmock('@/lib/models/registry');
  });

  it('GET /api/config masks provider keys and password fields', async () => {
    const { config, cm } = await routes();
    const p = cm.addModelProvider('openai', 'OpenAI', {
      apiKey: 'sk-secret',
      baseURL: 'https://api.openai.com/v1',
    });
    cm.updateUIConfig('bifrost.virtualKey', 'vk-secret');

    const body = await (await config.GET({} as any)).json();
    const text = JSON.stringify(body);
    expect(text).not.toContain('sk-secret');
    expect(text).not.toContain('vk-secret');
    const sent = body.values.modelProviders.find((x: any) => x.id === p.id);
    expect(sent.config).toEqual({
      apiKey: '••••••••',
      baseURL: 'https://api.openai.com/v1',
    });
    expect(body.values.bifrost.virtualKey).toBe('••••••••');
    expect(Object.keys(body.fields)).toEqual(
      expect.arrayContaining([
        'preferences',
        'search',
        'bifrost',
        'modelProviders',
      ]),
    );
  });

  it('GET /api/config shows the live model list of each provider', async () => {
    const first = await routes();
    const p = first.cm.addModelProvider('openai', 'OpenAI', {
      apiKey: 'k',
      baseURL: 'u',
    });
    const { config } = await routes([
      {
        id: p.id,
        name: 'OpenAI',
        chatModels: [{ key: 'm1', name: 'M1' }],
        embeddingModels: [],
      },
    ]);
    const body = await (await config.GET({} as any)).json();
    expect(
      body.values.modelProviders.find((x: any) => x.id === p.id).chatModels,
    ).toEqual([{ key: 'm1', name: 'M1' }]);
  });

  it('POST /api/config: 400 for a missing value or a refused key, 200 writes', async () => {
    const { config } = await routes();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect((await config.POST(req({ key: 'search.searxngURL' }))).status).toBe(
      400,
    );
    const refused = await config.POST(
      req({ key: 'modelProviders.0.config.apiKey', value: 'x' }),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toMatch(/Invalid config key/);

    const ok = await config.POST(
      req({ key: 'search.searxngURL', value: 'http://s:8080' }),
    );
    expect(ok.status).toBe(200);
    expect(readFile().search.searxngURL).toBe('http://s:8080');

    // false is a valid switch value.
    const off = await config.POST(
      req({ key: 'bifrost.enabled', value: false }),
    );
    expect(off.status).toBe(200);
    expect(readFile().bifrost.enabled).toBe(false);

    // A body that is not JSON is a 500, not a 400.
    const bad = await config.POST({
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as any);
    expect(bad.status).toBe(500);
    err.mockRestore();
  });

  it('GET /api/providers hides providers whose model list failed and sends no config', async () => {
    const { prov } = await routes([
      {
        id: 'a',
        name: 'ok',
        chatModels: [{ key: 'm', name: 'm' }],
        embeddingModels: [],
      },
      {
        id: 'b',
        name: 'down',
        chatModels: [{ key: 'error', name: 'ECONNREFUSED' }],
        embeddingModels: [],
      },
    ]);
    const body = await (await prov.GET({} as any)).json();
    expect(body.providers.map((p: any) => p.id)).toEqual(['a']);
    expect(body.providers[0]).not.toHaveProperty('config');
  });

  it('POST /api/providers: 400 without fields, masked key in the answer', async () => {
    const { prov } = await routes();
    expect((await prov.POST(req({ type: 'openai', name: 'x' }))).status).toBe(
      400,
    );

    const res = await prov.POST(
      req({
        type: 'openai',
        name: 'Nova',
        config: { apiKey: 'sk-new', baseURL: 'u' },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.config.apiKey).toBe('••••••••');
    expect(JSON.stringify(body)).not.toContain('sk-new');
    // Stored in full on disk.
    expect(
      readFile().modelProviders.find((p: any) => p.name === 'Nova').config
        .apiKey,
    ).toBe('sk-new');
  });
});
