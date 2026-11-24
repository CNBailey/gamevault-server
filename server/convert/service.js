import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { config } from '../config.js';
import { db, getSetting, setSetting } from '../db.js';
import { isIgnored } from '../files.js';
import { requestLibraryScan } from '../jobs.js';
import { readPkg } from '../parsers/pkg.js';
import { exists, freeSpace, moveInto, sizeOf } from './fsops.js';
import { libraryName, ps4Suffix, uniqueName } from './names.js';

/**
 * Conversion service.
 *  - PS4: a .pkg dropped in <incoming>/PS4 is renamed from its own header and moved into the PS4 library.
 *  - PS5: a game dropped in <incoming>/PS5 (folder dump, .ffpkg, .ffpfs, .ffpfsc, homebrew .pkg,
 *    .zip/.7z/.rar holding one game, or an .exfat) is converted to a standard .exfat with PS5 Dump
 *    Forge (skipped when it already is one), checked, renamed and moved into the PS5 library.
 *    The original goes to <incoming>/_done.
 * A file is only picked up once it has stopped changing for the "settle" time, so half-copied
 * uploads are never touched. PS4 and PS5 each run one job at a time, independently.
 */

const PS5_EXT = new Set(['.exfat', '.ffpkg', '.ffpfs', '.ffpfsc', '.pkg', '.zip', '.7z', '.rar']);
const UPLOADING = /\.(partial|part|filepart|crdownload|download|tmp|temp|uploading|ready)$/i;
const POLL_MS = 15000;

const settling = new Map();          // path -> { platform, name, fp, since, size }
const running = { PS4: null, PS5: null };  // { id, child, cancelled }
let timer = null;
let forgeInfo = { checked: false, available: false, error: null };

const now = () => new Date().toISOString();
export const dirs = () => ({
  root: config.incomingDir,
  PS5: path.join(config.incomingDir, 'PS5'),
  PS4: path.join(config.incomingDir, 'PS4'),
  done: path.join(config.incomingDir, '_done'),
  work: path.join(config.incomingDir, '_work')
});

export const isEnabled = () => getSetting('conversion_enabled', '0') === '1';
const settleMs = () => Math.max(10, Number(getSetting('conversion_settle_seconds', '60')) || 60) * 1000;

function update(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  db.prepare(`UPDATE conversions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map((k) => (fields[k] === undefined ? null : fields[k])), id);
}

class JobError extends Error {}
const fail = (msg) => { throw new JobError(msg); };

function libraryFor(platform) {
  const lib = db.prepare('SELECT path FROM libraries WHERE enabled = 1 AND platform = ? ORDER BY id LIMIT 1').get(platform);
  if (!lib) fail(`No ${platform} library folder is set up (Settings → Library folders).`);
  return lib.path;
}

// ---- PS5 Dump Forge ----------------------------------------------------------

function runForge(args, { onLine, timeoutMs = 0, track } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(config.forgeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    if (track) track(child);
    let stdout = '';
    let stderr = '';
    const timer = timeoutMs ? setTimeout(() => child.kill('SIGINT'), timeoutMs) : null;
    if (onLine) {
      readline.createInterface({ input: child.stdout }).on('line', onLine);
    } else {
      child.stdout.on('data', (d) => { stdout += d; });
    }
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new JobError('PS5 Dump Forge is not installed in this container.') : err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else {
        const last = stderr.trim().split('\n').filter(Boolean).pop() || `exit ${code ?? signal}`;
        reject(new JobError(last.replace(/^ps5-dump-forge:\s*/, '')));
      }
    });
  });
}

export async function checkForge() {
  try {
    await runForge(['inspect', '--help'], { timeoutMs: 10000 }).catch((err) => {
      // The CLI prints usage and exits non-zero for --help; only "not installed" matters.
      if (/not installed/.test(err.message)) throw err;
    });
    forgeInfo = { checked: true, available: true, error: null };
  } catch (err) {
    forgeInfo = { checked: true, available: false, error: err.message };
  }
  return forgeInfo;
}

async function inspect(p) {
  const { stdout } = await runForge(['inspect', p, '--json'], { timeoutMs: 30 * 60 * 1000 });
  try { return JSON.parse(stdout); } catch { fail('PS5 Dump Forge did not return valid details.'); }
  return null;
}

// ---- Jobs --------------------------------------------------------------------

async function runPs4(row) {
  update(row.id, { action: 'rename', stage: 'Reading package' });
  const st = await fsp.lstat(row.source).catch(() => null);
  if (!st) fail('The file is no longer in the incoming folder.');
  if (st.isDirectory()) fail('Only .pkg files are handled in the PS4 folder.');
  if (!row.source.toLowerCase().endsWith('.pkg')) fail('Not a .pkg file.');
  let info;
  try { info = await readPkg(row.source); } catch (err) { fail(`Not a valid PS4 package (${err.message}).`); }
  if (!/^CUSA\d{5}$/.test(info.titleId || '')) fail('The package has no PS4 title ID (CUSA…).');
  const name = libraryName({ titleId: info.titleId, title: info.title, version: info.version, suffix: ps4Suffix(info.category), ext: '.pkg', maxStemBytes: 150 });
  update(row.id, { title_id: info.titleId, title: info.title, version: info.version, size_bytes: st.size });
  const dest = path.join(libraryFor('PS4'), name);
  if (await exists(dest)) fail(`Already in the library as “${name}”. The incoming file was left where it is.`);
  update(row.id, { stage: 'Moving into the library' });
  await moveInto(row.source, dest, (done, total) => update(row.id, { progress: done / total }));
  update(row.id, { output: dest, progress: 1 });
  requestLibraryScan('PS4');
}

async function runPs5(row, job) {
  update(row.id, { action: 'convert', stage: 'Checking the game' });
  const st = await fsp.lstat(row.source).catch(() => null);
  if (!st) fail('The file is no longer in the incoming folder.');
  const ext = path.extname(row.source).toLowerCase();
  if (!st.isDirectory() && !PS5_EXT.has(ext)) fail(`Unsupported file type (${ext || 'no extension'}). Use a game folder, .exfat, .ffpkg, .ffpfs, .ffpfsc, homebrew .pkg, .zip, .7z or .rar.`);
  if (ext === '.pkg') {
    const fh = await fsp.open(row.source, 'r');
    const head = Buffer.alloc(4);
    await fh.read(head, 0, 4, 0);
    await fh.close();
    if (head.toString('latin1') === '\x7FCNT') fail('This is a PS4 package. Put it in the PS4 folder instead.');
  }

  const found = await inspect(row.source);
  if (found.patch) fail('This is a patch package. Patches can’t be converted.');
  if (found.additional_content) fail('This is DLC or an update rather than a full game, so it wasn’t converted.');
  const titleId = String(found.title_id || '').toUpperCase();
  if (!/^PPSA\d{5}$/.test(titleId)) fail(`No PS5 title ID found (got “${found.title_id || 'none'}”).`);
  const names = found.title_names || {};
  const title = names['en-US'] || names['en-GB'] || found.title_name || '';
  const version = found.version || null;
  const size = found.total_bytes || (await sizeOf(row.source));
  update(row.id, { title_id: titleId, title, version, size_bytes: size });

  const name = libraryName({ titleId, title, version, ext: '.exfat', maxStemBytes: 63 });
  const dest = path.join(libraryFor('PS5'), name);
  if (await exists(dest)) fail(`Already in the library as “${name}”. The incoming file was left where it is.`);

  if (found.kind === 'exfat') {
    // Already an exFAT image: no conversion, just name it and move it in.
    update(row.id, { action: 'publish', stage: 'Moving into the library' });
    await moveInto(row.source, dest, (d, t) => update(row.id, { progress: d / t }));
  } else {
    const d = dirs();
    const free = await freeSpace(d.work);
    const need = Math.round(size * 1.1) + 512 * 1024 * 1024;
    if (free !== null && free < need) {
      fail(`Not enough free space: about ${(need / 1e9).toFixed(1)} GB is needed and ${(free / 1e9).toFixed(1)} GB is free.`);
    }
    const jobDir = path.join(d.work, String(row.id));
    await fsp.rm(jobDir, { recursive: true, force: true });
    await fsp.mkdir(jobDir, { recursive: true });
    const out = path.join(jobDir, `${titleId}.exfat`);
    let lastWrite = 0;
    let error = null;
    const STAGES = { scan: 'Reading the source', extract: 'Reading the archive', preflight: 'Checking', write: 'Writing the image', verify: 'Verifying', finalize: 'Finishing' };
    try {
      await runForge(['convert', row.source, '--to', 'exfat', '-o', out], {
        track: (child) => { job.child = child; },
        onLine: (line) => {
          let ev;
          try { ev = JSON.parse(line); } catch { return; }
          if (ev.kind === 'progress' && Date.now() - lastWrite > 1000) {
            lastWrite = Date.now();
            update(row.id, { stage: STAGES[ev.stage] || ev.stage, progress: ev.total ? Math.min(0.99, ev.done / ev.total) : null });
          } else if (ev.kind === 'done' && ev.result && ev.result.Err) {
            error = ev.result.Err;
          }
        }
      });
    } catch (err) {
      await fsp.rm(jobDir, { recursive: true, force: true });
      if (job.cancelled) fail('Cancelled.');
      fail(`Conversion failed: ${error || err.message}`);
    } finally {
      job.child = null;
    }
    update(row.id, { stage: 'Checking the result', progress: 0.99 });
    const check = await inspect(out).catch((err) => ({ error: err.message }));
    if (check.error || check.kind !== 'exfat' || String(check.title_id || '').toUpperCase() !== titleId) {
      await fsp.rm(jobDir, { recursive: true, force: true });
      fail(`The converted image did not pass its check${check.error ? ` (${check.error})` : ''}.`);
    }
    update(row.id, { stage: 'Moving into the library' });
    await moveInto(out, dest);
    await fsp.rm(jobDir, { recursive: true, force: true });
    // Keep the original in _done until you clear it out.
    try {
      const doneName = uniqueName(row.source_name, (n) => fs.existsSync(path.join(d.done, n)));
      await moveInto(row.source, path.join(d.done, doneName));
    } catch (err) {
      update(row.id, { message: `Converted, but the original could not be moved to _done: ${err.message}` });
    }
  }
  update(row.id, { output: dest, progress: 1 });
  requestLibraryScan('PS5');
}

/** Runs queued jobs for a platform until none are left (used by tests). */
export async function drain(platform) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    if (!running[platform] && !db.prepare("SELECT 1 FROM conversions WHERE platform = ? AND status = 'queued'").get(platform)) return;
  }
}

async function runNext(platform) {
  if (running[platform] || !isEnabled()) return;
  const row = db.prepare("SELECT * FROM conversions WHERE platform = ? AND status = 'queued' ORDER BY id LIMIT 1").get(platform);
  if (!row) return;
  const job = { id: row.id, child: null, cancelled: false };
  running[platform] = job;
  update(row.id, { status: 'running', started_at: now(), finished_at: null, progress: 0, message: null, output: null });
  try {
    if (platform === 'PS4') await runPs4(row); else await runPs5(row, job);
    update(row.id, { status: 'done', stage: 'Done', finished_at: now() });
  } catch (err) {
    const message = err instanceof JobError ? err.message : `Unexpected error: ${err.message}`;
    if (!(err instanceof JobError)) console.warn(`[convert] job ${row.id}:`, err);
    update(row.id, { status: 'failed', stage: null, message, finished_at: now() });
  } finally {
    running[platform] = null;
    setImmediate(() => runNext(platform));
  }
}

// ---- Watching the incoming folders ---------------------------------------------

async function fingerprint(p) {
  const st = await fsp.lstat(p);
  if (!st.isDirectory()) return { fp: `${st.size}:${Math.round(st.mtimeMs)}`, size: st.size };
  let files = 0;
  let size = 0;
  let newest = st.mtimeMs;
  const walk = async (dir) => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        const s = await fsp.lstat(full);
        files++;
        size += s.size;
        newest = Math.max(newest, s.mtimeMs);
      }
    }
  };
  await walk(p);
  return { fp: `${files}:${size}:${Math.round(newest)}`, size };
}

const activeRow = db.prepare("SELECT id FROM conversions WHERE source = ? AND status IN ('queued', 'running') LIMIT 1");
const finishedSame = db.prepare("SELECT id FROM conversions WHERE source = ? AND fingerprint = ? AND status IN ('failed', 'done') LIMIT 1");
const insertJob = db.prepare(`INSERT INTO conversions (platform, source, source_name, fingerprint, status, created_at, size_bytes)
  VALUES (?, ?, ?, ?, 'queued', ?, ?)`);

export async function poll() {
  if (!isEnabled()) return;
  const d = dirs();
  const seen = new Set();
  for (const platform of ['PS5', 'PS4']) {
    await fsp.mkdir(d[platform], { recursive: true }).catch(() => {});
    let entries = [];
    try { entries = await fsp.readdir(d[platform], { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (isIgnored(e.name) || e.name.startsWith('_') || UPLOADING.test(e.name) || e.isSymbolicLink()) continue;
      const full = path.join(d[platform], e.name);
      seen.add(full);
      if (activeRow.get(full)) continue;
      let info;
      try { info = await fingerprint(full); } catch { continue; }
      if (finishedSame.get(full, info.fp)) continue;  // already tried this exact upload
      const s = settling.get(full);
      if (!s || s.fp !== info.fp) {
        settling.set(full, { platform, name: e.name, fp: info.fp, since: Date.now(), size: info.size });
        continue;
      }
      if (Date.now() - s.since >= settleMs()) {
        insertJob.run(platform, full, e.name, info.fp, now(), info.size);
        settling.delete(full);
      }
    }
  }
  for (const p of settling.keys()) if (!seen.has(p)) settling.delete(p);
  runNext('PS4');
  runNext('PS5');
}

// ---- Control -------------------------------------------------------------------

export async function startConversionService() {
  // Jobs interrupted by a restart start again from the beginning.
  const interrupted = db.prepare("SELECT id FROM conversions WHERE status = 'running'").all();
  for (const r of interrupted) {
    await fsp.rm(path.join(dirs().work, String(r.id)), { recursive: true, force: true }).catch(() => {});
    update(r.id, { status: 'queued', stage: null, progress: null, message: 'Restarted after GameVault was stopped.' });
  }
  await checkForge();
  if (timer) clearInterval(timer);
  timer = setInterval(() => poll().catch((err) => console.warn('[convert] poll:', err.message)), POLL_MS);
  if (isEnabled()) {
    await ensureDirs();
    poll().catch(() => {});
  }
}

export async function stopConversionService() {
  if (timer) clearInterval(timer);
  timer = null;
  for (const job of Object.values(running)) if (job?.child) job.child.kill('SIGINT');
}

async function ensureDirs() {
  const d = dirs();
  for (const p of [d.PS5, d.PS4, d.done, d.work]) await fsp.mkdir(p, { recursive: true });
}

export async function setEnabled(on) {
  setSetting('conversion_enabled', on ? '1' : '0');
  if (on) {
    await ensureDirs();
    poll().catch(() => {});
  }
}

export function setSettleSeconds(sec) {
  setSetting('conversion_settle_seconds', String(Math.max(10, Number(sec) || 60)));
}

export function cancel(id) {
  const row = db.prepare('SELECT * FROM conversions WHERE id = ?').get(id);
  if (!row) return false;
  if (row.status === 'queued') {
    update(id, { status: 'failed', message: 'Cancelled.', finished_at: now() });
    return true;
  }
  const job = Object.values(running).find((j) => j && j.id === id);
  if (job) {
    job.cancelled = true;
    if (job.child) job.child.kill('SIGINT');
    return true;
  }
  return false;
}

export function retry(id) {
  const row = db.prepare('SELECT * FROM conversions WHERE id = ?').get(id);
  if (!row || row.status !== 'failed') return false;
  if (!fs.existsSync(row.source)) return false;
  update(id, { status: 'queued', message: null, stage: null, progress: null, finished_at: null });
  setImmediate(() => runNext(row.platform));
  return true;
}

export function remove(id) {
  const r = db.prepare("DELETE FROM conversions WHERE id = ? AND status IN ('done', 'failed')").run(id);
  return r.changes > 0;
}

export function clearHistory() {
  return db.prepare("DELETE FROM conversions WHERE status = 'done'").run().changes;
}

export async function doneFolderInfo() {
  const d = dirs().done;
  let items = 0;
  let size = 0;
  try {
    for (const e of await fsp.readdir(d)) {
      if (isIgnored(e)) continue;
      items++;
      size += await sizeOf(path.join(d, e)).catch(() => 0);
    }
  } catch { /* not created yet */ }
  return { path: d, items, size };
}

/** Permanently deletes everything in _done (the originals of finished conversions). */
export async function emptyDoneFolder() {
  const d = dirs().done;
  let removed = 0;
  for (const e of await fsp.readdir(d).catch(() => [])) {
    await fsp.rm(path.join(d, e), { recursive: true, force: true });
    removed++;
  }
  return removed;
}

export async function status() {
  const rows = db.prepare('SELECT * FROM conversions ORDER BY id DESC LIMIT 200').all();
  const shape = (r) => ({
    id: r.id, platform: r.platform, sourceName: r.source_name, status: r.status, action: r.action,
    stage: r.stage, progress: r.progress, message: r.message, output: r.output ? path.basename(r.output) : null,
    titleId: r.title_id, title: r.title, version: r.version, sizeBytes: r.size_bytes,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at
  });
  return {
    enabled: isEnabled(),
    settleSeconds: settleMs() / 1000,
    folders: dirs(),
    forge: { ...forgeInfo, version: config.forgeVersion || null },
    waiting: [...settling.values()].map((s) => ({
      platform: s.platform, name: s.name, size: s.size,
      secondsLeft: Math.max(0, Math.ceil((settleMs() - (Date.now() - s.since)) / 1000))
    })),
    active: rows.filter((r) => r.status === 'running').map(shape),
    queued: rows.filter((r) => r.status === 'queued').reverse().map(shape),
    history: rows.filter((r) => r.status === 'done' || r.status === 'failed').map(shape),
    done: await doneFolderInfo()
  };
}
