import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Libraries from the environment, e.g.
 *   GV_LIBRARIES="/games/ps5=PS5,/games/ps4=PS4"
 * More can be added from the Settings page; these are re-registered at start-up.
 */
function parseLibraries(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.lastIndexOf('=');
      const p = i > 0 ? entry.slice(0, i) : entry;
      const platform = (i > 0 ? entry.slice(i + 1) : 'AUTO').toUpperCase();
      return { path: path.resolve(p), platform: ['PS4', 'PS5'].includes(platform) ? platform : 'AUTO' };
    });
}

export const config = {
  port: Number(process.env.GV_PORT) || 8686,
  host: process.env.GV_HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.GV_DATA_DIR || '/data'),
  libraries: parseLibraries(process.env.GV_LIBRARIES),
  scanIntervalHours: Number(process.env.GV_SCAN_INTERVAL_HOURS ?? 6),
  igdbClientId: process.env.IGDB_CLIENT_ID || '',
  igdbClientSecret: process.env.IGDB_CLIENT_SECRET || '',
  webDir: path.resolve(here, '../web/dist'),
  version: process.env.GV_VERSION || '0.1.0'
};
