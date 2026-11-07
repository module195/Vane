/* The weather card asks the server for an approximate location. Without
   internet (or with freeipapi.com down) the server action used to throw:
   the server answered 500, the page got an unhandled error (React #441)
   and the card stayed on its loading skeleton. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getApproxLocation, reverseGeocode } from '../serverActions';

afterEach(() => vi.unstubAllGlobals());

const stubFetch = (impl: () => Promise<unknown>) =>
  vi.stubGlobal('fetch', vi.fn(impl));

describe('getApproxLocation', () => {
  it('returns the location from the IP lookup', async () => {
    stubFetch(async () =>
      Response.json({ latitude: -23.5, longitude: -46.6, cityName: 'SP' }),
    );
    await expect(getApproxLocation()).resolves.toEqual({
      latitude: -23.5,
      longitude: -46.6,
      city: 'SP',
    });
  });

  it('returns null instead of throwing when the network fails', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(getApproxLocation()).resolves.toBeNull();
  });

  it('returns null on an error status or a body without coordinates', async () => {
    stubFetch(async () => new Response('rate limited', { status: 429 }));
    await expect(getApproxLocation()).resolves.toBeNull();
    stubFetch(async () => Response.json({ cityName: 'X' }));
    await expect(getApproxLocation()).resolves.toBeNull();
  });
});

describe('reverseGeocode', () => {
  it('keeps the rounded position when the city lookup fails', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(reverseGeocode(-23.55052, -46.63331)).resolves.toEqual({
      latitude: -23.55,
      longitude: -46.63,
      city: '',
    });
  });
});
