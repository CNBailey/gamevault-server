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
  // Conversion service: incoming folders live here (PS5/, PS4/, _done/, _work/).
  incomingDir: path.resolve(process.env.GV_INCOMING || '/games/_incoming'),
  // USB drives plugged into the NAS appear under here (docker-compose maps /volumeUSB1 ...).
  usbRoot: path.resolve(process.env.GV_USB_ROOT || '/usb'),
  forgeBin: process.env.GV_FORGE_BIN || 'ps5-dump-forge',
  forgeVersion: process.env.FORGE_VERSION || '',
  version: process.env.GV_VERSION || '0.1.0'
};
