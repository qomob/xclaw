import maxmind from 'maxmind';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let reader = null;

export async function initGeoIP() {
  const dbPath = config.geo.dbPath || path.resolve(__dirname, '../data/GeoLite2-City.mmdb');
  try {
    reader = await maxmind.open(dbPath);
    console.log(`GeoIP database loaded: ${dbPath}`);
  } catch (err) {
    console.warn(`GeoIP database not found at ${dbPath}, IP geolocation disabled`);
  }
}

export function lookup(ip) {
  if (!reader || !ip) return null;
  try {
    const result = reader.get(ip);
    if (result && result.location) {
      return {
        latitude: result.location.latitude,
        longitude: result.location.longitude,
        city: result.city?.names?.en,
        country: result.country?.iso_code
      };
    }
  } catch {}
  return null;
}
