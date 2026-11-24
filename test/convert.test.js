// End-to-end test of the conversion service with the real PS5 Dump Forge.
// Runs when GV_FORGE_BIN points at the ps5-dump-forge CLI (CI downloads it); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const forge = process.env.GV_FORGE_BIN;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-conv-'));
process.env.GV_DATA_DIR = path.join(root, 'data');
process.env.GV_INCOMING = path.join(root, 'games', '_incoming');

test('converts a PS5 folder dump and renames a PS4 pkg', { skip: !forge && 'GV_FORGE_BIN not set', timeout: 120000 }, async () => {
  const { db, setSetting } = await import('../server/db.js');
  const conv = await import('../server/convert/service.js');
  const { buildPkg } = await import('./make-fixtures.js');
  const games = path.join(root, 'games');
  for (const p of ['PS5', 'PS4']) {
    fs.mkdirSync(path.join(games, p), { recursive: true });
    db.prepare('INSERT INTO libraries (path, platform) VALUES (?, ?)').run(path.join(games, p), p);
  }
  setSetting('conversion_settle_seconds', '10');
  await conv.startConversionService();
  assert.equal((await conv.checkForge()).available, true);
  await conv.setEnabled(true);

  const dump = path.join(process.env.GV_INCOMING, 'PS5', 'My Game');
  fs.mkdirSync(path.join(dump, 'sce_sys'), { recursive: true });
  fs.writeFileSync(path.join(dump, 'sce_sys', 'param.json'), JSON.stringify({
    titleId: 'PPSA05555', contentId: 'EP9000-PPSA05555_00-TESTGAME00000000', contentVersion: '01.001.000',
    requiredSystemSoftwareVersion: '0x0400000000000000', sdkVersion: '0x0400000000000000',
    localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: 'My Game™: Remastered' } }
  }));
  fs.writeFileSync(path.join(dump, 'eboot.bin'), Buffer.alloc(300000, 3));
  fs.writeFileSync(path.join(process.env.GV_INCOMING, 'PS4', 'x.pkg'), buildPkg({ title: 'Far Cry® 5', titleId: 'CUSA05848', version: '01.00', padMb: 0 }));

  await conv.poll();                      // seen
  await new Promise((r) => setTimeout(r, 10500));
  await conv.poll();                      // settled -> queued and started
  await conv.drain('PS4');
  await conv.drain('PS5');

  const rows = db.prepare('SELECT platform, status, message, output FROM conversions ORDER BY id').all();
  assert.deepEqual(rows.map((r) => [r.platform, r.status, r.message]), [['PS5', 'done', null], ['PS4', 'done', null]]);
  assert.ok(fs.existsSync(path.join(games, 'PS5', 'PPSA05555-My Game Remastered (v01.001.000).exfat')));
  assert.ok(fs.existsSync(path.join(games, 'PS4', 'CUSA05848-Far Cry 5 (v01.00).pkg')));
  assert.ok(fs.existsSync(path.join(process.env.GV_INCOMING, '_done', 'My Game')));
  await conv.stopConversionService();
});
