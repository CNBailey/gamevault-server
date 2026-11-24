import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildPkg, buildSfo } from './make-fixtures.js';
import { parseSfo } from '../server/parsers/sfo.js';
import { readPkg } from '../server/parsers/pkg.js';

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
