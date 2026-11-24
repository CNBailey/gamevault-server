import fsp from 'node:fs/promises';
import path from 'node:path';
import { db } from '../db.js';
import { isIgnored } from '../files.js';
import { requestLibraryScan } from '../jobs.js';
import { readExfatGame } from '../parsers/exfat.js';
import { readPkg } from '../parsers/pkg.js';
import { exists } from './fsops.js';
import { libraryName, ps4Suffix } from './names.js';

/**
 * "Tidy file names": renames library files to the standard form, using the details stored
 * inside each file (never the old file name). Preview first; apply recomputes every name
 * on the server, so only files in a library folder can be renamed, and only to their
 * standard name in the same folder.
 */

async function listFiles(root, ext, depth = 0) {
  const out = [];
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full = path.join(root, e.name);
    if (e.isFile() && e.name.toLowerCase().endsWith(ext)) out.push(full);
    else if (e.isDirectory() && depth < 2) out.push(...(await listFiles(full, ext, depth + 1)));
  }
  return out;
}

async function standardName(file) {
  const lower = file.toLowerCase();
  if (lower.endsWith('.pkg')) {
    const info = await readPkg(file);
    if (!/^CUSA\d{5}$/.test(info.titleId || '')) return null;
    // A file you named "...patch" stays a patch, so the library keeps grouping it with its game.
    let suffix = ps4Suffix(info.category);
    if (!suffix && /patch$/i.test(path.basename(file).replace(/\.pkg$/i, '').trim())) suffix = ' patch';
    return libraryName({ titleId: info.titleId, title: info.title, version: info.version, suffix, ext: '.pkg', maxStemBytes: 150 });
  }
  if (lower.endsWith('.exfat')) {
    const g = await readExfatGame(file);
    const p = g?.param;
    if (!p || !/^PPSA\d{5}$/.test(p.titleId || '')) return null;
    const lp = p.localizedParameters || {};
    const title = (lp['en-US'] || lp['en-GB'] || lp[lp.defaultLanguage] || {}).titleName;
    return libraryName({ titleId: p.titleId, title, version: p.contentVersion, ext: '.exfat', maxStemBytes: 63 });
  }
  return null;
}

function libraries(platform) {
  return db.prepare('SELECT path FROM libraries WHERE enabled = 1 AND platform = ?').all(platform).map((l) => l.path);
}

const EXT = { PS4: '.pkg', PS5: '.exfat' };

export async function previewRenames(platform) {
  const items = [];
  for (const root of libraries(platform)) {
    for (const file of await listFiles(root, EXT[platform])) {
      let to;
      try { to = await standardName(file); } catch { to = null; }
      const from = path.basename(file);
      if (!to || to === from) continue;
      const target = path.join(path.dirname(file), to);
      items.push({
        path: file,
        folder: path.relative(root, path.dirname(file)) || '.',
        from,
        to,
        conflict: (await exists(target)) && target.toLowerCase() !== file.toLowerCase()
      });
    }
  }
  return items.sort((a, b) => a.to.localeCompare(b.to));
}

export async function applyRenames(platform, paths) {
  const roots = libraries(platform);
  const inside = (p) => roots.some((r) => p.startsWith(r + path.sep));
  const results = [];
  for (const file of paths) {
    const resolved = path.resolve(String(file));
    if (!inside(resolved) || !resolved.toLowerCase().endsWith(EXT[platform])) {
      results.push({ path: file, ok: false, error: 'Not a file in a library folder' });
      continue;
    }
    try {
      const to = await standardName(resolved);
      if (!to) throw new Error('No title ID found inside the file');
      const target = path.join(path.dirname(resolved), to);
      if (target === resolved) { results.push({ path: file, ok: true, to }); continue; }
      if ((await exists(target)) && target.toLowerCase() !== resolved.toLowerCase()) throw new Error(`${to} already exists`);
      await fsp.rename(resolved, target);
      // Loose files are stored by their own path: keep favourites and matches.
      db.prepare('UPDATE games SET path = ? WHERE path = ?').run(target, resolved);
      results.push({ path: file, ok: true, to });
    } catch (err) {
      results.push({ path: file, ok: false, error: err.message });
    }
  }
  requestLibraryScan(platform);
  return results;
}
