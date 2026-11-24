import { config } from './config.js';
import { db, getSetting } from './db.js';
import { clearScraped, download } from './media.js';
import { scanState } from './scanner.js';

// IGDB platform ids
const PLATFORM_IDS = { PS4: 48, PS5: 167 };
const IMG = (size, id) => `https://images.igdb.com/igdb/image/upload/t_${size}/${id}.jpg`;
const FIELDS = [
  'name', 'first_release_date', 'summary', 'genres.name', 'themes.name', 'game_modes.name', 'platforms',
  'cover.image_id', 'screenshots.image_id', 'artworks.image_id', 'videos.video_id', 'videos.name',
  'aggregated_rating', 'rating', 'involved_companies.company.name', 'involved_companies.developer', 'involved_companies.publisher'
].join(',');

const GENRE_NAMES = {
  'Role-playing (RPG)': 'RPG',
  Platform: 'Platformer',
  'Hack and slash/Beat \'em up': 'Hack & slash',
  'Real Time Strategy (RTS)': 'Strategy',
  'Turn-based strategy (TBS)': 'Strategy',
  Sport: 'Sports',
  'Point-and-click': 'Adventure',
  'Card & Board Game': 'Card & board',
  "Quiz/Trivia": 'Quiz'
};

function credentials() {
  return {
    clientId: getSetting('igdb_client_id') || config.igdbClientId,
    clientSecret: getSetting('igdb_client_secret') || config.igdbClientSecret
  };
}

export function scraperConfigured() {
  const c = credentials();
  return !!(c.clientId && c.clientSecret);
}

let token = null;
let tokenExpires = 0;
let lastCall = 0;

async function getToken() {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) throw new Error('IGDB credentials are not set (Settings → Metadata).');
  if (token && Date.now() < tokenExpires - 60000) return token;
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', body, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Twitch login failed (${res.status}). Check the IGDB client ID and secret.`);
  const json = await res.json();
  token = json.access_token;
  tokenExpires = Date.now() + json.expires_in * 1000;
  return token;
}

export function resetToken() {
  token = null;
  tokenExpires = 0;
}

async function igdb(endpoint, query) {
  // IGDB allows 4 requests per second.
  const wait = lastCall + 300 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(`https://api.igdb.com/v4/${endpoint}`, {
    method: 'POST',
    headers: { 'Client-ID': credentials().clientId, Authorization: `Bearer ${await getToken()}`, 'Content-Type': 'text/plain' },
    body: query,
    signal: AbortSignal.timeout(20000)
  });
  if (res.status === 401) resetToken();
  if (!res.ok) throw new Error(`IGDB request failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const esc = (s) => String(s).replace(/\\/g, ' ').replace(/"/g, ' ');

function normalise(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\b(the|a|an|edition|remastered|complete|definitive|goty|game of the year|deluxe|digital|standard|director's cut|directors cut)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bigrams(s) {
  const t = normalise(s).replace(/ /g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const g = t.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

/** Sørensen–Dice similarity on character bigrams, 0..1 */
export function similarity(a, b) {
  if (normalise(a) === normalise(b)) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of x) { total += n; overlap += Math.min(n, y.get(g) || 0); }
  for (const n of y.values()) total += n;
  return total ? (2 * overlap) / total : 0;
}

/**
 * Turns a dump title into something IGDB's search understands:
 * "Borderlands®4" -> "Borderlands 4", "WATCH_DOGS® 2" -> "WATCH DOGS 2",
 * "Aliens: Fireteam Elite (PS5)" -> "Aliens: Fireteam Elite", "[PROTOTYPE® BIOHAZARD BUNDLE]" -> "PROTOTYPE BIOHAZARD BUNDLE".
 */
export function searchTitle(title) {
  return String(title || '')
    .replace(/[®™©℠]/g, ' ')
    .normalize('NFKC')
    .replace(/[([{]\s*(?:PS4|PS5|PSVR2?|PS VR2?|PlayStation\s*[45])\s*[)\]}]/gi, ' ')
    .replace(/\b(?:PS4|PS5)\s*(?:version|edition)?\s*$/i, ' ')
    .replace(/[[\]{}]/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+([:,])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const EDITION_WORDS = /\b(?:classic|complete|definitive|deluxe|gold|ultimate|premium|enhanced|anniversary|game of the year|goty|standard|digital|remastered|remaster|bundle|edition|collection|director'?s cut|cross-gen|ps4 & ps5)\b/gi;

/** Search texts to try, most specific first. */
export function searchVariants(title) {
  const base = searchTitle(title);
  const out = [base];
  const noEdition = base.replace(EDITION_WORDS, ' ').replace(/\s*[-–:]\s*$/, '').replace(/\s{2,}/g, ' ').trim();
  const noSubtitle = base.split(/\s*[:–]\s+|\s+-\s+/)[0].trim();
  for (const v of [noEdition, noSubtitle]) if (v && v.length >= 3 && !out.includes(v)) out.push(v);
  return out;
}

export async function searchIgdb(title, platform) {
  const pid = PLATFORM_IDS[platform];
  const variants = searchVariants(title);
  const byId = new Map();
  const score = (g) => {
    const onPlatform = (g.platforms || []).includes(pid);
    const sim = Math.max(...variants.map((v) => similarity(v, g.name)));
    return Math.min(1, sim + (onPlatform ? 0.05 : -0.1));
  };
  const add = (rows) => rows.forEach((g) => byId.set(g.id, { ...g, score: score(g) }));

  for (const v of variants) {
    const q = esc(v).slice(0, 120);
    add(await igdb('games', `search "${q}"; fields ${FIELDS}; where platforms = (${pid}); limit 10;`));
    if ([...byId.values()].some((g) => g.score >= 0.85)) break;
  }
  if (!byId.size) add(await igdb('games', `search "${esc(variants[0]).slice(0, 120)}"; fields ${FIELDS}; limit 10;`));
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

/**
 * Exact match by PlayStation title ID (CUSA12345 / PPSA12345): IGDB's links to the
 * PlayStation Store usually carry the product ID, which contains the title ID.
 * Returns null when IGDB has no such link, or the ID points at several games.
 */
export async function findByTitleId(titleId, localTitle) {
  const tid = String(titleId || '').toUpperCase();
  if (!/^(CUSA|PPSA)\d{5}$/.test(tid)) return null;
  let rows;
  try {
    rows = await igdb('external_games', `fields game,uid,url; where uid ~ *"${tid}"* | url ~ *"${tid}"*; limit 20;`);
  } catch (err) {
    console.warn(`[scrape] title ID lookup for ${tid} failed: ${err.message}`);
    return null;
  }
  const ids = [...new Set(rows.map((r) => (r.game && typeof r.game === 'object' ? r.game.id : r.game)).filter(Boolean))];
  if (!ids.length) return null;
  const games = await igdb('games', `fields ${FIELDS}; where id = (${ids.slice(0, 10).join(',')}); limit 10;`);
  if (games.length === 1) return games[0];
  // Several games share the ID (e.g. a bundle): keep the one whose name fits best.
  const ranked = games.map((g) => ({ g, s: Math.max(...searchVariants(localTitle).map((v) => similarity(v, g.name))) })).sort((a, b) => b.s - a.s);
  return ranked[0] && ranked[0].s >= 0.5 ? ranked[0].g : null;
}

/**
 * Diagnostics: shows IGDB's raw answers for a title ID and for one matched game's store
 * links, so the title-ID lookup can be checked against real data.
 */
export async function titleIdDiagnostics(titleId, igdbId) {
  const out = { titleId, igdbId };
  const run = async (key, endpoint, q) => {
    try { out[key] = { query: q, result: await igdb(endpoint, q) }; } catch (err) { out[key] = { query: q, error: err.message }; }
  };
  const tid = String(titleId || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (tid) {
    await run('lookupUsedByGameVault', 'external_games', `fields game,uid,url; where uid ~ *"${tid}"* | url ~ *"${tid}"*; limit 20;`);
    await run('uidOnly', 'external_games', `fields game,uid,url; where uid ~ *"${tid}"*; limit 20;`);
    await run('urlOnly', 'external_games', `fields game,uid,url; where url ~ *"${tid}"*; limit 20;`);
  }
  if (igdbId) await run('storeLinksForMatchedGame', 'external_games', `fields *; where game = ${Number(igdbId)}; limit 50;`);
  return out;
}

export async function getIgdbGame(igdbId) {
  const rows = await igdb('games', `fields ${FIELDS}; where id = ${Number(igdbId)};`);
  return rows[0] || null;
}

export function candidateSummary(g) {
  return {
    igdbId: g.id,
    name: g.name,
    year: g.first_release_date ? new Date(g.first_release_date * 1000).getUTCFullYear() : null,
    cover: g.cover ? IMG('cover_small', g.cover.image_id) : null,
    score: g.score != null ? Math.round(g.score * 100) : null
  };
}

async function applyIgdb(gameId, g, status, score) {
  await clearScraped(gameId);
  const companies = g.involved_companies || [];
  const dev = companies.filter((c) => c.developer).map((c) => c.company?.name).filter(Boolean);
  const pub = companies.filter((c) => c.publisher).map((c) => c.company?.name).filter(Boolean);
  const genres = [...new Set([
    ...((g.themes || []).some((t) => t.name === 'Action') ? ['Action'] : []),
    ...(g.genres || []).map((x) => GENRE_NAMES[x.name] || x.name)
  ])];

  let cover = null;
  let backdrop = null;
  const shots = [];
  try {
    if (g.cover) cover = await download(gameId, 'cover.jpg', IMG('cover_big_2x', g.cover.image_id));
    const bd = (g.artworks && g.artworks[0]) || (g.screenshots && g.screenshots[0]);
    if (bd) backdrop = await download(gameId, 'backdrop.jpg', IMG('1080p', bd.image_id));
    for (const [i, s] of (g.screenshots || []).slice(0, 6).entries()) {
      shots.push(await download(gameId, `shot-${i + 1}.jpg`, IMG('screenshot_huge', s.image_id)));
    }
  } catch (err) {
    console.warn(`[scrape] image download problem for game ${gameId}: ${err.message}`);
  }

  const released = g.first_release_date ? new Date(g.first_release_date * 1000) : null;
  db.prepare(`UPDATE games SET
    igdb_id = ?, title = ?, release_date = ?, year = ?, summary = ?, genres = ?, developer = ?, publisher = ?, modes = ?,
    critic_score = ?, user_score = ?, cover = ?, backdrop = ?, screenshots = ?, videos = ?,
    match_status = ?, match_score = ?, scraped_at = ?, scrape_error = NULL
    WHERE id = ?`).run(
    g.id, g.name, released ? released.toISOString().slice(0, 10) : null, released ? released.getUTCFullYear() : null,
    g.summary || null, JSON.stringify(genres), dev.join(', ') || null, pub.join(', ') || null,
    JSON.stringify((g.game_modes || []).map((m) => m.name)),
    g.aggregated_rating ?? null, g.rating ?? null, cover, backdrop, JSON.stringify(shots.filter(Boolean)),
    JSON.stringify((g.videos || []).slice(0, 5).map((v) => ({ id: v.video_id, name: v.name || 'Trailer' }))),
    status, score, new Date().toISOString(), gameId
  );
}

/** Automatic match: >= 0.85 matched, >= 0.55 kept but flagged for review, else unmatched. */
export async function scrapeGame(gameId) {
  const row = db.prepare('SELECT id, local_title, platform, path, title_id FROM games WHERE id = ?').get(gameId);
  if (!row) return;
  const title = row.local_title || row.path.split(/[\\/]/).pop();
  try {
    const exact = await findByTitleId(row.title_id, title);
    if (exact) {
      await applyIgdb(gameId, exact, 'matched_id', 1);
      return;
    }
    const results = await searchIgdb(title, row.platform);
    const best = results[0];
    if (!best || best.score < 0.55) {
      db.prepare("UPDATE games SET match_status = 'unmatched', match_score = ?, scraped_at = ?, scrape_error = NULL WHERE id = ?")
        .run(best ? best.score : 0, new Date().toISOString(), gameId);
      return;
    }
    await applyIgdb(gameId, best, best.score >= 0.85 ? 'matched' : 'review', best.score);
  } catch (err) {
    db.prepare('UPDATE games SET scrape_error = ? WHERE id = ?').run(err.message, gameId);
    throw err;
  }
}

/** Manual match chosen by the user. */
export async function matchGame(gameId, igdbId) {
  const g = await getIgdbGame(igdbId);
  if (!g) throw new Error('IGDB game not found');
  await applyIgdb(gameId, g, 'manual', 1);
}

export async function scrapePending({ all = false } = {}) {
  if (!scraperConfigured()) return;
  const rows = all
    ? db.prepare('SELECT id FROM games WHERE missing = 0').all()
    : db.prepare("SELECT id FROM games WHERE missing = 0 AND (match_status IN ('pending', 'unmatched') OR scrape_error IS NOT NULL)").all();
  scanState.phase = 'scraping';
  scanState.done = 0;
  scanState.total = rows.length;
  for (const r of rows) {
    const g = db.prepare('SELECT local_title FROM games WHERE id = ?').get(r.id);
    scanState.current = g?.local_title || `game ${r.id}`;
    try {
      await scrapeGame(r.id);
    } catch (err) {
      console.warn(`[scrape] ${scanState.current}: ${err.message}`);
      if (/credentials|login failed/i.test(err.message)) { scanState.error = err.message; break; }
    }
    scanState.done++;
  }
}
