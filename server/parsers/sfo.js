/**
 * Parses a PlayStation param.sfo (PSF) buffer into a plain object.
 * Layout: "\0PSF" magic, version, key table offset, data table offset, entry count,
 * then 16-byte index entries (key offset u16, format u16, length u32, max length u32, data offset u32).
 */
export function parseSfo(buf) {
  if (!buf || buf.length < 20 || buf.readUInt32BE(0) !== 0x00505346) {
    throw new Error('Not a param.sfo file');
  }
  const keyTable = buf.readUInt32LE(8);
  const dataTable = buf.readUInt32LE(12);
  const count = buf.readUInt32LE(16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const base = 20 + i * 16;
    if (base + 16 > buf.length) break;
    const keyOffset = buf.readUInt16LE(base);
    const fmt = buf.readUInt16LE(base + 2);
    const len = buf.readUInt32LE(base + 4);
    const dataOffset = buf.readUInt32LE(base + 12);

    const keyStart = keyTable + keyOffset;
    const keyEnd = buf.indexOf(0, keyStart);
    const key = buf.toString('utf8', keyStart, keyEnd < 0 ? undefined : keyEnd);

    const start = dataTable + dataOffset;
    if (fmt === 0x0404) {
      out[key] = buf.readUInt32LE(start);
    } else {
      // 0x0204 = null-terminated UTF-8, 0x0004 = raw UTF-8
      out[key] = buf.toString('utf8', start, start + len).replace(/\0+$/, '');
    }
  }
  return out;
}

/**
 * Firmware a title needs, as "7.00".
 * PS5 param.json: requiredSystemSoftwareVersion "0x0700000000000000" (BCD).
 * PS4 param.sfo: SYSTEM_VER 0x05050000 (BCD).
 */
export function firmwareFromPs5(value) {
  if (value == null) return null;
  const hex = String(value).replace(/^0x/i, '').padStart(16, '0');
  if (!/^[0-9a-f]{16}$/i.test(hex)) return null;
  const major = Number(hex.slice(0, 2));
  const minor = hex.slice(2, 4);
  if (!Number.isFinite(major) || !/^\d\d$/.test(minor) || (major === 0 && minor === '00')) return null;
  return `${major}.${minor}`;
}

export function firmwareFromPs4(value) {
  if (typeof value !== 'number' || !value) return null;
  const hex = value.toString(16).padStart(8, '0');
  const major = Number(hex.slice(0, 2));
  const minor = hex.slice(2, 4);
  if (!Number.isFinite(major) || !/^\d\d$/.test(minor)) return null;
  return `${major}.${minor}`;
}

/** Compares "7.00" style versions. */
export function compareFirmware(a, b) {
  const [am, an] = String(a).split('.').map(Number);
  const [bm, bn] = String(b).split('.').map(Number);
  return (am - bm) || ((an || 0) - (bn || 0));
}
