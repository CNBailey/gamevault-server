import { config } from './config.js';
import { db, getSetting } from './db.js';
import { scanLibrary, scanState } from './scanner.js';
import { scrapePending } from './scraper.js';

/**
 * When docker-compose moves a library (e.g. /games/ps5 -> /games/PS5 after mounting the
 * whole Games share), carry its games across so favourites and matches are kept.
 * Returns true when anything moved.
 */
function migrateMovedLibraries() {
  const wanted = new Set(config.libraries.map((l) => l.path));
  const existing = db.prepare('SELECT * FROM libraries').all();
  let moved = false;
  for (const lib of config.libraries) {
    if (existing.some((e) => e.path === lib.path)) continue;
    const old = existing.filter((e) => e.from_env && !wanted.has(e.path) && (e.platform === lib.platform || lib.platform === 'AUTO'));
    if (old.length !== 1) continue;
    const from = old[0].path;
    db.exec('BEGIN');
    try {
      db.prepare('UPDATE libraries SET path = ? WHERE id = ?').run(lib.path, old[0].id);
      db.prepare('UPDATE games SET path = ? || substr(path, ?) WHERE path = ? OR substr(path, 1, ?) = ?')
        .run(lib.path, from.length + 1, from, from.length + 1, `${from}/`);
      db.exec('COMMIT');
      console.log(`[libraries] moved ${from} -> ${lib.path}`);
      existing.find((e) => e.id === old[0].id).path = lib.path;
      moved = true;
    } catch (err) {
      db.exec('ROLLBACK');
      console.warn(`[libraries] could not move ${from}: ${err.message}`);
    }
  }
  // Libraries that were in docker-compose but no longer are: keep them, but stop scanning them.
  for (const e of existing) {
    if (e.from_env && !wanted.has(e.path)) db.prepare('UPDATE libraries SET from_env = 0, enabled = 0 WHERE id = ?').run(e.id);
  }
  return moved;
}

/** Registers the libraries given in GV_LIBRARIES (docker-compose) so they always exist. */
export function syncEnvLibraries() {
  const moved = migrateMovedLibraries();
  const upsert = db.prepare(`INSERT INTO libraries (path, platform, from_env) VALUES (?, ?, 1)
    ON CONFLICT(path) DO UPDATE SET platform = excluded.platform, from_env = 1`);
  for (const lib of config.libraries) upsert.run(lib.path, lib.platform);
  return moved;
}

let rescanWanted = new Set();
/**
 * Rescan the library for a platform soon (after a conversion published a file).
 * If a scan is running, it runs once that one finishes.
 */
export function requestLibraryScan(platform) {
  const lib = db.prepare('SELECT id FROM libraries WHERE enabled = 1 AND platform = ? ORDER BY id LIMIT 1').get(platform);
  if (!lib) return;
  rescanWanted.add(lib.id);
  setTimeout(drainRescans, 3000);
}

function drainRescans() {
  if (!rescanWanted.size) return;
  if (scanState.running) { setTimeout(drainRescans, 5000); return; }
  const [id] = rescanWanted;
  rescanWanted.delete(id);
  runScan({ libraryId: id });
  if (rescanWanted.size) setTimeout(drainRescans, 5000);
}

/** Starts a scan in the background. Returns false if one is already running. */
export function runScan({ libraryId = null, rescrapeAll = false } = {}) {
  if (scanState.running) return false;
  Object.assign(scanState, {
    running: true, phase: 'scanning', library: null, current: null, done: 0, total: 0, added: 0,
    startedAt: new Date().toISOString(), finishedAt: null, error: null, orphanPatches: []
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
