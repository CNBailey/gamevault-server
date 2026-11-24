import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(path.join(config.dataDir, 'gamevault.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS libraries (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL DEFAULT 'AUTO',
  enabled INTEGER NOT NULL DEFAULT 1,
  from_env INTEGER NOT NULL DEFAULT 0,
  last_scan TEXT
);

CREATE TABLE IF NOT EXISTS games (
  id INTEGER PRIMARY KEY,
  library_id INTEGER REFERENCES libraries(id) ON DELETE CASCADE,
  path TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,            -- ps5-folder | ps4-folder | ps4-pkg
  platform TEXT NOT NULL,        -- PS4 | PS5
  title_id TEXT,
  content_id TEXT,
  version TEXT,
  category TEXT,
  local_title TEXT,
  pkgs TEXT,                     -- JSON: [{path,size,category,version}] for PKG games
  size_bytes INTEGER,
  file_count INTEGER,
  added_at TEXT NOT NULL,
  modified_at TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  favourite INTEGER NOT NULL DEFAULT 0,
  local_icon TEXT,
  local_backdrop TEXT,

  igdb_id INTEGER,
  title TEXT,
  release_date TEXT,
  year INTEGER,
  summary TEXT,
  genres TEXT,                   -- JSON array
  developer TEXT,
  publisher TEXT,
  modes TEXT,                    -- JSON array
  critic_score REAL,
  user_score REAL,
  cover TEXT,
  backdrop TEXT,
  screenshots TEXT,              -- JSON array of media urls
  videos TEXT,                   -- JSON array [{id,name}] (YouTube ids)
  match_status TEXT NOT NULL DEFAULT 'pending',  -- pending | matched | review | unmatched | manual
  match_score REAL,
  scraped_at TEXT,
  scrape_error TEXT
);

CREATE INDEX IF NOT EXISTS games_platform ON games(platform);
CREATE INDEX IF NOT EXISTS games_status ON games(match_status);

CREATE TABLE IF NOT EXISTS conversions (
  id INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,          -- PS4 | PS5
  source TEXT NOT NULL,            -- full path in the incoming folder
  source_name TEXT NOT NULL,
  fingerprint TEXT,                -- size/mtime of the source when queued
  status TEXT NOT NULL,            -- queued | running | done | failed
  action TEXT,                     -- rename | convert | publish
  stage TEXT,
  progress REAL,
  message TEXT,
  output TEXT,                     -- library file written
  title_id TEXT,
  title TEXT,
  version TEXT,
  size_bytes INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS conversions_status ON conversions(status);

-- Manual matches, remembered by PlayStation title ID (CUSA…/PPSA…).
CREATE TABLE IF NOT EXISTS title_matches (
  title_id TEXT PRIMARY KEY,
  igdb_id INTEGER NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// Columns added after the first release.
{
  const have = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  if (!have.has('required_fw')) db.exec('ALTER TABLE games ADD COLUMN required_fw TEXT');
}

// Matches you made by hand before this table existed.
db.exec(`INSERT OR IGNORE INTO title_matches (title_id, igdb_id, updated_at)
  SELECT title_id, igdb_id, datetime('now') FROM games
  WHERE match_status = 'manual' AND title_id IS NOT NULL AND igdb_id IS NOT NULL`);

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

const JSON_COLS = ['genres', 'modes', 'screenshots', 'videos', 'pkgs'];

/**
 * Homebrew apps rather than games: a title ID outside the normal CUSA/PPSA ranges
 * (homebrew uses PPSA99xxx / CUSA99xxx or its own prefixes), or a PS5 title whose
 * param.json marks it as an application rather than a game.
 */
export function isAppRow(row) {
  const id = String(row.title_id || '').toUpperCase();
  if (id && (!/^(CUSA|PPSA)\d{5}$/.test(id) || /^(CUSA|PPSA)99\d{3}$/.test(id))) return true;
  if (row.platform === 'PS5' && row.kind !== 'ps4-pkg' && row.category != null && row.category !== '' && row.category !== '0') return true;
  return false;
}

/** Turns a games row into the shape the API returns. */
export function rowToGame(row, { full = false } = {}) {
  if (!row) return null;
  const parsed = {};
  for (const c of JSON_COLS) {
    try { parsed[c] = row[c] ? JSON.parse(row[c]) : []; } catch { parsed[c] = []; }
  }
  const cover = row.cover || row.local_icon || null;
  const isApp = isAppRow(row);
  const game = {
    id: row.id,
    title: row.title || row.local_title || path.basename(row.path),
    platform: row.platform,
    year: row.year,
    genres: parsed.genres,
    criticScore: row.critic_score != null ? Math.round(row.critic_score) : null,
    userScore: row.user_score != null ? Math.round(row.user_score) : null,
    favourite: !!row.favourite,
    cover,
    sizeBytes: row.size_bytes,
    addedAt: row.added_at,
    titleId: row.title_id,
    contentId: row.content_id,
    version: row.version,
    requiredFirmware: row.required_fw || null,
    releaseDate: row.release_date,
    matchStatus: isApp ? 'app' : row.match_status,
    isApp,
    missing: !!row.missing
  };
  if (!full) return game;
  return {
    ...game,
    localTitle: row.local_title,
    kind: row.kind,
    path: row.path,
    category: row.category,
    fileCount: row.file_count,
    modifiedAt: row.modified_at,
    releaseDate: row.release_date,
    summary: row.summary,
    developer: row.developer,
    publisher: row.publisher,
    modes: parsed.modes,
    backdrop: row.backdrop || row.local_backdrop || null,
    screenshots: parsed.screenshots,
    videos: parsed.videos,
    pkgs: parsed.pkgs,
    igdbId: row.igdb_id,
    matchScore: row.match_score,
    scrapedAt: row.scraped_at,
    scrapeError: row.scrape_error
  };
}
