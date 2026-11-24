// Creates a fake library of PS4 PKGs and PS5 folder dumps for local testing.
// Usage: node test/make-fixtures.js [outDir]   (default ./.fixtures)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { addToExfat } from './exfat-image.js';

const out = path.resolve(process.argv[2] || '.fixtures');

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

export function buildSfo(entries) {
  const keys = Object.keys(entries);
  let keyTable = Buffer.alloc(0);
  let dataTable = Buffer.alloc(0);
  const index = Buffer.alloc(16 * keys.length);
  keys.forEach((k, i) => {
    const v = entries[k];
    const keyOff = keyTable.length;
    keyTable = Buffer.concat([keyTable, Buffer.from(k + '\0', 'utf8')]);
    const dataOff = dataTable.length;
    let data;
    let fmt;
    if (typeof v === 'number') { data = Buffer.alloc(4); data.writeUInt32LE(v); fmt = 0x0404; }
    else { data = Buffer.from(v + '\0', 'utf8'); fmt = 0x0204; }
    const max = Math.ceil(data.length / 4) * 4;
    dataTable = Buffer.concat([dataTable, data, Buffer.alloc(max - data.length)]);
    index.writeUInt16LE(keyOff, i * 16);
    index.writeUInt16LE(fmt, i * 16 + 2);
    index.writeUInt32LE(data.length, i * 16 + 4);
    index.writeUInt32LE(max, i * 16 + 8);
    index.writeUInt32LE(dataOff, i * 16 + 12);
  });
  while (keyTable.length % 4) keyTable = Buffer.concat([keyTable, Buffer.alloc(1)]);
  const header = Buffer.alloc(20);
  header.writeUInt32BE(0x00505346, 0);
  header.writeUInt32LE(0x0101, 4);
  header.writeUInt32LE(20 + index.length, 8);
  header.writeUInt32LE(20 + index.length + keyTable.length, 12);
  header.writeUInt32LE(keys.length, 16);
  return Buffer.concat([header, index, keyTable, dataTable]);
}

export function buildPkg({ title, titleId, version = '01.00', category = 'gd', padMb = 2 }) {
  const contentId = `EP9000-${titleId}_00-${'0'.repeat(16)}`;
  const sfo = buildSfo({ APP_VER: version, CATEGORY: category, CONTENT_ID: contentId, TITLE: title, TITLE_ID: titleId });
  const header = Buffer.alloc(0x200);
  header.writeUInt32BE(0x7f434e54, 0);
  header.writeUInt32BE(2, 0x10);
  header.writeUInt32BE(0x200, 0x18);
  header.write(contentId, 0x40, 'ascii');
  const table = Buffer.alloc(0x200);
  const sfoOff = 0x400;
  const iconOff = sfoOff + sfo.length + 16;
  table.writeUInt32BE(0x1000, 0); table.writeUInt32BE(sfoOff, 16); table.writeUInt32BE(sfo.length, 20);
  table.writeUInt32BE(0x1200, 32); table.writeUInt32BE(iconOff, 48); table.writeUInt32BE(PNG.length, 52);
  const body = Buffer.alloc(iconOff + PNG.length + padMb * 1024 * 1024);
  header.copy(body, 0); table.copy(body, 0x200); sfo.copy(body, sfoOff); PNG.copy(body, iconOff);
  return body;
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

function ps5Dump(dir, { title, titleId, version = '01.000.000' }) {
  write(path.join(dir, 'sce_sys', 'param.json'), JSON.stringify({
    titleId, contentId: `EP9000-${titleId}_00-${'0'.repeat(16)}`, contentVersion: version, applicationCategoryType: 0,
    localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: title } }
  }, null, 2));
  write(path.join(dir, 'sce_sys', 'icon0.png'), PNG);
  write(path.join(dir, 'eboot.bin'), Buffer.alloc(1024 * 1024, 7));
  write(path.join(dir, 'data', 'level1.dat'), Buffer.alloc(512 * 1024, 1));
}

/** A PS5 .exfat game image; falls back to an unreadable blob when mkfs.exfat is missing. */
export function ps5Exfat(file, { title, titleId, version = '01.000.000' }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(file, { force: true });
  try {
    fs.writeFileSync(file, Buffer.alloc(0));
    fs.truncateSync(file, 16 * 1024 * 1024);
    execFileSync('mkfs.exfat', ['-q', file], { stdio: 'ignore' });
    addToExfat(file, {
      sce_sys: {
        'param.json': JSON.stringify({ titleId, contentId: `EP9000-${titleId}_00-${'0'.repeat(16)}`, contentVersion: version, localizedParameters: { defaultLanguage: 'en-US', 'en-US': { titleName: title } } }),
        'icon0.png': PNG
      },
      'eboot.bin': Buffer.alloc(64 * 1024, 7)
    });
  } catch {
    fs.writeFileSync(file, Buffer.alloc(1024 * 1024));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  fs.rmSync(out, { recursive: true, force: true });
  ps5Dump(path.join(out, 'PS5', 'Astro Bot'), { title: 'ASTRO BOT', titleId: 'PPSA00001' });
  ps5Dump(path.join(out, 'PS5', 'Returnal [PPSA00002]'), { title: 'Returnal™', titleId: 'PPSA00002' });
  ps5Dump(path.join(out, 'PS5', 'Shooters', 'dump_0412'), { title: '', titleId: 'PPSA00003' });
  ps5Exfat(path.join(out, 'PS5', 'PPSA22453-Tomb Raider Legend (v01.000.004).exfat'), { title: 'Tomb Raider: Legend', titleId: 'PPSA22453', version: '01.000.004' });
  ps5Exfat(path.join(out, 'PS5', 'PPSA16716-The Smurfs 2 - The Prisoner of the Gree (v01.000.000).exfat'), { title: 'The Smurfs 2 - The Prisoner of the Green Stone', titleId: 'PPSA16716' });
  // Not a real image: details must come from the file name.
  write(path.join(out, 'PS5', 'PPSA01864-LEGO® Star Wars™ The Skywalker Saga (v01.010.000).exfat'), Buffer.alloc(256 * 1024));
  write(path.join(out, 'PS5', '@eaDir', 'junk'), Buffer.from('synology thumbnail cache'));

  write(path.join(out, 'PS4', 'Bloodborne', 'Bloodborne_CUSA00001.pkg'), buildPkg({ title: 'Bloodborne™', titleId: 'CUSA00001' }));
  write(path.join(out, 'PS4', 'Bloodborne', 'updates', 'Bloodborne_v1.09.pkg'), buildPkg({ title: 'Bloodborne™', titleId: 'CUSA00001', version: '01.09', category: 'gp', padMb: 1 }));
  write(path.join(out, 'PS4', 'Hades [CUSA00002].pkg'), buildPkg({ title: 'Hades', titleId: 'CUSA00002' }));
  // Loose patches next to their games, matched by title ID or by name ("... patch").
  write(path.join(out, 'PS4', 'Hades [CUSA00002] patch.pkg'), buildPkg({ title: 'Hades', titleId: 'CUSA00002', version: '01.10', category: 'gp', padMb: 1 }));
  write(path.join(out, 'PS4', 'Ghost of Tsushima Patch', 'GoT_v2.pkg'), buildPkg({ title: 'Ghost of Tsushima', titleId: 'CUSA99999', version: '02.00', category: 'gd', padMb: 1 }));
  write(path.join(out, 'PS4', 'Some Other Game patch.pkg'), buildPkg({ title: 'Some Other Game', titleId: 'CUSA77777', version: '01.01', category: 'gp', padMb: 0 }));
  write(path.join(out, 'PS4', 'Action', 'Ghost of Tsushima', 'GoT.pkg'), buildPkg({ title: 'Ghost of Tsushima', titleId: 'CUSA00003' }));
  console.log(`Fixtures written to ${out}`);
}
