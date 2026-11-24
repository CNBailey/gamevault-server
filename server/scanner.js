import fs from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { readPkg } from './parsers/pkg.js';
import { readPs4Folder, readPs5Exfat, readPs5Folder } from './parsers/ps5.js';
import { readExfatGame } from './parsers/exfat.js';
import { compareFirmware } from './parsers/sfo.js';
import { isIgnored, walkFiles } from './files.js';
import { copyInto, saveBuffer, removeGameMedia } from './media.js';

export const scanState = {
  running: false,
  phase: 'idle',          // idle | scanning | scraping
  library: null,
  current: null,
  done: 0,
  total: 0,
  added: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  orphanPatches: []
};

const nowIso = () => new Date().toISOString();

async function isDir(p) {
  try { return (await fs.stat(p)).isDirectory(); } catch { return false; }
}

async function hasFile(p) {
  try { return (await fs.stat(p)).isFile(); } catch { return false; }
}

async function pkgFilesIn(dir, depth = 0) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith('.pkg')) out.push(full);
    else if (e.isDirectory() && depth < 2) out.push(...(await pkgFilesIn(full, depth + 1)));
  }
  return out;
}

/**
 * Finds game candidates under a library root. A candidate is either:
 *  - a folder with sce_sys/param.json (PS5 dump) or sce_sys/param.sfo (PS4 folder dump)
 *  - a folder holding .pkg files (base game + updates + DLC), or a loose .pkg file
 * Folders that are none of these are searched up to 3 levels deep (for genre sub-folders etc.).
 */
async function findCandidates(root, depth = 0) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (err) {
    throw new Error(`Cannot read ${root}: ${err.code || err.message}`);
  }
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full = path.join(root, e.name);
    const lower = e.name.toLowerCase();
    if (e.isFile() && lower.endsWith('.pkg')) {
      out.push({ type: 'pkgfile', path: full });
    } else if (e.isFile() && lower.endsWith('.exfat')) {
      out.push({ type: 'exfat', path: full });
    } else if (e.isDirectory()) {
      if (await hasFile(path.join(full, 'sce_sys', 'param.json')) || await hasFile(path.join(full, 'sce_sys', 'param.sfo'))) {
        out.push({ type: 'folder', path: full });
        continue;
      }
      const direct = (await fs.readdir(full).catch(() => [])).filter((n) => n.toLowerCase().endsWith('.pkg'));
      if (direct.length) {
        out.push({ type: 'pkgdir', path: full });
      } else if (depth < 3) {
        out.push(...(await findCandidates(full, depth + 1)));
      }
    }
  }
  return out;
}

/** "Astro_Bot [PPSA01325] v1.02" -> "Astro Bot" */
export function cleanName(name) {
  return name
    .replace(/\.(pkg|exfat)$/i, '')
    .replace(/[[(][^\])]*[\])]/g, ' ')
    .replace(/\b(CUSA|PPSA)\d{5}\b/gi, ' ')
    .replace(/\b[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_\d{2}-[A-Z0-9]{16}\b/g, ' ')
    .replace(/\bv?\d+\.\d+(\.\d+)?\b/gi, ' ')
    .replace(/\b(update|patch|backport|fake|dlc|ps4|ps5|base|game)\b/gi, ' ')
    .replace(/[_.]+/g, ' ')
    .replace(/^[\s\-_]+|[\s\-_]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function inspect(candidate, libraryPlatform) {
  if (candidate.type === 'exfat') {
    const st = await fs.stat(candidate.path);
    const meta = await readPs5Exfat(candidate.path, readExfatGame);
    const name = path.basename(candidate.path);
    return {
      ...meta,
      title: meta.title || cleanName(name),
      sizeBytes: st.size,
      fileCount: 1,
      modifiedAt: st.mtime.toISOString(),
      pkgs: [{ path: name, file: candidate.path, size: st.size, category: 'image', version: meta.version }]
    };
  }
  if (candidate.type === 'folder') {
    const meta = (await readPs5Folder(candidate.path)) || (await readPs4Folder(candidate.path));
    const files = await walkFiles(candidate.path);
    return {
      ...meta,
      platform: meta.platform,
      title: meta.title || cleanName(path.basename(candidate.path)),
      sizeBytes: files.reduce((n, f) => n + f.size, 0),
      fileCount: files.length,
      modifiedAt: files.length ? new Date(Math.max(...files.map((f) => f.mtimeMs))).toISOString() : null,
      pkgs: []
    };
  }

  const pkgPaths = candidate.type === 'pkgfile' ? [candidate.path] : await pkgFilesIn(candidate.path);
  const pkgs = [];
  for (const p of pkgPaths) {
    const st = await fs.stat(p);
    let info = {};
    try { info = await readPkg(p); } catch (err) { info = { error: err.message }; }
    pkgs.push({ file: p, size: st.size, mtimeMs: st.mtimeMs, ...info });
  }
  // Base game first: category "gd", else the largest file.
  pkgs.sort((a, b) => (b.category === 'gd') - (a.category === 'gd') || b.size - a.size);
  const base = pkgs[0] || {};
  let images = {};
  if (base.file && !base.error) {
    try { images = await readPkg(base.file, { images: true }); } catch { /* images are optional */ }
  }
  const root = candidate.path;
  return {
    platform: libraryPlatform === 'PS5' ? 'PS5' : 'PS4',
    kind: 'ps4-pkg',
    titleId: base.titleId || null,
    contentId: base.contentId || null,
    version: pkgs.filter((p) => p.category === 'gp').map((p) => p.version).sort().pop() || base.version || null,
    category: base.category || null,
    title: base.title || cleanName(path.basename(root)),
    requiredFw: pkgs.map((p) => p.requiredFw).filter(Boolean).sort(compareFirmware).pop() || null,
    iconBuf: images.icon0 || null,
    backdropBuf: images.pic1 || null,
    sizeBytes: pkgs.reduce((n, p) => n + p.size, 0),
    fileCount: pkgs.length,
    modifiedAt: pkgs.length ? new Date(Math.max(...pkgs.map((p) => p.mtimeMs))).toISOString() : null,
    pkgs: pkgs.map((p) => ({
      path: candidate.type === 'pkgfile' ? path.basename(p.file) : path.relative(root, p.file).split(path.sep).join('/'),
      file: p.file,
      size: p.size,
      category: p.category || null,
      version: p.version || null,
      contentId: p.contentId || null,
      requiredFw: p.requiredFw || null
    }))
  };
}

const findByPath = db.prepare('SELECT id, local_icon, local_backdrop FROM games WHERE path = ?');
const insertGame = db.prepare(`INSERT INTO games
  (library_id, path, kind, platform, title_id, content_id, version, category, local_title, pkgs, size_bytes, file_count, added_at, modified_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const updateGame = db.prepare(`UPDATE games SET
  library_id = ?, kind = ?, platform = ?, title_id = ?, content_id = ?, version = ?, category = ?, local_title = ?, pkgs = ?,
  size_bytes = ?, file_count = ?, modified_at = ?, missing = 0 WHERE id = ?`);
const setFirmware = db.prepare('UPDATE games SET required_fw = ? WHERE id = ?');

async function upsert(lib, candidatePath, info) {
  const existing = findByPath.get(candidatePath);
  const values = [info.titleId, info.contentId, info.version, info.category, info.title, JSON.stringify(info.pkgs)];
  let id;
  if (existing) {
    id = existing.id;
    updateGame.run(lib.id, info.kind, info.platform, ...values, info.sizeBytes, info.fileCount, info.modifiedAt, id);
  } else {
    id = Number(insertGame.run(lib.id, candidatePath, info.kind, info.platform, ...values, info.sizeBytes, info.fileCount, nowIso(), info.modifiedAt).lastInsertRowid);
    scanState.added++;
  }
  setFirmware.run(info.requiredFw || null, id);
  if (!existing || !existing.local_icon) {
    const icon = info.iconBuf ? await saveBuffer(id, 'local-icon.png', info.iconBuf) : await copyInto(id, 'local-icon.png', info.icon);
    if (icon) db.prepare('UPDATE games SET local_icon = ? WHERE id = ?').run(icon, id);
  }
  if (!existing || !existing.local_backdrop) {
    const bd = info.backdropBuf ? await saveBuffer(id, 'local-backdrop.png', info.backdropBuf) : await copyInto(id, 'local-backdrop.png', info.backdrop);
    if (bd) db.prepare('UPDATE games SET local_backdrop = ? WHERE id = ?').run(bd, id);
  }
  return id;
}

const stem = (p) => path.basename(p).replace(/\.(pkg|exfat)$/i, '').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[™®©]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');

/** PS4 updates: a name ending in "patch", or PKGs that are all updates (category "gp"). */
export function isPatch(candidatePath, info) {
  if (info.kind !== 'ps4-pkg') return false;
  if (/patch$/i.test(stem(candidatePath))) return true;
  return info.pkgs.length > 0 && info.pkgs.every((p) => p.category === 'gp');
}

function matchKeys(candidatePath, info) {
  return new Set([norm(cleanName(path.basename(candidatePath))), norm(cleanName(info.title || ''))].filter(Boolean));
}

/** Attaches a patch's PKGs to its game: same title ID, else the same cleaned-up name. */
function attachPatch(patch, games) {
  const keys = matchKeys(patch.path, patch.info);
  const target = (patch.info.titleId && games.find((g) => g.info.titleId === patch.info.titleId)) ||
    games.find((g) => [...matchKeys(g.path, g.info)].some((k) => keys.has(k)));
  if (!target) return false;
  const info = target.info;
  const taken = new Set(info.pkgs.map((p) => p.path));
  for (const p of patch.info.pkgs) {
    let name = path.basename(p.file);
    if (taken.has(name)) name = `updates/${name}`;
    taken.add(name);
    info.pkgs.push({ ...p, path: name, category: p.category === 'ac' ? 'ac' : 'gp' });
  }
  info.sizeBytes += patch.info.sizeBytes;
  info.fileCount += patch.info.fileCount;
  if (patch.info.modifiedAt && (!info.modifiedAt || patch.info.modifiedAt > info.modifiedAt)) info.modifiedAt = patch.info.modifiedAt;
  const latest = info.pkgs.filter((p) => p.category === 'gp').map((p) => p.version).filter(Boolean).sort().pop();
  if (latest) info.version = latest;
  return true;
}

export async function scanLibrary(lib) {
  scanState.library = lib.path;
  if (!(await isDir(lib.path))) throw new Error(`Library folder not found: ${lib.path}`);
  const candidates = await findCandidates(lib.path);
  scanState.total += candidates.length;

  const inspected = [];
  for (const c of candidates) {
    scanState.current = path.relative(lib.path, c.path) || path.basename(c.path);
    try {
      const info = await inspect(c, lib.platform);
      if (lib.platform === 'PS4' || lib.platform === 'PS5') info.platform = lib.platform;
      inspected.push({ path: c.path, info });
    } catch (err) {
      console.warn(`[scan] skipped ${c.path}: ${err.message}`);
    }
    scanState.done++;
  }

  const games = inspected.filter((x) => !isPatch(x.path, x.info));
  const patches = inspected.filter((x) => isPatch(x.path, x.info));
  for (const p of patches) {
    if (!attachPatch(p, games)) scanState.orphanPatches.push(path.relative(lib.path, p.path));
    // Patches scanned as games by an earlier version are removed from the list.
    const old = findByPath.get(p.path);
    if (old) {
      await removeGameMedia(old.id);
      db.prepare('DELETE FROM games WHERE id = ?').run(old.id);
    }
  }

  const seen = new Set();
  for (const g of games) {
    try {
      await upsert(lib, g.path, g.info);
      seen.add(g.path);
    } catch (err) {
      console.warn(`[scan] could not save ${g.path}: ${err.message}`);
    }
  }
  // Games that disappeared from disk are flagged, not deleted, so favourites survive a NAS hiccup.
  const rows = db.prepare('SELECT id, path FROM games WHERE library_id = ?').all(lib.id);
  for (const r of rows) {
    if (!seen.has(r.path)) db.prepare('UPDATE games SET missing = 1 WHERE id = ?').run(r.id);
  }
  db.prepare('UPDATE libraries SET last_scan = ? WHERE id = ?').run(nowIso(), lib.id);
}

/** Permanently drops games flagged missing (Settings → "Clean up missing"). */
export async function purgeMissing() {
  const rows = db.prepare('SELECT id FROM games WHERE missing = 1').all();
  for (const r of rows) {
    await removeGameMedia(r.id);
    db.prepare('DELETE FROM games WHERE id = ?').run(r.id);
  }
  return rows.length;
}
