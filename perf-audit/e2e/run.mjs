/* End-to-end tests of Vane's main flows in a real browser (Phase 5 of the
   performance audit, flows 1 to 5 of perf-audit/eval-plan.md §2).

     yarn build && yarn test:e2e

   Runs against the production build (.next/standalone), started here with
   an empty temporary DATA_DIR, and against fake-backends.mjs for the LLM,
   the embeddings and SearXNG. The browser never leaves 127.0.0.1: requests
   to other hosts (favicons, say) are answered with an empty 204 and listed.

   Every flow also fails on a console error, an uncaught page error, a failed
   request or an HTTP status >= 400, except the ones listed in KNOWN_OFFLINE
   (calls the server makes to the internet, which a test machine without
   internet cannot complete).

   Uses node:test and the `playwright` package (no @playwright/test). */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { answerFor, startFakeBackends } from './fake-backends.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const STANDALONE = path.join(ROOT, '.next', 'standalone');
const FILE_TOKEN = 'JABUTICABA-AZUL-7731';
const TIMEOUT = 30_000;

/* Failures that come from the server reaching the internet, not from Vane's
   own flow. Each one is matched on the URL and the status. */
const KNOWN_OFFLINE = [
  // Home weather card: the server action asks free.freeipapi.com for the
  // location, then /api/weather asks Open-Meteo.
  { url: /^http:\/\/127\.0\.0\.1:\d+\/$/, method: 'POST', status: 500 },
  { url: /\/api\/weather$/, status: 500 },
  // Source favicons: /api/favicon fetches the site's icon and answers 404
  // when it cannot.
  { url: /\/api\/favicon\?/, status: 404 },
];

/* The weather card's server action (getApproxLocation) throws when
   freeipapi.com is unreachable, and the browser gets React's production
   error for a failed server function. */
const KNOWN_OFFLINE_PAGE_ERRORS = [/Minified React error #441/];

/* ---------- server and browser ---------- */

const copyIfMissing = (from, to) => {
  if (!fs.existsSync(to)) fs.cpSync(from, to, { recursive: true });
};

const freePort = () =>
  new Promise((resolve) => {
    const srv = require('node:net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const waitFor = async (url, ms = 60_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server did not answer at ${url}`);
};

let fake, server, serverLog, dataDir, base, browser, page, problems, external;

before(async () => {
  if (!fs.existsSync(path.join(STANDALONE, 'server.js'))) {
    throw new Error('No production build: run `yarn build` first.');
  }
  /* The standalone build ships without these; the Dockerfile copies them. */
  copyIfMissing(
    path.join(ROOT, '.next', 'static'),
    path.join(STANDALONE, '.next', 'static'),
  );
  copyIfMissing(path.join(ROOT, 'public'), path.join(STANDALONE, 'public'));
  copyIfMissing(path.join(ROOT, 'drizzle'), path.join(STANDALONE, 'drizzle'));

  fake = await startFakeBackends();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vane-e2e-'));
  fs.mkdirSync(path.join(dataDir, 'data'));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  serverLog = [];
  server = spawn(process.execPath, ['server.js'], {
    cwd: STANDALONE,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      DATA_DIR: dataDir,
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      SEARXNG_API_URL: `http://127.0.0.1:${fake.port}`,
      NEXT_TELEMETRY_DISABLED: '1',
    },
  });
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  server.stderr.on('data', (d) => serverLog.push(String(d)));
  await waitFor(`${base}/`);

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1300, height: 900 },
    locale: 'pt-BR',
  });
  external = [];
  await context.route(
    (url) => url.hostname !== '127.0.0.1',
    (route) => {
      external.push(route.request().url());
      return route.fulfill({ status: 204, body: '' });
    },
  );
  page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  problems = [];
  const known = (url, method, status) =>
    KNOWN_OFFLINE.some(
      (k) =>
        k.url.test(url) &&
        (!k.method || k.method === method) &&
        k.status === status,
    );
  page.on('pageerror', (e) => {
    if (KNOWN_OFFLINE_PAGE_ERRORS.some((re) => re.test(e.message))) return;
    problems.push(`pageerror: ${e.message}`);
  });
  page.on('requestfailed', (r) => {
    const reason = r.failure()?.errorText ?? '';
    /* Navigating away cancels pending fetches and streams. */
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(reason)) return;
    problems.push(`requestfailed: ${r.method()} ${r.url()} ${reason}`);
  });
  page.on('response', (r) => {
    if (r.status() < 400) return;
    if (known(r.url(), r.request().method(), r.status())) return;
    problems.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    /* The browser repeats every failed response as a console error; those
       are judged above, by URL. */
    if (/^Failed to load resource/.test(m.text())) return;
    /* The weather card logs this when /api/weather fails (KNOWN_OFFLINE). */
    if (m.text() === 'Error fetching weather data') return;
    problems.push(`console: ${m.text()}`);
  });
});

after(async () => {
  await browser?.close();
  server?.kill();
  await fake?.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  if (external?.length) {
    const hosts = [...new Set(external.map((u) => new URL(u).hostname))];
    console.log(
      `# requests to other hosts answered with 204: ${hosts.join(', ')}`,
    );
  }
});

/* Each flow starts clean and ends with no unexpected error. */
const flow = (name, fn) =>
  test(name, async () => {
    problems.length = 0;
    try {
      await fn();
    } catch (err) {
      await page
        .screenshot({
          path: path.join(os.tmpdir(), `vane-e2e-${name.slice(0, 2)}.png`),
        })
        .catch(() => {});
      throw err;
    }
    assert.deepEqual(problems, [], `unexpected errors in "${name}"`);
  });

/* ---------- helpers ---------- */

const readConfig = () =>
  JSON.parse(
    fs.readFileSync(path.join(dataDir, 'data', 'config.json'), 'utf-8'),
  );

const MODE_TITLES = {
  speed: 'Velocidade',
  balanced: 'Equilibrado',
  quality: 'Qualidade',
};

/* The mode popover is the button with the mode icon and a chevron. */
const chooseMode = async (mode) => {
  await page
    .locator('button:has(svg.lucide-chevron-down)')
    .filter({
      has: page.locator('svg.lucide-zap, svg.lucide-sliders, svg.lucide-star'),
    })
    .first()
    .click();
  await page.getByText(MODE_TITLES[mode], { exact: true }).click();
};

const ask = async (question) => {
  const input = page.locator('textarea').first();
  await input.fill(question);
  await input.press('Enter');
};

/* The answer is done when the copy action of the message shows up. */
const waitAnswer = async (model) => {
  await page.getByText(answerFor(model).slice(0, 30)).first().waitFor();
  await page.waitForFunction(
    (text) => document.body.innerText.includes(text),
    'Ele resume as fontes',
  );
};

const citationLinks = () =>
  page
    .locator('span.group\\/citation > a')
    .evaluateAll((as) =>
      as.map((a) => ({ text: a.textContent, href: a.getAttribute('href') })),
    );

/* ---------- flows ---------- */

describe('Vane e2e', () => {
  flow(
    '1. primeiro acesso: configura o provedor pela tela de setup',
    async () => {
      await page.goto(`${base}/`);
      await page.getByRole('button', { name: 'Adicionar conexão' }).click();
      const dialog = page.locator('[role=dialog]');
      await dialog.locator('select').selectOption({ label: 'LM Studio' });
      await dialog.locator('input').nth(0).fill('LM falso');
      await dialog
        .locator('input')
        .nth(1)
        .fill(`http://127.0.0.1:${fake.port}`);
      await dialog.getByRole('button', { name: 'Adicionar conexão' }).click();
      await page.getByText('LM falso').first().waitFor();

      await page.getByRole('button', { name: 'Próximo' }).click();
      const [chat, embedding] = [
        page.locator('select').nth(0),
        page.locator('select').nth(1),
      ];
      await chat.selectOption({ label: 'LM falso - fake-chat' });
      await embedding.selectOption({ label: 'LM falso - fake-embed' });
      await page.getByRole('button', { name: 'Concluir' }).click();

      await page.getByPlaceholder('Pergunte qualquer coisa...').waitFor();
      const cfg = readConfig();
      assert.equal(cfg.setupComplete, true);
      const lm = cfg.modelProviders.find((p) => p.name === 'LM falso');
      assert.equal(lm.type, 'lmstudio');
      assert.equal(lm.config.baseURL, `http://127.0.0.1:${fake.port}`);
    },
  );

  for (const mode of ['speed', 'balanced', 'quality']) {
    flow(
      `2. busca no modo ${mode} com fontes e citações clicáveis`,
      async () => {
        await page.goto(`${base}/`);
        await chooseMode(mode);
        const sent = page.waitForRequest(
          (r) => r.url().endsWith('/api/chat') && r.method() === 'POST',
        );
        await ask(`o que é o Vane? (${mode})`);
        // The mode the user chose is the mode sent to the server.
        assert.equal((await sent).postDataJSON().optimizationMode, mode);
        await page.waitForURL(/\/c\/[\w-]+/);
        await waitAnswer('fake-chat');

        /* The fake answer cites [1] and [2]; quality keeps one source with
         the fake selector, so [2] has nothing to point at there. */
        const links = await citationLinks();
        assert.ok(links.length >= 1, `citations: ${JSON.stringify(links)}`);
        for (const l of links) {
          assert.match(l.href, /^https:\/\/example\.org\/\d$/);
        }
        assert.equal(links[0].text, '1');
        // The sources of the answer are listed with their titles.
        await page
          .getByText(/Resultado \d sobre/)
          .first()
          .waitFor();
      },
    );
  }

  flow('3. envia um arquivo e pergunta sobre ele', async () => {
    await page.goto(`${base}/`);
    const file = path.join(os.tmpdir(), `vane-e2e-nota-${process.pid}.txt`);
    fs.writeFileSync(
      file,
      `Nota de teste do Vane.\nO código do cofre é ${FILE_TOKEN}.\nNada mais importa aqui.\n`,
    );
    const upload = page.waitForResponse((r) =>
      r.url().endsWith('/api/uploads'),
    );
    await page.locator('input[type=file]').first().setInputFiles(file);
    assert.equal((await upload).status(), 200);
    fs.rmSync(file);

    await ask('Qual é o código do cofre no arquivo?');
    await page.waitForURL(/\/c\/[\w-]+/);
    await waitAnswer('fake-chat');
    const writer = await (
      await fetch(`http://127.0.0.1:${fake.port}/__writer`)
    ).json();
    assert.ok(
      JSON.stringify(writer.messages).includes(FILE_TOKEN),
      'the uploaded file did not reach the writer',
    );
  });

  flow('4. biblioteca: reabre uma conversa e apaga outra', async () => {
    await page.goto(`${base}/library`);
    const chats = page.locator('a[href^="/c/"]');
    await chats.first().waitFor();
    const before = await chats.count();
    assert.ok(before >= 4, `chats in the library: ${before}`);

    const href = await chats.first().getAttribute('href');
    await chats.first().click();
    await page.waitForURL(`**${href}`);
    await waitAnswer('fake-chat');
    assert.ok((await citationLinks()).length >= 1);

    await page.goto(`${base}/library`);
    await chats.first().waitFor();
    const doomed = await chats.first().getAttribute('href');
    const row = chats.first().locator('xpath=ancestor::div[.//button][1]');
    await row.locator('button:has(svg.lucide-trash)').first().click();
    const del = page.waitForResponse(
      (r) =>
        r.url().includes('/api/chats/') && r.request().method() === 'DELETE',
    );
    await page
      .locator('[role=dialog]')
      .getByRole('button', { name: 'Excluir' })
      .click();
    assert.equal((await del).status(), 200);
    await page.waitForFunction(
      (h) => !document.querySelector(`a[href="${h}"]`),
      doomed,
    );
    assert.equal(await chats.count(), before - 1);

    // Opening the deleted chat finds nothing (a 404 here is the expected answer).
    const gone = page.waitForResponse((r) =>
      r.url().endsWith(`/api${doomed.replace('/c/', '/chats/')}`),
    );
    await page.goto(`${base}${doomed}`);
    assert.equal((await gone).status(), 404);
    problems.splice(
      0,
      problems.length,
      ...problems.filter(
        (p) => !p.startsWith('http 404: GET') || !p.includes(doomed.slice(3)),
      ),
    );
    assert.ok(
      !(await page.content()).includes(answerFor('fake-chat').slice(0, 30)),
    );
  });

  flow('5. troca o modelo nas configurações e busca de novo', async () => {
    await page.goto(`${base}/`);
    await page.locator('div:has(> svg.lucide-settings)').last().click();
    await page
      .locator('[role=dialog]')
      .getByRole('button', { name: 'Modelos' })
      .first()
      .click();
    const chatSelect = page
      .locator('[role=dialog] select')
      .filter({
        has: page.locator('option', { hasText: 'LM falso - fake-chat-2' }),
      })
      .first();
    await chatSelect.selectOption({ label: 'LM falso - fake-chat-2' });
    assert.equal(
      await page.evaluate(() => localStorage.getItem('chatModelKey')),
      'fake-chat-2',
    );
    await page.keyboard.press('Escape');

    await page.goto(`${base}/`);
    await ask('o que é o Vane? (modelo 2)');
    await page.waitForURL(/\/c\/[\w-]+/);
    await waitAnswer('fake-chat-2');
    const writer = await (
      await fetch(`http://127.0.0.1:${fake.port}/__writer`)
    ).json();
    assert.equal(writer.model, 'fake-chat-2');
  });
});

process.on('exit', (code) => {
  if (code !== 0 && serverLog?.length) {
    console.log('# server log (last 40 lines):');
    console.log(
      serverLog
        .join('')
        .split('\n')
        .slice(-40)
        .map((l) => `#   ${l}`)
        .join('\n'),
    );
  }
});
