import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPkg, buildSfo } from './make-fixtures.js';
import { parseSfo } from '../server/parsers/sfo.js';
import { readPkg } from '../server/parsers/pkg.js';
import { execFileSync } from 'node:child_process';
import { ps5Exfat } from './make-fixtures.js';
import { readExfatGame } from '../server/parsers/exfat.js';
import { parseExfatName, readPs5Exfat } from '../server/parsers/ps5.js';

let hasMkfs = true;
try { execFileSync('sh', ['-c', 'command -v mkfs.exfat'], { stdio: 'ignore' }); } catch { hasMkfs = false; }

process.env.GV_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gv-test-'));
const { cleanName } = await import('../server/scanner.js');
const { similarity } = await import('../server/scraper.js');

test('parses param.sfo strings and integers', () => {
  const sfo = parseSfo(buildSfo({ TITLE: 'Bloodborne', TITLE_ID: 'CUSA00900', ATTRIBUTE: 32 }));
  assert.equal(sfo.TITLE, 'Bloodborne');
  assert.equal(sfo.TITLE_ID, 'CUSA00900');
  assert.equal(sfo.ATTRIBUTE, 32);
});

test('reads metadata and icon from a PS4 pkg', async () => {
  const file = path.join(process.env.GV_DATA_DIR, 'game.pkg');
  fs.writeFileSync(file, buildPkg({ title: 'Hades', titleId: 'CUSA12345', version: '01.05', padMb: 0 }));
  const info = await readPkg(file, { images: true });
  assert.equal(info.title, 'Hades');
  assert.equal(info.titleId, 'CUSA12345');
  assert.equal(info.version, '01.05');
  assert.equal(info.category, 'gd');
  assert.ok(info.icon0.length > 0);
});

test('rejects files that are not pkgs', async () => {
  const file = path.join(process.env.GV_DATA_DIR, 'nope.pkg');
  fs.writeFileSync(file, Buffer.alloc(512));
  await assert.rejects(() => readPkg(file), /Not a PS4 PKG/);
});

test('cleans folder names', () => {
  assert.equal(cleanName('Astro_Bot [PPSA01325] v1.02'), 'Astro Bot');
  assert.equal(cleanName('Hades (CUSA12345).pkg'), 'Hades');
});

test('title similarity', () => {
  assert.equal(similarity('Returnal™', 'Returnal'), 1);
  assert.ok(similarity('Ghost of Tsushima', 'Ghost of Tsushima Director\'s Cut') > 0.85);
  assert.ok(similarity('Bloodborne', 'Gran Turismo 7') < 0.4);
});

test('parses PS5 .exfat file names', () => {
  assert.deepEqual(parseExfatName('/x/PPSA22453-Tomb Raider Legend (v01.000.004).exfat'),
    { titleId: 'PPSA22453', title: 'Tomb Raider Legend', version: '01.000.004' });
  assert.deepEqual(parseExfatName('PPSA01864-LEGO® Star Wars™ The Skywalker Saga (v01.010.000).exfat'),
    { titleId: 'PPSA01864', title: 'LEGO® Star Wars™ The Skywalker Saga', version: '01.010.000' });
});

test('reads param.json and icon from inside an exFAT image', { skip: !hasMkfs && 'mkfs.exfat not installed' }, async () => {
  const file = path.join(process.env.GV_DATA_DIR, 'PPSA16716-The Smurfs 2 - The Prisoner of the Gree (v01.000.000).exfat');
  ps5Exfat(file, { title: 'The Smurfs 2 - The Prisoner of the Green Stone', titleId: 'PPSA16716', version: '01.000.002' });
  const g = await readExfatGame(file);
  assert.equal(g.param.titleId, 'PPSA16716');
  assert.ok(g.icon.length > 0);
  const meta = await readPs5Exfat(file, readExfatGame);
  assert.equal(meta.title, 'The Smurfs 2 - The Prisoner of the Green Stone');
  assert.equal(meta.version, '01.000.002');
});

test('falls back to the file name when the image cannot be read', async () => {
  const file = path.join(process.env.GV_DATA_DIR, 'PPSA03969-F.I.S.T. Forged In Shadow Torch (v01.201.001).exfat');
  fs.writeFileSync(file, Buffer.alloc(4096));
  const meta = await readPs5Exfat(file, readExfatGame);
  assert.equal(meta.titleId, 'PPSA03969');
  assert.equal(meta.title, 'F.I.S.T. Forged In Shadow Torch');
  assert.equal(meta.version, '01.201.001');
});
