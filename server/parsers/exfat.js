import fs from 'node:fs/promises';

/**
 * Minimal read-only exFAT reader: enough to list directories and read small files
 * (sce_sys/param.json, icon0.png) from inside a PS5 .exfat game image without
 * mounting it. Only the boot sector, FAT and directory clusters are read, so it is
 * fast even for 100 GB images.
 */

const MAX_SMALL_FILE = 8 * 1024 * 1024;
const MAX_DIR_BYTES = 4 * 1024 * 1024;

export async function openExfat(file) {
  const fh = await fs.open(file, 'r');
  const read = async (offset, length) => {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return buf.subarray(0, bytesRead);
  };

  let base = 0;
  let boot = await read(0, 512);
  if (boot.toString('ascii', 3, 11) !== 'EXFAT   ') {
    // Image with an MBR: use the first partition.
    if (boot.length === 512 && boot.readUInt16LE(510) === 0xaa55) {
      const lba = boot.readUInt32LE(446 + 8);
      base = lba * 512;
      boot = await read(base, 512);
    }
    if (boot.toString('ascii', 3, 11) !== 'EXFAT   ') {
      await fh.close();
      throw new Error('Not an exFAT image');
    }
  }

  const bpsShift = boot.readUInt8(0x6c);
  const spcShift = boot.readUInt8(0x6d);
  if (bpsShift < 9 || bpsShift > 12 || bpsShift + spcShift > 25) {
    await fh.close();
    throw new Error('exFAT boot sector looks corrupt');
  }
  const bytesPerSector = 1 << bpsShift;
  const clusterSize = 1 << (bpsShift + spcShift);
  const fatOffset = base + boot.readUInt32LE(0x50) * bytesPerSector;
  const heapOffset = base + boot.readUInt32LE(0x58) * bytesPerSector;
  const clusterCount = boot.readUInt32LE(0x5c);
  const rootCluster = boot.readUInt32LE(0x60);

  const clusterOffset = (c) => heapOffset + (c - 2) * clusterSize;
  const validCluster = (c) => c >= 2 && c < clusterCount + 2;

  async function nextCluster(c) {
    const b = await read(fatOffset + c * 4, 4);
    return b.length === 4 ? b.readUInt32LE(0) : 0xffffffff;
  }

  /** Reads `length` bytes of a cluster chain (contiguous when noFatChain). */
  async function readChain(first, length, noFatChain) {
    if (!validCluster(first) || length <= 0) return Buffer.alloc(0);
    if (noFatChain) return read(clusterOffset(first), length);
    const parts = [];
    let left = length;
    let c = first;
    let guard = 0;
    while (left > 0 && validCluster(c) && guard++ < 100000) {
      const chunk = Math.min(left, clusterSize);
      parts.push(await read(clusterOffset(c), chunk));
      left -= chunk;
      if (left > 0) c = await nextCluster(c);
    }
    return Buffer.concat(parts);
  }

  function parseEntries(buf) {
    const out = [];
    for (let i = 0; i + 32 <= buf.length; i += 32) {
      const type = buf[i];
      if (type === 0x00) break;               // end of directory
      if (type !== 0x85) continue;            // only in-use File entries start a set
      const secondary = buf[i + 1];
      const attrs = buf.readUInt16LE(i + 4);
      const stream = i + 32;
      if (stream + 32 > buf.length || buf[stream] !== 0xc0) continue;
      const flags = buf[stream + 1];
      const nameLength = buf[stream + 3];
      const firstCluster = buf.readUInt32LE(stream + 20);
      const dataLength = Number(buf.readBigUInt64LE(stream + 24));
      let name = '';
      for (let n = 2; n <= secondary && name.length < nameLength; n++) {
        const e = i + n * 32;
        if (e + 32 > buf.length || buf[e] !== 0xc1) break;
        name += buf.toString('utf16le', e + 2, e + 32);
      }
      out.push({
        name: name.slice(0, nameLength),
        isDir: (attrs & 0x10) !== 0,
        firstCluster,
        size: dataLength,
        noFatChain: (flags & 0x02) !== 0
      });
      i += secondary * 32;
    }
    return out;
  }

  async function listRoot() {
    // The root directory has no size field: follow its FAT chain.
    const parts = [];
    let c = rootCluster;
    let total = 0;
    while (validCluster(c) && total < MAX_DIR_BYTES) {
      parts.push(await read(clusterOffset(c), clusterSize));
      total += clusterSize;
      c = await nextCluster(c);
    }
    return parseEntries(Buffer.concat(parts));
  }

  async function listDir(entry) {
    if (!entry.isDir) return [];
    return parseEntries(await readChain(entry.firstCluster, Math.min(entry.size, MAX_DIR_BYTES), entry.noFatChain));
  }

  async function readFile(entry) {
    if (entry.isDir || entry.size > MAX_SMALL_FILE) return null;
    return readChain(entry.firstCluster, entry.size, entry.noFatChain);
  }

  return { listRoot, listDir, readFile, close: () => fh.close() };
}

const findName = (entries, name) => entries.find((e) => e.name.toLowerCase() === name.toLowerCase());

/**
 * Finds sce_sys/ in the image root (or one folder down) and returns param.json
 * plus icon0.png / pic0.png when present.
 */
export async function readExfatGame(file) {
  const img = await openExfat(file);
  try {
    const root = await img.listRoot();
    let sceSys = findName(root, 'sce_sys');
    if (!sceSys) {
      for (const dir of root.filter((e) => e.isDir).slice(0, 8)) {
        sceSys = findName(await img.listDir(dir), 'sce_sys');
        if (sceSys) break;
      }
    }
    if (!sceSys) return null;
    const files = await img.listDir(sceSys);
    const get = async (n) => {
      const e = findName(files, n);
      return e ? img.readFile(e) : null;
    };
    const paramBuf = await get('param.json');
    return {
      param: paramBuf ? JSON.parse(paramBuf.toString('utf8').replace(/^﻿/, '')) : null,
      icon: await get('icon0.png'),
      backdrop: await get('pic0.png')
    };
  } finally {
    await img.close();
  }
}
