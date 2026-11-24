// Test helper: adds folders and files to an empty exFAT image created by mkfs.exfat,
// updating the allocation bitmap and FAT, so the image passes fsck.exfat.
import fs from 'node:fs';

export function addToExfat(imagePath, tree) {
  const img = fs.readFileSync(imagePath);
  const bps = 1 << img[0x6c];
  const cs = bps << img[0x6d];
  const fatOff = img.readUInt32LE(0x50) * bps;
  const heapOff = img.readUInt32LE(0x58) * bps;
  const count = img.readUInt32LE(0x5c);
  const root = img.readUInt32LE(0x60);
  const co = (c) => heapOff + (c - 2) * cs;

  // Allocation bitmap from the root directory's 0x81 entry
  let bitmap = null;
  for (let i = co(root); i < co(root) + cs; i += 32) if (img[i] === 0x81) bitmap = co(img.readUInt32LE(i + 20));
  const used = (c) => (img[bitmap + ((c - 2) >> 3)] >> ((c - 2) & 7)) & 1;
  const mark = (c) => { img[bitmap + ((c - 2) >> 3)] |= 1 << ((c - 2) & 7); };
  let cursor = 2;
  const alloc = (n, { spread = false } = {}) => {
    const got = [];
    while (got.length < n) {
      if (cursor >= count + 2) throw new Error('image full');
      if (!used(cursor)) { mark(cursor); got.push(cursor); if (spread) cursor++; }
      cursor++;
    }
    return got;
  };
  const chain = (cl) => cl.forEach((c, i) => img.writeUInt32LE(i + 1 < cl.length ? cl[i + 1] : 0xffffffff, fatOff + c * 4));

  const hashName = (name) => {
    let h = 0;
    for (const ch of name.toUpperCase()) {
      const code = ch.charCodeAt(0);
      for (const b of [code & 0xff, code >> 8]) h = (((h << 15) | (h >> 1)) + b) & 0xffff;
    }
    return h;
  };

  function entrySet(name, isDir, firstCluster, size, noFat) {
    const nameEntries = Math.ceil(name.length / 15);
    const buf = Buffer.alloc(32 * (2 + nameEntries));
    buf[0] = 0x85; buf[1] = 1 + nameEntries; buf.writeUInt16LE(isDir ? 0x10 : 0x20, 4);
    const s = 32;
    buf[s] = 0xc0; buf[s + 1] = 0x01 | (noFat ? 0x02 : 0); buf[s + 3] = name.length;
    buf.writeUInt16LE(hashName(name), s + 4);
    buf.writeBigUInt64LE(BigInt(size), s + 8); buf.writeUInt32LE(firstCluster, s + 20); buf.writeBigUInt64LE(BigInt(size), s + 24);
    for (let n = 0; n < nameEntries; n++) {
      const e = 64 + n * 32;
      buf[e] = 0xc1;
      buf.write(name.slice(n * 15, n * 15 + 15), e + 2, 'utf16le');
    }
    let sum = 0;
    for (let i = 0; i < buf.length; i++) if (i !== 2 && i !== 3) sum = (((sum << 15) | (sum >> 1)) + buf[i]) & 0xffff;
    buf.writeUInt16LE(sum, 2);
    return buf;
  }

  // Writes the tree into a directory whose clusters are `dirClusters`.
  function writeDir(dirClusters, node, startSlot = 0) {
    const sets = [];
    for (const [name, value] of Object.entries(node)) {
      if (Buffer.isBuffer(value) || typeof value === 'string') {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const n = Math.max(1, Math.ceil(data.length / cs));
        const fragmented = name.endsWith('.png'); // exercise FAT chains too
        const cl = alloc(n, { spread: fragmented });
        cl.forEach((c, i) => data.copy(img, co(c), i * cs, Math.min(data.length, (i + 1) * cs)));
        if (fragmented) chain(cl);
        sets.push(entrySet(name, false, data.length ? cl[0] : 0, data.length, !fragmented));
      } else {
        const entries = Object.keys(value).reduce((t, k) => t + 2 + Math.ceil(k.length / 15), 0);
        const n = Math.max(1, Math.ceil((entries * 32) / cs));
        const cl = alloc(n);
        cl.forEach((c) => img.fill(0, co(c), co(c) + cs));
        writeDir(cl, value);
        sets.push(entrySet(name, true, cl[0], n * cs, true));
      }
    }
    const all = Buffer.concat(sets);
    let slot = startSlot * 32;
    for (let i = 0; i < all.length; i += 32, slot += 32) {
      const c = dirClusters[Math.floor(slot / cs)];
      all.copy(img, co(c) + (slot % cs), i, i + 32);
    }
  }

  // Free slot in the root directory after mkfs's own entries
  let slot = 0;
  while (img[co(root) + slot * 32] !== 0) slot++;
  writeDir([root], tree, slot);
  fs.writeFileSync(imagePath, img);
}
