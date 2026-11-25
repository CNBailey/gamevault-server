// Copying games to a USB drive on the NAS: drive detection from mountinfo, where each
// kind of game goes, refusing drives that aren't exFAT, and skipping copies already there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-usb-'));
const usbRoot = path.join(root, 'usb');
const nas = path.join(root, 'nas');
process.env.GV_DATA_DIR = path.join(root, 'data');
process.env.GV_USB_ROOT = usbRoot;
process.env.GV_MOUNTINFO = path.join(root, 'mountinfo');

const esc = (p) => p.replace(/ /g, '\\040');
function mounts(lines) {
  fs.writeFileSync(process.env.GV_MOUNTINFO, lines.map(([point, fsRoot, type]) =>
    `100 1 8:1 ${esc(fsRoot)} ${esc(point)} rw,relatime shared:1 - ${type} /dev/sdq1 rw`).join('\n') + '\n');
}

test('lists drives, copies PS5 games to homebrew and PS4 packages to the root', async () => {
  const { db } = await import('../server/db.js');
  const usb = await import('../server/usb.js');
  const drive = path.join(usbRoot, '1', 'usbshare');
  fs.mkdirSync(drive, { recursive: true });
  fs.mkdirSync(path.join(nas, 'PS5', 'Folder Game', 'sce_sys'), { recursive: true });
  fs.mkdirSync(path.join(nas, 'PS4', 'Hades'), { recursive: true });
  const image = path.join(nas, 'PS5', 'Big: Game.exfat');
  fs.writeFileSync(image, Buffer.alloc(3 << 20, 7));
  fs.writeFileSync(path.join(nas, 'PS5', 'Folder Game', 'sce_sys', 'param.json'), '{}');
  fs.writeFileSync(path.join(nas, 'PS5', 'Folder Game', 'eboot.bin'), Buffer.alloc(1 << 20, 1));
  const base = path.join(nas, 'PS4', 'Hades', 'Hades.pkg');
  const patch = path.join(nas, 'PS4', 'Hades', 'Hades patch.pkg');
  fs.writeFileSync(base, Buffer.alloc(2 << 20, 2));
  fs.writeFileSync(patch, Buffer.alloc(1 << 20, 3));

  const lib = db.prepare('INSERT INTO libraries (path, platform) VALUES (?, ?)').run(path.join(nas, 'PS5'), 'PS5').lastInsertRowid;
  const add = (title, platform, kind, p, pkgs) => db.prepare(
    "INSERT INTO games (library_id, path, kind, platform, title, pkgs, size_bytes, missing, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))"
  ).run(lib, p, kind, platform, title, JSON.stringify(pkgs), pkgs.reduce((n, x) => n + x.size, 0) || (1 << 20)).lastInsertRowid;
  const ids = {
    image: add('Big Game', 'PS5', 'ps5-exfat', image, [{ path: 'Big: Game.exfat', file: image, size: 3 << 20, category: 'image' }]),
    folder: add('Folder Game', 'PS5', 'ps5-folder', path.join(nas, 'PS5', 'Folder Game'), []),
    ps4: add('Hades', 'PS4', 'ps4-pkg', path.join(nas, 'PS4', 'Hades'), [
      { path: 'Hades.pkg', file: base, size: 2 << 20, category: 'gd' },
      { path: 'updates/Hades patch.pkg', file: patch, size: 1 << 20, category: 'gp' }])
  };

  // Not mounted at all; then the NAS folder only (no drive in it); then an NTFS drive.
  mounts([]);
  assert.deepEqual(await usb.listDrives(), []);
  mounts([[path.join(usbRoot, '1'), '/volumeUSB1', 'ext4']]);
  assert.deepEqual(await usb.listDrives(), [], 'the NAS folder the drive appears in is not a drive');
  mounts([[path.join(usbRoot, '1'), '/volumeUSB1', 'ext4'], [drive, '/', 'ntfs3']]);
  let drives = await usb.listDrives();
  assert.equal(drives.length, 1);
  assert.equal(drives[0].exfat, 'no');
  await assert.rejects(usb.copyGames(drives[0].id, [ids.image]), /not exFAT/);

  mounts([[path.join(usbRoot, '1'), '/volumeUSB1', 'ext4'], [drive, '/', 'exfat']]);
  drives = await usb.listDrives();
  assert.equal(drives[0].exfat, 'yes');
  assert.equal(drives[0].id, '1/usbshare');
  const r = await usb.copyGames(drives[0].id, [ids.image, ids.folder, ids.ps4]);
  assert.equal(r.queued, 3, JSON.stringify(r.errors));
  for (let i = 0; i < 100 && usb.status().some((j) => j.state === 'queued' || j.state === 'copying'); i++) await new Promise((res) => setTimeout(res, 50));
  assert.deepEqual(usb.status().map((j) => j.state), ['done', 'done', 'done'], JSON.stringify(usb.status()));

  // PS5 in homebrew (names made safe for exFAT), PS4 packages in the root
  assert.equal(fs.statSync(path.join(drive, 'homebrew', 'Big- Game.exfat')).size, 3 << 20);
  assert.equal(fs.readFileSync(path.join(drive, 'homebrew', 'Folder Game', 'eboot.bin')).length, 1 << 20);
  assert.ok(fs.existsSync(path.join(drive, 'Hades.pkg')));
  assert.ok(fs.existsSync(path.join(drive, 'Hades patch.pkg')));
  assert.ok(!fs.readdirSync(drive).some((n) => n.endsWith('.gvpart')));
  assert.deepEqual((await usb.presentOn(drives[0].id)).sort(), Object.values(ids).map(Number).sort());

  // Copying again skips what's there
  usb.clearFinished();
  await usb.copyGames(drives[0].id, [ids.image]);
  for (let i = 0; i < 100 && usb.status().some((j) => j.state !== 'done'); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(usb.status()[0].note, 'Already on the drive');

  // A PS4 folder dump can't go on a USB drive
  const bad = add('Dump', 'PS4', 'ps4-folder', path.join(nas, 'PS4', 'Dump'), []);
  const r2 = await usb.copyGames(drives[0].id, [bad]);
  assert.equal(r2.queued, 0);
  assert.match(r2.errors[0].error, /\.pkg/);
});
