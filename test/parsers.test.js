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

test('recognises PS4 patches', async () => {
  const { isPatch } = await import('../server/scanner.js');
  const pkg = (category) => ({ kind: 'ps4-pkg', pkgs: [{ category }] });
  assert.equal(isPatch('/g/Hades patch.pkg', pkg('gd')), true);
  assert.equal(isPatch('/g/Hades PATCH', pkg('gd')), true);
  assert.equal(isPatch('/g/Hades v1.10.pkg', pkg('gp')), true);
  assert.equal(isPatch('/g/Hades.pkg', pkg('gd')), false);
  assert.equal(isPatch('/g/Dispatch.exfat', { kind: 'ps5-exfat', pkgs: [] }), false);
});

test('cleans titles before searching IGDB', async () => {
  const { searchTitle, searchVariants } = await import('../server/scraper.js');
  assert.equal(searchTitle('Borderlands®4'), 'Borderlands 4');
  assert.equal(searchTitle('WATCH_DOGS® 2'), 'WATCH DOGS 2');
  assert.equal(searchTitle('Aliens: Fireteam Elite (PS5)'), 'Aliens: Fireteam Elite');
  assert.equal(searchTitle('[PROTOTYPE® BIOHAZARD BUNDLE]'), 'PROTOTYPE BIOHAZARD BUNDLE');
  assert.equal(searchTitle('LEGO® Star Wars™: The Skywalker Saga'), 'LEGO Star Wars: The Skywalker Saga');
  assert.equal(searchTitle('Call of Duty®: Vanguard'), 'Call of Duty: Vanguard');
  assert.deepEqual(searchVariants('Far Cry® 3 Classic Edition'), ['Far Cry 3 Classic Edition', 'Far Cry 3']);
  assert.deepEqual(searchVariants('God of War® III Remastered'), ['God of War III Remastered', 'God of War III']);
  assert.ok(searchVariants('PROTOTYPE® BIOHAZARD BUNDLE').includes('PROTOTYPE BIOHAZARD'));
  assert.deepEqual(searchVariants('Watch Dogs®: Legion'), ['Watch Dogs: Legion', 'Watch Dogs']);
});

test('remembers manual matches by title ID', async () => {
  const { db, setSetting } = await import('../server/db.js');
  const { matchGame, scrapeGame, resetToken } = await import('../server/scraper.js');
  setSetting('igdb_client_id', 'test-id');
  setSetting('igdb_client_secret', 'test-secret');
  resetToken();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body });
    const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('oauth2/token')) return json({ access_token: 't', expires_in: 3600 });
    if (String(url).endsWith('/games')) return json([{ id: 4242, name: 'Call of Duty: Modern Warfare II' }]);
    return new Response('[]', { status: 404 });
  };
  try {
    const add = (p) => Number(db.prepare("INSERT INTO games (path, kind, platform, title_id, local_title, added_at) VALUES (?, 'ps5-exfat', 'PS5', 'PPSA01649', 'Call of Duty®', datetime())").run(p).lastInsertRowid);
    const first = add('/g/a.exfat');
    await matchGame(first, 4242);
    const second = add('/g/PPSA01649-Call of Duty (v01.056.000).exfat');
    calls.length = 0;
    await scrapeGame(second);
    const row = db.prepare('SELECT igdb_id, title, match_status FROM games WHERE id = ?').get(second);
    assert.deepEqual([row.igdb_id, row.title, row.match_status], [4242, 'Call of Duty: Modern Warfare II', 'manual']);
    assert.ok(calls.every((c) => !/search/.test(c.body || '')), 'no name search was needed');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('library file names', async () => {
  const { libraryName, uniqueName } = await import('../server/convert/names.js');
  assert.equal(libraryName({ titleId: 'PPSA01417', title: "Marvel's Spider-Man: Miles Morales", version: '01.015.001', ext: '.exfat' }),
    "PPSA01417-Marvel's Spider-Man  Miles Morales (v01.015.001).exfat".replace('  ', ' '));
  assert.equal(libraryName({ titleId: 'CUSA00021', title: 'WATCH_DOGS™', version: '01.09', suffix: ' patch', ext: '.pkg', maxStemBytes: 150 }),
    'CUSA00021-WATCH_DOGS (v01.09) patch.pkg');
  const long = libraryName({ titleId: 'PPSA16716', title: 'The Smurfs 2 - The Prisoner of the Green Stone', version: '01.000.000', ext: '.exfat' });
  assert.ok(Buffer.byteLength(long.replace(/\.exfat$/, '')) <= 63, long);
  assert.ok(long.endsWith(' (v01.000.000).exfat') && long.startsWith('PPSA16716-The Smurfs 2'));
  assert.equal(libraryName({ titleId: 'PPSA01556', title: 'Resident Evil Village', version: 'unknown', ext: '.exfat' }), 'PPSA01556-Resident Evil Village.exfat');
  assert.equal(libraryName({ titleId: 'PPSA00001', title: 'A/B: C*D?', version: '01.000.000', ext: '.exfat' }), 'PPSA00001-A B C D (v01.000.000).exfat');
  assert.throws(() => libraryName({ titleId: 'nope', title: 'x', ext: '.pkg' }));
  assert.equal(uniqueName('a.exfat', (n) => n === 'a.exfat'), 'a (2).exfat');
});

test('exact match through GarlicSaves concept number, with fallbacks', async () => {
  const { db, setSetting } = await import('../server/db.js');
  const { scrapeGame, resetToken } = await import('../server/scraper.js');
  const { setGarlicEnabled, garlicStatus } = await import('../server/garlicsaves.js');
  setSetting('igdb_client_id', 'test-id');
  setSetting('igdb_client_secret', 'test-secret');
  resetToken();
  let garlic = 'ok';
  const calls = [];
  const realFetch = globalThis.fetch;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ u, body: opts?.body });
    if (u.includes('oauth2/token')) return json({ access_token: 't', expires_in: 3600 });
    if (u.includes('garlicsaves.com')) {
      if (garlic === 'blocked') return new Response('<html>Just a moment...</html>', { status: 403, headers: { 'content-type': 'text/html' } });
      return json({ results: [{ concept_id: 233064, name: 'Back 4 Blood', platform: 'ps5', region: 'US', title_id: 'PPSA01695' }] });
    }
    if (u.endsWith('/external_games')) return json(/uid = "233064"/.test(opts.body) ? [{ id: 1, game: 116200 }] : []);
    if (u.endsWith('/games')) {
      if (/where id = \(116200\)/.test(opts.body)) return json([{ id: 116200, name: 'Back 4 Blood', platforms: [167] }]);
      return json([{ id: 555, name: 'Back 4 Blood', platforms: [167] }]);  // name search
    }
    return new Response('[]', { status: 404 });
  };
  const add = (p, tid) => Number(db.prepare("INSERT INTO games (path, kind, platform, title_id, local_title, added_at) VALUES (?, 'ps5-exfat', 'PS5', ?, 'Back 4 Blood', datetime())").run(p, tid).lastInsertRowid);
  const status = (id) => db.prepare('SELECT igdb_id, match_status FROM games WHERE id = ?').get(id);
  try {
    const a = add('/g/b4b.exfat', 'PPSA01695');
    await scrapeGame(a);
    assert.deepEqual({ ...status(a) }, { igdb_id: 116200, match_status: 'exact' });
    assert.equal(calls.filter((c) => c.u.includes('garlicsaves')).length, 1);
    // Cached: a second game with the same ID does not ask GarlicSaves again.
    calls.length = 0;
    await scrapeGame(add('/g/b4b2.exfat', 'PPSA01695'));
    assert.equal(calls.filter((c) => c.u.includes('garlicsaves')).length, 0);

    // Switched off: name search only.
    setGarlicEnabled(false);
    calls.length = 0;
    const b = add('/g/other.exfat', 'PPSA01696');
    await scrapeGame(b);
    assert.equal(calls.filter((c) => c.u.includes('garlicsaves')).length, 0);
    assert.equal(status(b).igdb_id, 555);

    // Blocked: falls back to the name search and reports the problem.
    setGarlicEnabled(true);
    garlic = 'blocked';
    const c = add('/g/third.exfat', 'PPSA01697');
    await scrapeGame(c);
    assert.equal(status(c).igdb_id, 555);
    assert.equal(garlicStatus().ok, false);
    assert.match(garlicStatus().message, /refused/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('recognises homebrew apps and skips their lookups', async () => {
  const { db, isAppRow } = await import('../server/db.js');
  const { scrapeGame } = await import('../server/scraper.js');
  assert.equal(isAppRow({ title_id: 'PPSA99420', platform: 'PS5' }), true);
  assert.equal(isAppRow({ title_id: 'CUSA99999', platform: 'PS4' }), true);
  assert.equal(isAppRow({ title_id: 'LAPY10010', platform: 'PS4' }), true);
  assert.equal(isAppRow({ title_id: 'PPSA01649', platform: 'PS5', kind: 'ps5-exfat', category: '0' }), false);
  assert.equal(isAppRow({ title_id: 'PPSA01649', platform: 'PS5', kind: 'ps5-exfat', category: '65536' }), true);
  assert.equal(isAppRow({ title_id: 'CUSA05332', platform: 'PS4', kind: 'ps4-pkg', category: 'gd' }), false);
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => { called = true; return new Response('[]'); };
  try {
    const id = Number(db.prepare("INSERT INTO games (path, kind, platform, title_id, local_title, added_at) VALUES ('/g/kodi.exfat', 'ps5-exfat', 'PS5', 'PPSA99420', 'PS5MC (Kodi 22)', datetime())").run().lastInsertRowid);
    await scrapeGame(id);
    assert.equal(called, false, 'no network lookups for apps');
    assert.equal(db.prepare('SELECT match_status FROM games WHERE id = ?').get(id).match_status, 'app');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('required firmware from param.json and param.sfo', async () => {
  const { firmwareFromPs5, firmwareFromPs4, compareFirmware } = await import('../server/parsers/sfo.js');
  assert.equal(firmwareFromPs5('0x0700000000000000'), '7.00');
  assert.equal(firmwareFromPs5('0x1002000000000000'), '10.02');
  assert.equal(firmwareFromPs5('0x0960000000000000'), '9.60');
  assert.equal(firmwareFromPs5(undefined), null);
  assert.equal(firmwareFromPs5('nonsense'), null);
  assert.equal(firmwareFromPs4(0x05050000), '5.05');
  assert.equal(firmwareFromPs4(0x11000000), '11.00');
  assert.ok(compareFirmware('10.00', '9.60') > 0);
  assert.ok(compareFirmware('7.00', '9.60') < 0);
  assert.equal(compareFirmware('9.60', '9.60'), 0);
});
