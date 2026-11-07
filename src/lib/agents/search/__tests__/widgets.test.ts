/* Characterization of the widgets (weather, stock, calculation) and their
   executor, Phase 5 of the performance audit. The LLM is a FakeLLM and the
   external APIs (Nominatim, Open-Meteo, Yahoo Finance) answer with recorded
   shapes, so the tests pin down what Vane does with them today, including
   the error paths. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeLLM } from '@/__tests__/helpers/fakes';

const yf = vi.hoisted(() => ({
  search: vi.fn(),
  quote: vi.fn(),
  chart: vi.fn(),
}));
vi.mock('yahoo-finance2', () => ({
  default: class {
    search = yf.search;
    quote = yf.quote;
    chart = yf.chart;
  },
}));

import calculationWidget from '../widgets/calculationWidget';
import weatherWidget from '../widgets/weatherWidget';
import stockWidget from '../widgets/stockWidget';
import WidgetExecutor from '../widgets/executor';
import { WidgetExecutor as RegisteredExecutor } from '../widgets';

const classification = (
  over: Partial<{
    showWeatherWidget: boolean;
    showStockWidget: boolean;
    showCalculationWidget: boolean;
  }> = {},
) =>
  ({
    classification: {
      skipSearch: false,
      personalSearch: false,
      academicSearch: false,
      discussionSearch: false,
      showWeatherWidget: false,
      showStockWidget: false,
      showCalculationWidget: false,
      ...over,
    },
    standaloneFollowUp: 'q',
  }) as any;

const input = (llm: FakeLLM, followUp = 'q') => ({
  chatHistory: [],
  followUp,
  classification: classification(),
  llm,
});

const llmReturning = (obj: unknown) =>
  new FakeLLM({ generateObject: () => obj });

/* Open-Meteo answers with 7 days of hourly data; the widget keeps 24 h. */
const hours = 7 * 24;
const meteo = {
  current: { temperature_2m: 21.5, weather_code: 3 },
  hourly: {
    time: Array.from({ length: hours }, (_, i) => `t${i}`),
    temperature_2m: Array.from({ length: hours }, (_, i) => i),
    precipitation_probability: Array.from({ length: hours }, () => 10),
    precipitation: Array.from({ length: hours }, () => 0),
    weather_code: Array.from({ length: hours }, () => 3),
  },
  daily: { temperature_2m_max: [25] },
  timezone: 'America/Sao_Paulo',
};

const fetchMock = vi.fn();
const json = (body: unknown) => ({ json: async () => body });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  yf.search.mockReset();
  yf.quote.mockReset();
  yf.chart.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('calculation widget', () => {
  it('evaluates the extracted expression with mathjs', async () => {
    const llm = llmReturning({ expression: '2 * (3 + 4)', notPresent: false });
    const out = await calculationWidget.execute(
      input(llm, 'quanto é 2x(3+4)?'),
    );
    expect(out).toEqual({
      type: 'calculation_result',
      llmContext:
        'The result of the calculation for the expression "2 * (3 + 4)" is: 14',
      data: { expression: '2 * (3 + 4)', result: 14 },
    });
    // The question reaches the extractor inside the follow-up tag.
    const user = (llm.calls[0].input as any).messages[1].content;
    expect(user).toContain('<user_follow_up>\nquanto é 2x(3+4)?');
  });

  it('returns nothing when the extractor says there is no expression', async () => {
    const out = await calculationWidget.execute(
      input(llmReturning({ expression: '', notPresent: true })),
    );
    expect(out).toBeUndefined();
  });

  it('throws on an expression mathjs cannot parse (the executor drops it)', async () => {
    await expect(
      calculationWidget.execute(
        input(llmReturning({ expression: '2 +* x(', notPresent: false })),
      ),
    ).rejects.toThrow();
  });

  it('runs only when the classifier asks for it', () => {
    expect(
      calculationWidget.shouldExecute(
        classification({ showCalculationWidget: true }),
      ),
    ).toBe(true);
    expect(calculationWidget.shouldExecute(classification())).toBe(false);
  });
});

describe('weather widget', () => {
  it('geocodes a place name, then keeps 24 hours of the forecast', async () => {
    fetchMock
      .mockResolvedValueOnce(json([{ lat: '-23.55', lon: '-46.63' }]))
      .mockResolvedValueOnce(json(meteo));
    const out: any = await weatherWidget.execute(
      input(
        llmReturning({
          location: 'São Paulo, SP, Brasil',
          lat: 0,
          lon: 0,
          notPresent: false,
        }),
      ),
    );

    const [geo, forecast] = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(geo).toBe(
      'https://nominatim.openstreetmap.org/search?q=S%C3%A3o%20Paulo%2C%20SP%2C%20Brasil&format=json&limit=1',
    );
    expect(forecast).toMatch(
      /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=-23\.55&longitude=-46\.63&/,
    );
    expect(fetchMock.mock.calls[0][1].headers['User-Agent']).toBe('Vane');

    expect(out.type).toBe('weather');
    expect(out.llmContext).toBe(
      `Weather in São Paulo, SP, Brasil is ${JSON.stringify(meteo.current)}`,
    );
    expect(out.data.location).toBe('São Paulo, SP, Brasil');
    expect(out.data.hourly.time).toHaveLength(24);
    expect(out.data.hourly.temperature_2m.at(-1)).toBe(23);
    expect(out.data.daily).toEqual(meteo.daily);
    expect(out.data.timezone).toBe('America/Sao_Paulo');
  });

  it('uses coordinates and reverse geocoding when the name is empty', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('reverse')
        ? json({ display_name: 'Lisboa, Portugal' })
        : json(meteo),
    );
    const out: any = await weatherWidget.execute(
      input(
        llmReturning({
          location: '',
          lat: 38.72,
          lon: -9.14,
          notPresent: false,
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out.llmContext).toMatch(/^Weather in Lisboa, Portugal is /);
    expect(out.data).toMatchObject({
      location: 'Lisboa, Portugal',
      latitude: 38.72,
      longitude: -9.14,
    });
  });

  it('reports an unknown place as an error widget, not an exception', async () => {
    fetchMock.mockResolvedValueOnce(json([]));
    const out: any = await weatherWidget.execute(
      input(
        llmReturning({ location: 'Xyzzy', lat: 0, lon: 0, notPresent: false }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.llmContext).toBe('Failed to fetch weather data.');
    expect(out.data.error).toContain(
      'Could not find coordinates for location: Xyzzy',
    );
  });

  it('reports a network failure as an error widget', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const out: any = await weatherWidget.execute(
      input(
        llmReturning({ location: 'Recife', lat: 0, lon: 0, notPresent: false }),
      ),
    );
    expect(out).toEqual({
      type: 'weather',
      llmContext: 'Failed to fetch weather data.',
      data: { error: 'Error fetching weather data: Error: ECONNREFUSED' },
    });
  });

  it('returns nothing when the question is not about weather', async () => {
    const out = await weatherWidget.execute(
      input(llmReturning({ location: '', lat: 0, lon: 0, notPresent: true })),
    );
    expect(out).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('stock widget', () => {
  const quote = {
    symbol: 'PETR4.SA',
    shortName: 'PETROBRAS PN',
    currency: 'BRL',
    marketState: 'REGULAR',
    regularMarketPrice: 37.1,
    regularMarketChange: 0.4,
    regularMarketChangePercent: 1.09,
    marketCap: 480e9,
    trailingPE: 5.2,
    dividendYield: 12.3,
  };
  const chart = {
    quotes: [
      { date: new Date('2026-11-06T13:00:00Z'), close: 36.7 },
      { date: new Date('2026-11-06T14:00:00Z'), close: 37.1 },
    ],
  };

  it('looks up the ticker, then the quote and seven chart ranges', async () => {
    yf.search.mockResolvedValue({ quotes: [{ symbol: 'PETR4.SA' }] });
    yf.quote.mockResolvedValue(quote);
    yf.chart.mockResolvedValue(chart);

    const out: any = await stockWidget.execute(
      input(
        llmReturning({
          name: 'Petrobras',
          comparisonNames: [],
          notPresent: false,
        }),
      ),
    );

    expect(yf.search).toHaveBeenCalledWith('Petrobras');
    expect(yf.quote).toHaveBeenCalledWith('PETR4.SA');
    expect(yf.chart).toHaveBeenCalledTimes(7);
    expect(out.type).toBe('stock');
    expect(out.llmContext).toBe(
      `Current price of PETROBRAS PN (PETR4.SA) is 37.1 BRL. Other details: ${JSON.stringify(
        {
          marketState: 'REGULAR',
          regularMarketChange: 0.4,
          regularMarketChangePercent: 1.09,
          marketCap: 480e9,
          peRatio: 5.2,
          dividendYield: 12.3,
        },
      )}`,
    );
    expect(out.data.chartData['1D']).toEqual({
      timestamps: chart.quotes.map((q) => q.date.getTime()),
      prices: [36.7, 37.1],
    });
    expect(out.data.comparisonData).toBeNull();
  });

  it('keeps going when a chart range fails', async () => {
    yf.search.mockResolvedValue({ quotes: [{ symbol: 'PETR4.SA' }] });
    yf.quote.mockResolvedValue(quote);
    yf.chart.mockRejectedValue(new Error('rate limited'));

    const out: any = await stockWidget.execute(
      input(
        llmReturning({
          name: 'Petrobras',
          comparisonNames: [],
          notPresent: false,
        }),
      ),
    );
    expect(out.llmContext).toMatch(/^Current price of PETROBRAS PN/);
    expect(Object.values(out.data.chartData).every((c) => c === null)).toBe(
      true,
    );
  });

  it('reports an unknown name as an error widget', async () => {
    yf.search.mockResolvedValue({ quotes: [] });
    const out = await stockWidget.execute(
      input(
        llmReturning({
          name: 'Nada SA',
          comparisonNames: [],
          notPresent: false,
        }),
      ),
    );
    expect(out).toEqual({
      type: 'stock',
      llmContext: 'Failed to fetch stock data.',
      data: {
        error:
          'Error fetching stock data: Failed to find quote for name/symbol: Nada SA',
        ticker: 'Nada SA',
      },
    });
    expect(yf.quote).not.toHaveBeenCalled();
  });

  it('drops a comparison name that is not found and keeps the others', async () => {
    yf.search.mockImplementation(async (name: string) =>
      name === 'Fantasma' ? { quotes: [] } : { quotes: [{ symbol: name }] },
    );
    yf.quote.mockImplementation(async (s: string) => ({ ...quote, symbol: s }));
    yf.chart.mockResolvedValue(chart);

    const out: any = await stockWidget.execute(
      input(
        llmReturning({
          name: 'PETR4.SA',
          comparisonNames: ['VALE3.SA', 'Fantasma'],
          notPresent: false,
        }),
      ),
    );
    expect(out.data.comparisonData.map((c: any) => c.ticker)).toEqual([
      'VALE3.SA',
    ]);
  });
});

describe('widget executor', () => {
  const saved = new Map(WidgetExecutor.widgets);
  afterEach(() => {
    WidgetExecutor.widgets = new Map(saved);
  });

  it('registers the three widgets on import', () => {
    expect([...RegisteredExecutor.widgets.keys()].sort()).toEqual([
      'calculationWidget',
      'stockWidget',
      'weatherWidget',
    ]);
  });

  it('runs only the widgets the classifier selected', async () => {
    const llm = llmReturning({ expression: '1+1', notPresent: false });
    const out = await RegisteredExecutor.executeAll({
      ...input(llm),
      classification: classification({ showCalculationWidget: true }),
    });
    expect(out.map((o) => o.type)).toEqual(['calculation_result']);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(yf.search).not.toHaveBeenCalled();
  });

  it('a widget that throws is left out and the others still answer', async () => {
    WidgetExecutor.widgets = new Map();
    WidgetExecutor.register({
      type: 'boom',
      shouldExecute: () => true,
      execute: async () => {
        throw new Error('boom');
      },
    });
    WidgetExecutor.register({
      type: 'ok',
      shouldExecute: () => true,
      execute: async () => ({ type: 'ok', llmContext: 'ok', data: null }),
    });
    WidgetExecutor.register({
      type: 'skip',
      shouldExecute: () => true,
      execute: async () => undefined,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await WidgetExecutor.executeAll(input(new FakeLLM({})));
    log.mockRestore();
    expect(out).toEqual([{ type: 'ok', llmContext: 'ok', data: null }]);
  });

  it('runs the selected widgets in parallel', async () => {
    WidgetExecutor.widgets = new Map();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    for (const type of ['a', 'b']) {
      WidgetExecutor.register({
        type,
        shouldExecute: () => true,
        execute: async () => {
          started.push(type);
          await gate;
          return { type, llmContext: type, data: null };
        },
      });
    }
    const pending = WidgetExecutor.executeAll(input(new FakeLLM({})));
    await Promise.resolve();
    expect(started).toEqual(['a', 'b']);
    release();
    expect((await pending).map((o) => o.type).sort()).toEqual(['a', 'b']);
  });
});
