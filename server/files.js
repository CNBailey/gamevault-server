import fs from 'node:fs/promises';
import path from 'node:path';

/** Folders and files that NAS systems create and that are never part of a game. */
export const IGNORED = new Set(['@eaDir', '#recycle', '#snapshot', '.DS_Store', 'Thumbs.db', 'desktop.ini', '$RECYCLE.BIN', 'System Volume Information', '.gamevault']);

export function isIgnored(name) {
  return IGNORED.has(name) || name.startsWith('._') || name.startsWith('.');
}

/** Walks a folder and returns every file with its size and mtime, relative to the root. */
export async function walkFiles(root) {
  const files = [];
  async function visit(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const stats = [];
    for (const e of entries) {
      if (isIgnored(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await visit(full);
      } else if (e.isFile()) {
        stats.push(fs.stat(full).then((s) => files.push({ path: path.relative(root, full).split(path.sep).join('/'), size: s.size, mtimeMs: s.mtimeMs })).catch(() => {}));
        if (stats.length >= 64) { await Promise.all(stats); stats.length = 0; }
      }
    }
    await Promise.all(stats);
  }
  await visit(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

/**
 * Resolves a client-supplied relative path inside a game's folder, refusing anything
 * that would escape it (../, absolute paths, symlink tricks are handled by realpath).
 */
export async function resolveInside(root, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0')) return null;
  const target = path.resolve(root, rel);
  const realRoot = await fs.realpath(root);
  let realTarget;
  try { realTarget = await fs.realpath(target); } catch { return null; }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return realTarget;
}
