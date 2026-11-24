import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { db, getSetting, rowToGame, setSetting } from '../db.js';
import { resolveInside, walkFiles } from '../files.js';
import { badgesDir, defaultBadgesDir } from '../media.js';
import { runScan, scheduleScans } from '../jobs.js';
import { purgeMissing, scanState } from '../scanner.js';
import { garlicEnabled, garlicStatus, lookupStats, setGarlicEnabled } from '../garlicsaves.js';
import { candidateSummary, matchGame, resetToken, scrapeGame, scraperConfigured, searchIgdb } from '../scraper.js';

const SORTS = {
  added: (a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''),
  title: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
  released: (a, b) => (b.releaseDate || '').localeCompare(a.releaseDate || '') || SORTS.title(a, b),
  year: (a, b) => (b.year || 0) - (a.year || 0),
  rating: (a, b) => (b.criticScore ?? b.userScore ?? -1) - (a.criticScore ?? a.userScore ?? -1),
  size: (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0)
};

function notFound(reply, what = 'Game') {
  return reply.code(404).send({ error: `${what} not found` });
}

function getRow(id) {
  return db.prepare('SELECT * FROM games WHERE id = ?').get(Number(id));
}

/** Files that make up a game, relative to its root, for clients that download it. */
async function gameFiles(row) {
  if (row.kind === 'ps4-pkg' || row.kind === 'ps5-exfat') {
    const pkgs = JSON.parse(row.pkgs || '[]');
    return pkgs.map((p) => ({ path: p.path, size: p.size, category: p.category, version: p.version }));
  }
  return (await walkFiles(row.path)).map(({ path: p, size }) => ({ path: p, size }));
}

function gameRoot(row) {
  // A loose .pkg or an .exfat image is stored by its file path; its "root" is the folder it sits in.
  return /\.(pkg|exfat)$/i.test(row.path) ? path.dirname(row.path) : row.path;
}

async function sendFileWithRange(req, reply, file) {
  const stat = await fsp.stat(file);
  const size = stat.size;
  const name = path.basename(file);
  reply
    .header('Accept-Ranges', 'bytes')
    .header('Content-Type', 'application/octet-stream')
    .header('Last-Modified', stat.mtime.toUTCString())
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    let start = m && m[1] !== '' ? Number(m[1]) : null;
    let end = m && m[2] !== '' ? Number(m[2]) : null;
    if (start === null && end !== null) { start = Math.max(0, size - end); end = size - 1; }
    if (end === null || end >= size) end = size - 1;
    if (!m || start === null || start > end || start >= size) {
      return reply.code(416).header('Content-Range', `bytes */${size}`).send();
    }
    reply.code(206).header('Content-Range', `bytes ${start}-${end}/${size}`).header('Content-Length', end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end, highWaterMark: 1024 * 1024 }));
  }
  reply.header('Content-Length', size);
  return reply.send(fs.createReadStream(file, { highWaterMark: 1024 * 1024 }));
}

export default async function api(app) {
  app.get('/health', async () => ({
    ok: true,
    version: config.version,
    games: db.prepare('SELECT COUNT(*) AS n FROM games WHERE missing = 0').get().n
  }));

  app.get('/badges', async () => {
    const out = {};
    for (const p of ['PS5', 'PS4']) {
      const file = ['svg', 'png', 'webp'].map((ext) => `${p.toLowerCase()}.${ext}`).find((f) => fs.existsSync(path.join(badgesDir, f)));
      out[p] = file
        ? `/badges/${file}?v=${Math.round(fs.statSync(path.join(badgesDir, file)).mtimeMs)}`
        : fs.existsSync(path.join(defaultBadgesDir, `${p.toLowerCase()}.png`)) ? `/badges/default/${p.toLowerCase()}.png` : null;
    }
    return out;
  });

  // ---- Games ---------------------------------------------------------------
  app.get('/games', async (req) => {
    const { platform, genre, q, fav, sort = 'title', status, includeMissing, apps = 'show' } = req.query;
    let games = db.prepare('SELECT * FROM games').all().map((r) => rowToGame(r));
    if (!includeMissing) games = games.filter((g) => !g.missing);
    if (apps === 'hide') games = games.filter((g) => !g.isApp);
    if (apps === 'only') games = games.filter((g) => g.isApp);
    if (platform && platform !== 'All') games = games.filter((g) => g.platform === platform.toUpperCase());
    if (genre && genre !== 'All') games = games.filter((g) => g.genres.includes(genre));
    if (fav === '1' || fav === 'true') games = games.filter((g) => g.favourite);
    if (status) games = games.filter((g) => status.split(',').includes(g.matchStatus));
    if (q) {
      const needle = q.toLowerCase();
      games = games.filter((g) => g.title.toLowerCase().includes(needle));
    }
    games.sort(SORTS[sort] || SORTS.title);
    return { total: games.length, games };
  });

  app.get('/genres', async () => {
    const counts = new Map();
    for (const r of db.prepare('SELECT genres FROM games WHERE missing = 0').all()) {
      for (const g of JSON.parse(r.genres || '[]')) counts.set(g, (counts.get(g) || 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  });

  app.get('/games/:id', async (req, reply) => {
    const row = getRow(req.params.id);
    if (!row) return notFound(reply);
    const official = row.title_id ? db.prepare('SELECT name FROM title_lookups WHERE title_id = ? AND found = 1').get(row.title_id) : null;
    return { ...rowToGame(row, { full: true }), officialName: official?.name || null };
  });

  app.put('/games/:id/favourite', async (req, reply) => {
    const row = getRow(req.params.id);
    if (!row) return notFound(reply);
    const value = req.body && typeof req.body.favourite === 'boolean' ? req.body.favourite : !row.favourite;
    db.prepare('UPDATE games SET favourite = ? WHERE id = ?').run(value ? 1 : 0, row.id);
    return rowToGame(getRow(row.id));
  });

  app.post('/games/:id/rescrape', async (req, reply) => {
    const row = getRow(req.params.id);
    if (!row) return notFound(reply);
    try { await scrapeGame(row.id); } catch (err) { return reply.code(502).send({ error: err.message }); }
    return rowToGame(getRow(row.id), { full: true });
  });

  app.get('/games/:id/candidates', async (req, reply) => {
    const row = getRow(req.params.id);
    if (!row) return notFound(reply);
    try {
      const results = await searchIgdb(req.query.q || row.local_title || row.title || '', row.platform);
      return results.map(candidateSummary);
    } catch (err) {
      return reply.code(502).send({ error: err.message });
    }
  });

  app.post('/games/:id/match', async (req, reply) => {
    const row = getRow(req.params.id);
    if (!row) return notFound(reply);
    const igdbId = Number(req.body?.igdbId);
    if (!igdbId) return reply.code(400).send({ error: 'igdbId is required' });
    try { await matchGame(row.id, igdbId); } catch (err) { return reply.code(502).send({ error: err.message }); }
    return rowToGame(getRow(row.id), { full: true });
  });

  // ---- Files & downloads (used by the PS5 client) -------------------------
  app.get('/games/:id/files', async (req, reply) => {
    const row = getRow(req.params.id);
    if (!row) return notFound(reply);
    const files = await gameFiles(row);
    return {
      id: row.id,
      kind: row.kind,
      titleId: row.title_id,
      contentId: row.content_id,
      version: row.version,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      files: files.map((f) => ({ ...f, url: `/api/v1/games/${row.id}/files/${f.path.split('/').map(encodeURIComponent).join('/')}` }))
    };
  });

  app.get('/games/:id/files/*', async (req, reply) => {
    const row = getRow(req.params.id);
    if (!row) return notFound(reply);
    const root = gameRoot(row);
    let file;
    if (row.kind === 'ps4-pkg' || row.kind === 'ps5-exfat') {
      // Only the files recorded for this game can be downloaded.
      const entry = JSON.parse(row.pkgs || '[]').find((p) => p.path === req.params['*']);
      file = entry ? (entry.file || path.resolve(root, entry.path)) : null;
      if (file && !fs.existsSync(file)) file = null;
    } else {
      file = await resolveInside(root, req.params['*']);
    }
    if (!file) return notFound(reply, 'File');
    return sendFileWithRange(req, reply, file);
  });

  // ---- Libraries -----------------------------------------------------------
  app.get('/libraries', async () => {
    return db.prepare(`SELECT l.*, (SELECT COUNT(*) FROM games g WHERE g.library_id = l.id AND g.missing = 0) AS games
      FROM libraries l ORDER BY l.id`).all().map((l) => ({
      id: l.id, path: l.path, platform: l.platform, enabled: !!l.enabled, fromEnv: !!l.from_env, lastScan: l.last_scan, games: l.games
    }));
  });

  app.post('/libraries', async (req, reply) => {
    const p = String(req.body?.path || '').trim();
    const platform = String(req.body?.platform || 'AUTO').toUpperCase();
    if (!p) return reply.code(400).send({ error: 'path is required' });
    const resolved = path.resolve(p);
    try {
      if (!(await fsp.stat(resolved)).isDirectory()) throw new Error();
    } catch {
      return reply.code(400).send({ error: `Folder not found inside the container: ${resolved}. Mount it in docker-compose first.` });
    }
    db.prepare('INSERT INTO libraries (path, platform) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET platform = excluded.platform')
      .run(resolved, ['PS4', 'PS5'].includes(platform) ? platform : 'AUTO');
    return db.prepare('SELECT * FROM libraries WHERE path = ?').get(resolved);
  });

  app.patch('/libraries/:id', async (req, reply) => {
    const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(req.params.id));
    if (!lib) return notFound(reply, 'Library');
    if (typeof req.body?.enabled === 'boolean') db.prepare('UPDATE libraries SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, lib.id);
    if (req.body?.platform) db.prepare('UPDATE libraries SET platform = ? WHERE id = ?').run(String(req.body.platform).toUpperCase(), lib.id);
    return db.prepare('SELECT * FROM libraries WHERE id = ?').get(lib.id);
  });

  app.delete('/libraries/:id', async (req, reply) => {
    const lib = db.prepare('SELECT * FROM libraries WHERE id = ?').get(Number(req.params.id));
    if (!lib) return notFound(reply, 'Library');
    if (lib.from_env) return reply.code(400).send({ error: 'This folder comes from GV_LIBRARIES in docker-compose; remove it there.' });
    db.prepare('DELETE FROM libraries WHERE id = ?').run(lib.id);
    return { ok: true };
  });

  // ---- Scanning & review ---------------------------------------------------
  app.get('/scan', async () => scanState);

  app.post('/scan', async (req, reply) => {
    const started = runScan({ libraryId: req.body?.libraryId || null, rescrapeAll: !!req.body?.rescrapeAll });
    if (!started) return reply.code(409).send({ error: 'A scan is already running', scan: scanState });
    return scanState;
  });

  app.get('/review', async () => {
    return db.prepare("SELECT * FROM games WHERE missing = 0 AND match_status IN ('review', 'unmatched') ORDER BY local_title")
      .all().map((r) => ({ ...rowToGame(r, { full: true }), folder: path.basename(r.path) }))
      .filter((g) => !g.isApp);
  });

  app.post('/maintenance/purge-missing', async () => ({ removed: await purgeMissing() }));

  // ---- Settings ------------------------------------------------------------
  app.get('/settings', async () => ({
    igdbClientId: getSetting('igdb_client_id') || config.igdbClientId,
    igdbSecretSet: !!(getSetting('igdb_client_secret') || config.igdbClientSecret),
    scraperConfigured: scraperConfigured(),
    scanIntervalHours: Number(getSetting('scan_interval_hours', String(config.scanIntervalHours))),
    port: config.port,
    version: config.version,
    missingCount: db.prepare('SELECT COUNT(*) AS n FROM games WHERE missing = 1').get().n,
    garlicEnabled: garlicEnabled(),
    garlicStatus: garlicStatus(),
    garlicStats: lookupStats()
  }));

  app.put('/settings', async (req) => {
    const b = req.body || {};
    if (typeof b.garlicEnabled === 'boolean') setGarlicEnabled(b.garlicEnabled);
    if (typeof b.igdbClientId === 'string') setSetting('igdb_client_id', b.igdbClientId.trim());
    if (typeof b.igdbClientSecret === 'string' && b.igdbClientSecret.trim()) setSetting('igdb_client_secret', b.igdbClientSecret.trim());
    if (b.scanIntervalHours != null && !Number.isNaN(Number(b.scanIntervalHours))) {
      setSetting('scan_interval_hours', Math.max(0, Number(b.scanIntervalHours)));
      scheduleScans();
    }
    resetToken();
    return { ok: true, scraperConfigured: scraperConfigured() };
  });
}
