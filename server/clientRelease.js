import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Keeps a copy of the newest GameVault for PS5 (gamevault.elf from the
 * gamevault-client GitHub releases), so the PS5 can fetch it over plain
 * HTTP from the NAS: its home-screen tile starts it, and it updates itself.
 */

const REPO = process.env.GV_CLIENT_REPO || 'CNBailey/gamevault-client';
const GITHUB_API = process.env.GV_GITHUB_API || 'https://api.github.com';
const CHECK_EVERY_MS = 6 * 3600 * 1000;
const dir = path.join(config.dataDir, 'client');

const state = { version: null, size: 0, sha256: null, file: null, checkedAt: null, error: null };
let checking = null;

async function loadCached() {
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'latest.json'), 'utf8'));
    const file = path.join(dir, meta.fileName);
    const st = await fsp.stat(file);
    Object.assign(state, { version: meta.version, size: st.size, sha256: meta.sha256, file });
  } catch { /* nothing cached yet */ }
}

async function check() {
  try {
    const res = await fetch(`${GITHUB_API}/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': `GameVault/${config.version}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const release = await res.json();
    const version = String(release.tag_name || '').replace(/^v/, '');
    const asset = (release.assets || []).find((a) => a.name === 'gamevault.elf');
    if (!version || !asset) throw new Error('The latest release has no gamevault.elf');
    if (version !== state.version || !state.file) {
      const bin = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': `GameVault/${config.version}` },
        signal: AbortSignal.timeout(120000)
      });
      if (!bin.ok) throw new Error(`Download failed (${bin.status})`);
      const data = Buffer.from(await bin.arrayBuffer());
      if (data.subarray(0, 4).toString('latin1') !== '\x7fELF') throw new Error('The release file is not an ELF');
      await fsp.mkdir(dir, { recursive: true });
      const fileName = `gamevault-${version}.elf`;
      const file = path.join(dir, fileName);
      await fsp.writeFile(`${file}.tmp`, data);
      await fsp.rename(`${file}.tmp`, file);
      const sha256 = crypto.createHash('sha256').update(data).digest('hex');
      await fsp.writeFile(path.join(dir, 'latest.json'), JSON.stringify({ version, fileName, sha256 }));
      for (const old of await fsp.readdir(dir)) {
        if (old.startsWith('gamevault-') && old !== fileName) await fsp.rm(path.join(dir, old), { force: true });
      }
      Object.assign(state, { version, size: data.length, sha256, file });
      console.log(`GameVault for PS5 ${version} downloaded for the console`);
    }
    state.error = null;
  } catch (e) {
    state.error = e.message;
  }
  state.checkedAt = new Date().toISOString();
}

export function checkClientRelease() {
  if (!checking) checking = check().finally(() => { checking = null; });
  return checking;
}

export async function startClientReleases() {
  await loadCached();
  checkClientRelease();
  setInterval(checkClientRelease, CHECK_EVERY_MS).unref();
}

export function clientInfo() {
  return {
    available: Boolean(state.file),
    version: state.version,
    size: state.size,
    sha256: state.sha256,
    checkedAt: state.checkedAt,
    error: state.error,
    url: state.file ? '/api/v1/client/gamevault.elf' : null
  };
}

export function clientFile() {
  return state.file && fs.existsSync(state.file) ? state.file : null;
}
