import { config } from './config.js';
import { db, getSetting, setSetting } from './db.js';

/**
 * PlayStation title ID lookups through GarlicSaves (https://garlicsaves.com/tools/title-lookup).
 * For CUSA…/PPSA… it returns the official name and the PlayStation Store concept number,
 * which IGDB also stores, so a game can be matched exactly.
 *
 * Polite use: each title ID is asked once and cached (a "not found" is asked again after
 * 30 days, a failed request after a day), at most one request per second, identified as GameVault.
 * It can be switched off in Settings.
 */

const ENDPOINT = 'https://garlicsaves.com/tools/api/title-search';
const NOT_FOUND_RETRY_DAYS = 30;
const ERROR_RETRY_HOURS = 24;

db.exec(`
CREATE TABLE IF NOT EXISTS title_lookups (
  title_id TEXT PRIMARY KEY,
  found INTEGER NOT NULL,
  name TEXT,
  concept_id TEXT,
  platform TEXT,
  region TEXT,
  error TEXT,
  fetched_at TEXT NOT NULL
);
`);

export const garlicEnabled = () => getSetting('garlicsaves_enabled', '1') === '1';
export const setGarlicEnabled = (on) => setSetting('garlicsaves_enabled', on ? '1' : '0');

export function garlicStatus() {
  try { return JSON.parse(getSetting('garlicsaves_status', 'null')); } catch { return null; }
}

function recordStatus(ok, message) {
  setSetting('garlicsaves_status', JSON.stringify({ ok, message, at: new Date().toISOString() }));
}

let lastCall = 0;

async function fetchTitle(titleId) {
  const wait = lastCall + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(`${ENDPOINT}?q=${encodeURIComponent(titleId)}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': `GameVault/${config.version} (self-hosted game catalogue; +https://github.com/CNBailey/gamevault-server)`
    },
    signal: AbortSignal.timeout(15000)
  });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('json')) {
    throw new Error(res.status === 403 || res.status === 503 || !type.includes('json')
      ? `GarlicSaves refused the request (HTTP ${res.status}); it may be blocking automated lookups.`
      : `GarlicSaves answered HTTP ${res.status}.`);
  }
  const body = await res.json();
  return Array.isArray(body.results) ? body.results : [];
}

/**
 * Looks a title ID up (cached). Returns { name, conceptId, platform, region } or null.
 * Never throws: a failure just means "no help from GarlicSaves this time".
 */
export async function lookupTitleId(titleId) {
  const tid = String(titleId || '').toUpperCase();
  if (!garlicEnabled() || !/^(CUSA|PPSA)\d{5}$/.test(tid)) return null;

  const cached = db.prepare('SELECT * FROM title_lookups WHERE title_id = ?').get(tid);
  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at).getTime();
    if (cached.found) return { name: cached.name, conceptId: cached.concept_id, platform: cached.platform, region: cached.region };
    if (!cached.error && age < NOT_FOUND_RETRY_DAYS * 86400000) return null;
    if (cached.error && age < ERROR_RETRY_HOURS * 3600000) return null;
  }

  const save = db.prepare(`INSERT INTO title_lookups (title_id, found, name, concept_id, platform, region, error, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(title_id) DO UPDATE SET found = excluded.found, name = excluded.name, concept_id = excluded.concept_id,
      platform = excluded.platform, region = excluded.region, error = excluded.error, fetched_at = excluded.fetched_at`);
  const now = new Date().toISOString();
  try {
    const results = await fetchTitle(tid);
    const hit = results.find((r) => String(r.title_id || '').toUpperCase() === tid);
    recordStatus(true, `Last lookup worked (${tid}).`);
    if (!hit) {
      save.run(tid, 0, null, null, null, null, null, now);
      return null;
    }
    const out = {
      name: hit.name ? String(hit.name) : null,
      conceptId: hit.concept_id != null ? String(hit.concept_id) : null,
      platform: hit.platform ? String(hit.platform).toUpperCase() : null,
      region: hit.region ? String(hit.region) : null
    };
    save.run(tid, 1, out.name, out.conceptId, out.platform, out.region, null, now);
    return out;
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'GarlicSaves did not answer in time.' : err.message;
    recordStatus(false, message);
    save.run(tid, 0, null, null, null, null, message, now);
    console.warn(`[garlicsaves] ${tid}: ${message}`);
    return null;
  }
}

export function lookupStats() {
  const r = db.prepare('SELECT COUNT(*) AS total, SUM(found) AS found, SUM(error IS NOT NULL) AS errors FROM title_lookups').get();
  return { total: r.total || 0, found: r.found || 0, errors: r.errors || 0 };
}
