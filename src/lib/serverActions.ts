'use server';

/*
 * Location lookups for the weather widget. They run on the server so the
 * browser never contacts these geolocation services itself, and precise GPS
 * coordinates are rounded to about 1 km before they leave Vane.
 */

type ApproxLocation = { latitude: number; longitude: number; city: string };

const round = (n: number) => Math.round(n * 100) / 100;

/** Approximate location from the server's public IP (freeipapi.com), or
 *  null when the lookup fails (no internet, say): a server action that
 *  throws reaches the page as an unhandled error. */
export const getApproxLocation = async (): Promise<ApproxLocation | null> => {
  try {
    const res = await fetch('https://free.freeipapi.com/api/json', {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();

    const latitude = Number(data.latitude);
    const longitude = Number(data.longitude);
    if (
      data.latitude == null ||
      data.longitude == null ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    )
      return null;

    return { latitude, longitude, city: String(data.cityName ?? '') };
  } catch {
    return null;
  }
};

/** City name for a position, sent to BigDataCloud with rounded coordinates. */
export const reverseGeocode = async (
  latitude: number,
  longitude: number,
): Promise<ApproxLocation> => {
  const lat = round(Number(latitude));
  const lng = round(Number(longitude));

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error('Invalid coordinates');
  }

  let city = '';
  try {
    const res = await fetch(
      `https://api-bdc.io/data/reverse-geocode-client?latitude=${lat}&longitude=${lng}&localityLanguage=en`,
      { signal: AbortSignal.timeout(5000) },
    );
    city = String((await res.json()).locality ?? '');
  } catch {
    /* the weather still works without a city name */
  }

  return { latitude: lat, longitude: lng, city };
};
