import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

export const mediaRoot = path.join(config.dataDir, 'media');
/** Put ps5.svg / ps4.png (etc.) here to replace the text platform badges. */
export const badgesDir = path.join(config.dataDir, 'badges');
/** Built-in badges shipped with the app (server/assets/badges). */
export const defaultBadgesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets', 'badges');

function gameDir(gameId) {
  return path.join(mediaRoot, String(gameId));
}

function url(gameId, name) {
  return `/media/${gameId}/${name}?v=${Date.now().toString(36)}`;
}

export async function saveBuffer(gameId, name, buf) {
  if (!buf || !buf.length) return null;
  await fs.mkdir(gameDir(gameId), { recursive: true });
  await fs.writeFile(path.join(gameDir(gameId), name), buf);
  return url(gameId, name);
}

export async function copyInto(gameId, name, sourceFile) {
  if (!sourceFile) return null;
  try {
    return await saveBuffer(gameId, name, await fs.readFile(sourceFile));
  } catch {
    return null;
  }
}

export async function download(gameId, name, remoteUrl) {
  const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Image download failed (${res.status}) for ${remoteUrl}`);
  return saveBuffer(gameId, name, Buffer.from(await res.arrayBuffer()));
}

/** Removes previously scraped images (keeps the icon taken from the dump itself). */
export async function clearScraped(gameId) {
  try {
    const files = await fs.readdir(gameDir(gameId));
    await Promise.all(files
      .filter((f) => !f.startsWith('local-'))
      .map((f) => fs.rm(path.join(gameDir(gameId), f), { force: true })));
  } catch { /* nothing cached yet */ }
}

export async function removeGameMedia(gameId) {
  await fs.rm(gameDir(gameId), { recursive: true, force: true });
}
