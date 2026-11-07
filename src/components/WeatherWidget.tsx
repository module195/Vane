'use client';

import { Wind } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getApproxLocation, reverseGeocode } from '@/lib/serverActions';
import { useTranslations } from 'next-intl';

const WeatherWidget = () => {
  const t = useTranslations('WeatherWidget');
  const [data, setData] = useState({
    temperature: 0,
    condition: '',
    location: '',
    humidity: 0,
    windSpeed: 0,
    icon: '',
    temperatureUnit: 'C',
    windSpeedUnit: 'm/s',
  });

  const [loading, setLoading] = useState(true);
  /* No location or no forecast (an install without internet, say): the
     card is hidden instead of staying on its skeleton or showing 0°. */
  const [unavailable, setUnavailable] = useState(false);

  type Location = { latitude: number; longitude: number; city: string };

  const getLocation = async (callback: (location: Location | null) => void) => {
    if (navigator.geolocation) {
      const result = await navigator.permissions.query({
        name: 'geolocation',
      });

      if (result.state === 'granted') {
        navigator.geolocation.getCurrentPosition(
          async (position) => {
            callback(
              await reverseGeocode(
                position.coords.latitude,
                position.coords.longitude,
              ).catch(() => null),
            );
          },
          async () => callback(await getApproxLocation()),
        );
      } else if (result.state === 'prompt') {
        callback(await getApproxLocation());
        navigator.geolocation.getCurrentPosition((position) => {});
      } else if (result.state === 'denied') {
        callback(await getApproxLocation());
      }
    } else {
      callback(await getApproxLocation());
    }
  };

  /* Looked up once; the 30 s refresh reuses it instead of asking the
     geolocation services again. */
  const locationRef = useRef<Location | null>(null);
  const shownRef = useRef(false);

  const withLocation = (callback: (location: Location | null) => void) => {
    if (locationRef.current) return callback(locationRef.current);
    getLocation((location) => {
      locationRef.current = location;
      callback(location);
    }).catch(() => callback(null));
  };

  const updateWeather = async () => {
    withLocation(async (location) => {
      if (!location) {
        setUnavailable(true);
        setLoading(false);
        return;
      }

      let res: Response;
      let data: any;
      try {
        res = await fetch(`/api/weather`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lat: location.latitude,
            lng: location.longitude,
            measureUnit: localStorage.getItem('measureUnit') ?? 'Metric',
          }),
        });
        data = await res.json();
      } catch {
        res = new Response(null, { status: 503 });
      }

      if (res.status !== 200) {
        /* A failed refresh keeps the forecast already on screen. */
        if (!shownRef.current) setUnavailable(true);
        setLoading(false);
        return;
      }

      shownRef.current = true;
      setUnavailable(false);

      setData({
        temperature: data.temperature,
        condition: data.condition,
        location: location.city,
        humidity: data.humidity,
        windSpeed: data.windSpeed,
        icon: data.icon,
        temperatureUnit: data.temperatureUnit,
        windSpeedUnit: data.windSpeedUnit,
      });
      setLoading(false);
    });
  };

  useEffect(() => {
    updateWeather();
    const intervalId = setInterval(updateWeather, 30 * 1000);
    return () => clearInterval(intervalId);
  }, []);

  if (unavailable) return null;

  return (
    <div className="bg-light-secondary dark:bg-dark-secondary rounded-2xl border border-light-200 dark:border-dark-200 shadow-sm shadow-light-200/10 dark:shadow-black/25 flex flex-row items-center w-full h-24 min-h-[96px] max-h-[96px] px-3 py-2 gap-3">
      {loading ? (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full animate-pulse">
            <div className="h-10 w-10 rounded-full bg-light-200 dark:bg-dark-200 mb-2" />
            <div className="h-4 w-10 rounded bg-light-200 dark:bg-dark-200" />
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-1 animate-pulse">
            <div className="flex flex-row items-center justify-between">
              <div className="h-3 w-20 rounded bg-light-200 dark:bg-dark-200" />
              <div className="h-3 w-12 rounded bg-light-200 dark:bg-dark-200" />
            </div>
            <div className="h-3 w-16 rounded bg-light-200 dark:bg-dark-200 mt-1" />
            <div className="flex flex-row justify-between w-full mt-auto pt-1 border-t border-light-200 dark:border-dark-200">
              <div className="h-3 w-16 rounded bg-light-200 dark:bg-dark-200" />
              <div className="h-3 w-8 rounded bg-light-200 dark:bg-dark-200" />
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col items-center justify-center w-16 min-w-16 max-w-16 h-full">
            <img
              src={`/weather-ico/${data.icon}.svg`}
              alt={data.condition}
              className="h-10 w-auto"
            />
            <span className="text-base font-semibold text-black dark:text-white">
              {data.temperature}°{data.temperatureUnit}
            </span>
          </div>
          <div className="flex flex-col justify-between flex-1 h-full py-2">
            <div className="flex flex-row items-center justify-between">
              <span className="text-sm font-semibold text-black dark:text-white">
                {data.location}
              </span>
              <span className="flex items-center text-xs text-black/60 dark:text-white/60 font-medium">
                <Wind className="w-3 h-3 mr-1" />
                {data.windSpeed} {data.windSpeedUnit}
              </span>
            </div>
            <span className="text-xs text-black/50 dark:text-white/50 italic">
              {data.condition}
            </span>
            <div className="flex flex-row justify-between w-full mt-auto pt-2 border-t border-light-200/50 dark:border-dark-200/50 text-xs text-black/50 dark:text-white/50 font-medium">
              <span>{t('humidity', { value: data.humidity })}</span>
              <span className="font-semibold text-black/70 dark:text-white/70">
                {t('now')}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default WeatherWidget;
