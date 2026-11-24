import { config } from './config.js';
import { db, getSetting } from './db.js';
import { scanLibrary, scanState } from './scanner.js';
import { scrapePending } from './scraper.js';

/** Registers the libraries given in GV_LIBRARIES (docker-compose) so they always exist. */
export function syncEnvLibraries() {
  const upsert = db.prepare(`INSERT INTO libraries (path, platform, from_env) VALUES (?, ?, 1)
    ON CONFLICT(path) DO UPDATE SET platform = excluded.platform, from_env = 1`);
  for (const lib of config.libraries) upsert.run(lib.path, lib.platform);
}

/** Starts a scan in the background. Returns false if one is already running. */
export function runScan({ libraryId = null, rescrapeAll = false } = {}) {
  if (scanState.running) return false;
  Object.assign(scanState, {
    running: true, phase: 'scanning', library: null, current: null, done: 0, total: 0, added: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null
  });
  (async () => {
    try {
      const libs = libraryId
        ? db.prepare('SELECT * FROM libraries WHERE id = ?').all(libraryId)
        : db.prepare('SELECT * FROM libraries WHERE enabled = 1 ORDER BY id').all();
      for (const lib of libs) {
        try {
          await scanLibrary(lib);
        } catch (err) {
          console.warn(`[scan] ${lib.path}: ${err.message}`);
          scanState.error = err.message;
        }
      }
      scanState.library = null;
      await scrapePending({ all: rescrapeAll });
    } catch (err) {
      scanState.error = err.message;
    } finally {
      Object.assign(scanState, { running: false, phase: 'idle', current: null, finishedAt: new Date().toISOString() });
    }
  })();
  return true;
}

let timer = null;
export function scheduleScans() {
  if (timer) clearInterval(timer);
  const hours = Number(getSetting('scan_interval_hours', String(config.scanIntervalHours)));
  if (hours > 0) timer = setInterval(() => runScan(), hours * 3600 * 1000);
}
