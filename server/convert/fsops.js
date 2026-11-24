import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

/**
 * Moves a file or folder. Within one filesystem this is an instant rename. Across
 * filesystems it copies to "<dest>.part", renames that into place, then removes the
 * source, so a half-copied file never carries the final name.
 * `onProgress(done, total)` is called while copying.
 */
export async function moveInto(src, dest, onProgress = () => {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (await exists(dest)) throw new Error(`${path.basename(dest)} already exists in ${path.dirname(dest)}`);
  try {
    await fsp.rename(src, dest);
    return 'renamed';
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
  }
  const st = await fsp.stat(src);
  if (st.isDirectory()) throw new Error('Cannot move a folder between different volumes');
  const part = `${dest}.part`;
  let done = 0;
  let last = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      if (Date.now() - last > 1000) { last = Date.now(); onProgress(done, st.size); }
      cb(null, chunk);
    }
  });
  try {
    await pipeline(fs.createReadStream(src, { highWaterMark: 4 << 20 }), counter, fs.createWriteStream(part, { flags: 'wx' }));
    if ((await fsp.stat(part)).size !== st.size) throw new Error('Copy is incomplete');
    await fsp.rename(part, dest);
  } catch (err) {
    await fsp.rm(part, { force: true });
    throw err;
  }
  await fsp.rm(src, { force: true });
  return 'copied';
}

export async function exists(p) {
  try { await fsp.lstat(p); return true; } catch { return false; }
}

/** Free bytes on the filesystem holding `dir`, or null when unknown. */
export async function freeSpace(dir) {
  try {
    const s = await fsp.statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/** Total size of a file or folder. */
export async function sizeOf(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const e of await fsp.readdir(p, { withFileTypes: true })) total += await sizeOf(path.join(p, e.name));
  return total;
}
