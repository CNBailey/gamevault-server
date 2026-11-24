import fs from 'node:fs/promises';
import { parseSfo, firmwareFromPs4 } from './sfo.js';

const PKG_MAGIC = 0x7f434e54; // "\x7FCNT"
const ENTRY_PARAM_SFO = 0x1000;
const ENTRY_ICON0 = 0x1200;
const ENTRY_PIC1 = 0x1241;   // larger background image, when present
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

async function readAt(fh, offset, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, offset);
  return buf.subarray(0, bytesRead);
}

/**
 * Reads the metadata of a PS4 .pkg without loading the whole file:
 * header, entry table, param.sfo and (optionally) icon0.png / pic1.png.
 */
export async function readPkg(file, { images = false } = {}) {
  const fh = await fs.open(file, 'r');
  try {
    const header = await readAt(fh, 0, 0x100);
    if (header.length < 0x64 || header.readUInt32BE(0) !== PKG_MAGIC) {
      throw new Error('Not a PS4 PKG');
    }
    const entryCount = header.readUInt32BE(0x10);
    const tableOffset = header.readUInt32BE(0x18);
    const contentIdHeader = header.toString('ascii', 0x40, 0x64).replace(/\0+$/, '');

    if (entryCount > 100000) throw new Error('PKG entry table looks corrupt');
    const table = await readAt(fh, tableOffset, entryCount * 32);
    const entries = new Map();
    for (let i = 0; i < entryCount; i++) {
      const b = i * 32;
      if (b + 32 > table.length) break;
      const id = table.readUInt32BE(b);
      const flags1 = table.readUInt32BE(b + 8);
      const offset = table.readUInt32BE(b + 16);
      const size = table.readUInt32BE(b + 20);
      entries.set(id, { offset, size, encrypted: (flags1 & 0x80000000) !== 0 });
    }

    const readEntry = async (id) => {
      const e = entries.get(id);
      if (!e || e.encrypted || e.size === 0 || e.size > MAX_ENTRY_BYTES) return null;
      return readAt(fh, e.offset, e.size);
    };

    const sfoBuf = await readEntry(ENTRY_PARAM_SFO);
    const sfo = sfoBuf ? parseSfo(sfoBuf) : {};
    const result = {
      contentId: sfo.CONTENT_ID || contentIdHeader || null,
      titleId: sfo.TITLE_ID || (contentIdHeader ? contentIdHeader.slice(7, 16) : null),
      title: sfo.TITLE || null,
      version: sfo.APP_VER || sfo.VERSION || null,
      category: sfo.CATEGORY || null, // gd = game, gp = patch, ac = add-on
      requiredFw: firmwareFromPs4(sfo.SYSTEM_VER)
    };
    if (images) {
      result.icon0 = await readEntry(ENTRY_ICON0);
      result.pic1 = await readEntry(ENTRY_PIC1);
    }
    return result;
  } finally {
    await fh.close();
  }
}
