/**
 * Copying games to a USB drive plugged into the NAS.
 *
 * Drives are the file systems mounted under GV_USB_ROOT (default /usb) inside the
 * container. On a Synology, docker-compose maps /volumeUSB1 (and /volumeUSB2 ...)
 * there with "rslave", so a drive plugged in after the container started still shows.
 *
 * PS5 games go to <drive>/homebrew/ (created when missing), where ShadowMountPlus finds
 * them; PS4 .pkg files (base game, patches, add-ons) go to the drive's root.
 * GameVault never formats a drive: one that isn't exFAT is reported, with where to
 * format it in DSM, and nothing is copied to it.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { walkFiles } from './files.js';

const MOUNTINFO = process.env.GV_MOUNTINFO || '/proc/self/mountinfo';

/** mountinfo escapes spaces and the like as \040 */
const unescape = (s) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/** Every whole file system mounted at or under the USB root. */
function usbMounts() {
  let text = '';
  try { text = fs.readFileSync(MOUNTINFO, 'utf8'); } catch { return []; }
  const root = config.usbRoot;
  const found = [];
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const f = left.split(' ');
    const fsRoot = unescape(f[3] || '');
    const mountPoint = unescape(f[4] || '');
    const [fsType, source] = right.split(' ');
    if (mountPoint !== root && !mountPoint.startsWith(root + '/')) continue;
    // Only a whole file system is a drive. "/volumeUSB1" bound from the NAS's own
    // disk (the folder the drive appears in) has a sub-path as its root.
    if (fsRoot !== '/') continue;
    found.push({ mountPoint, fsType, source: unescape(source || '') });
  }
  // A later mount at the same place hides the earlier one.
  const byPoint = new Map();
  for (const m of found) byPoint.set(m.mountPoint, m);
  return [...byPoint.values()].sort((a, b) => a.mountPoint.localeCompare(b.mountPoint));
}

const FS_NAMES = { exfat: 'exFAT', vfat: 'FAT32', msdos: 'FAT32', ntfs: 'NTFS', ntfs3: 'NTFS', ufsd: 'NTFS', ext4: 'ext4', ext3: 'ext3', btrfs: 'Btrfs', hfsplus: 'HFS+', fuseblk: 'exFAT or NTFS' };

/** exFAT: yes; fuseblk (exFAT or NTFS through FUSE): can't tell; anything else: no. */
function exfatState(fsType) {
  if (fsType === 'exfat') return 'yes';
  if (fsType === 'fuseblk' || fsType.startsWith('fuse.exfat')) return 'unknown';
  return 'no';
}

const driveId = (mountPoint) => path.relative(config.usbRoot, mountPoint) || '.';

async function describe(m) {
  let total = 0, free = 0, writable = false;
  try {
    const s = await fsp.statfs(m.mountPoint);
    total = s.blocks * s.bsize;
    free = s.bavail * s.bsize;
  } catch { /* gone */ }
  try { await fsp.access(m.mountPoint, fs.constants.W_OK); writable = true; } catch { /* read-only */ }
  const exfat = exfatState(m.fsType);
  return {
    id: driveId(m.mountPoint),
    path: m.mountPoint,
    label: path.basename(m.mountPoint),
    fsType: m.fsType,
    fsName: FS_NAMES[m.fsType] || m.fsType,
    exfat,
    total,
    free,
    reserved: reservedOn(m.mountPoint),
    writable,
    hasHomebrew: fs.existsSync(path.join(m.mountPoint, 'homebrew'))
  };
}

export async function listDrives() {
  return Promise.all(usbMounts().map(describe));
}

async function findDrive(id) {
  const m = usbMounts().find((x) => driveId(x.mountPoint) === id);
  return m ? describe(m) : null;
}

// ---- what goes where ---------------------------------------------------------------

/** exFAT can't hold these in a name; the NAS can. */
const safeName = (name) => name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'game';

/** The files of a game and where each goes on the drive. */
export async function plan(row, drivePath) {
  const pkgs = JSON.parse(row.pkgs || '[]');
  const homebrew = path.join(drivePath, 'homebrew');
  if (row.kind === 'ps5-exfat') {
    return pkgs.map((p) => ({ src: p.file, dest: path.join(homebrew, safeName(path.basename(p.file || p.path))), size: p.size }));
  }
  if (row.kind === 'ps4-pkg') {
    return pkgs.map((p) => ({ src: p.file, dest: path.join(drivePath, safeName(path.basename(p.path))), size: p.size }));
  }
  if (row.kind === 'ps5-folder') {
    const folder = path.join(homebrew, safeName(path.basename(row.path)));
    return (await walkFiles(row.path)).map((f) => ({
      src: path.join(row.path, f.path),
      dest: path.join(folder, ...f.path.split('/').map(safeName)),
      size: f.size
    }));
  }
  if (row.kind === 'ps4-folder') throw new Error('PS4 folder dumps can’t be installed from a USB drive. Make a .pkg of it first.');
  throw new Error(`Don’t know how to copy a ${row.kind || 'game'} to a USB drive`);
}

/** True when every file of the game is already on the drive, at full size. */
function onDrive(files) {
  return files.length > 0 && files.every((f) => {
    try { return fs.statSync(f.dest).size === f.size; } catch { return false; }
  });
}

/** Game ids whose files are all on the drive already. */
export async function presentOn(id) {
  const d = await findDrive(id);
  if (!d) return [];
  const rows = db.prepare("SELECT * FROM games WHERE missing = 0 AND kind IN ('ps5-exfat','ps4-pkg','ps5-folder')").all();
  const out = [];
  for (const row of rows) {
    if (row.kind === 'ps5-folder') {
      // a folder: present when its param.json is there (walking every folder is slow)
      if (fs.existsSync(path.join(d.path, 'homebrew', safeName(path.basename(row.path)), 'sce_sys', 'param.json'))) out.push(row.id);
      continue;
    }
    try { if (onDrive(await plan(row, d.path))) out.push(row.id); } catch { /* not copyable */ }
  }
  return out;
}

// ---- the copy queue ----------------------------------------------------------------

const jobs = [];
let nextId = 1;
let running = null;

function reservedOn(drivePath) {
  return jobs.filter((j) => j.drivePath === drivePath && (j.state === 'queued' || j.state === 'copying'))
    .reduce((n, j) => n + (j.total - j.done), 0);
}

const view = (j) => ({
  id: j.id, gameId: j.gameId, title: j.title, platform: j.platform, drive: j.driveLabel, state: j.state,
  total: j.total, done: j.done, speed: j.speed, error: j.error, note: j.note,
  file: j.current ? path.basename(j.current) : null, createdAt: j.createdAt, finishedAt: j.finishedAt
});

export function status() {
  return jobs.map(view);
}

/** Queues copies of the given games to a drive. Returns { queued, errors: [{ id, title, error }] }. */
export async function copyGames(driveIdValue, gameIds) {
  const drive = await findDrive(driveIdValue);
  if (!drive) throw new Error('That USB drive isn’t connected any more');
  if (drive.exfat === 'no') throw new Error(`The drive is ${drive.fsName}, not exFAT. Format it as exFAT in DSM first (Control Panel → External Devices).`);
  if (!drive.writable) throw new Error('The drive is read-only to GameVault');
  const errors = [];
  let queued = 0;
  let room = drive.free - drive.reserved;
  for (const id of gameIds) {
    const row = db.prepare('SELECT * FROM games WHERE id = ?').get(Number(id));
    if (!row) { errors.push({ id, error: 'Not in the library' }); continue; }
    const title = row.title || row.local_title || path.basename(row.path);
    if (jobs.some((j) => j.gameId === row.id && j.drivePath === drive.path && (j.state === 'queued' || j.state === 'copying'))) {
      errors.push({ id, title, error: 'Already queued for this drive' });
      continue;
    }
    let files;
    try { files = await plan(row, drive.path); } catch (err) { errors.push({ id, title, error: err.message }); continue; }
    if (!files.length || files.some((f) => !f.src)) { errors.push({ id, title, error: 'Its files aren’t on the NAS any more; rescan the library' }); continue; }
    const need = files.reduce((n, f) => {
      try { if (fs.statSync(f.dest).size === f.size) return n; } catch { /* not there */ }
      return n + f.size;
    }, 0);
    if (need > room) {
      errors.push({ id, title, error: `Needs ${(need / 1e9).toFixed(1)} GB; the drive has ${(Math.max(0, room) / 1e9).toFixed(1)} GB left` });
      continue;
    }
    room -= need;
    jobs.push({
      id: nextId++, gameId: row.id, title, platform: row.platform, drivePath: drive.path, driveLabel: drive.label,
      files, state: 'queued', total: files.reduce((n, f) => n + f.size, 0), done: 0, speed: 0, error: null, note: null,
      current: null, cancel: false, createdAt: new Date().toISOString(), finishedAt: null
    });
    queued++;
  }
  setImmediate(pump);
  return { queued, errors };
}

export function cancel(id) {
  const j = jobs.find((x) => x.id === Number(id));
  if (!j || (j.state !== 'queued' && j.state !== 'copying')) return false;
  j.cancel = true;
  if (j.state === 'queued') finish(j, 'cancelled');
  return true;
}

export function remove(id) {
  const i = jobs.findIndex((x) => x.id === Number(id));
  if (i < 0 || jobs[i].state === 'queued' || jobs[i].state === 'copying') return false;
  jobs.splice(i, 1);
  return true;
}

export function clearFinished() {
  let n = 0;
  for (let i = jobs.length - 1; i >= 0; i--) {
    if (jobs[i].state !== 'queued' && jobs[i].state !== 'copying') { jobs.splice(i, 1); n++; }
  }
  return n;
}

function finish(j, state, error = null) {
  j.state = state;
  j.error = error;
  j.speed = 0;
  j.current = null;
  j.finishedAt = new Date().toISOString();
}

async function pump() {
  if (running) return;
  const j = jobs.find((x) => x.state === 'queued');
  if (!j) return;
  running = j;
  try {
    await runJob(j);
  } catch (err) {
    finish(j, j.cancel ? 'cancelled' : 'failed', j.cancel ? null : friendly(err));
  } finally {
    running = null;
    setImmediate(pump);
  }
}

function friendly(err) {
  if (err.code === 'ENOSPC') return 'The drive is full';
  if (err.code === 'ENOENT') return 'A file went missing (was the drive unplugged, or the game moved?)';
  if (err.code === 'EROFS' || err.code === 'EACCES' || err.code === 'EPERM') return 'The drive won’t accept files (read-only?)';
  if (err.code === 'EIO') return 'The drive reported a read/write error';
  return err.message;
}

async function runJob(j) {
  j.state = 'copying';
  let skipped = 0;
  const started = Date.now();
  let lastTick = started, lastBytes = 0;
  for (const f of j.files) {
    if (j.cancel) throw new Error('cancelled');
    try {
      if ((await fsp.stat(f.dest)).size === f.size) { j.done += f.size; skipped++; continue; }
    } catch { /* not there yet */ }
    await fsp.mkdir(path.dirname(f.dest), { recursive: true });
    const part = `${f.dest}.gvpart`;
    j.current = f.dest;
    try {
      await new Promise((resolve, reject) => {
        const input = fs.createReadStream(f.src, { highWaterMark: 8 << 20 });
        const output = fs.createWriteStream(part, { highWaterMark: 8 << 20 });
        const fail = (err) => { input.destroy(); output.destroy(); reject(err); };
        input.on('data', (chunk) => {
          if (j.cancel) return fail(new Error('cancelled'));
          j.done += chunk.length;
          const now = Date.now();
          if (now - lastTick >= 1000) {
            j.speed = (j.done - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = j.done;
          }
        });
        input.on('error', fail);
        output.on('error', fail);
        output.on('close', resolve);
        input.pipe(output);
      });
      // on the drive for real before it's called done (it may be unplugged next)
      const fd = await fsp.open(part, 'r+');
      try { await fd.sync(); } finally { await fd.close(); }
      await fsp.rename(part, f.dest);
    } catch (err) {
      await fsp.rm(part, { force: true }).catch(() => {});
      throw err;
    }
  }
  finish(j, 'done');
  if (skipped === j.files.length) j.note = 'Already on the drive';
  else if (skipped) j.note = `${skipped} file${skipped === 1 ? ' was' : 's were'} already there`;
}

/** For the Settings/USB page: is the USB folder mapped into the container at all? */
export function usbRootMapped() {
  return fs.existsSync(config.usbRoot);
}
