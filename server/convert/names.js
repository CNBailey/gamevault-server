/**
 * Library file names, shared by the conversion service and the "tidy names" tool:
 *
 *   PPSA01417-Marvel's Spider-Man Miles Morales (v01.015.001).exfat
 *   CUSA00021-WATCH_DOGS (v01.00).pkg
 *   CUSA00021-WATCH_DOGS (v01.09) patch.pkg      (PS4 update, so the library groups it with its game)
 *   CUSA00021-WATCH_DOGS (v01.00) dlc.pkg        (PS4 add-on)
 *
 * The title ID, version, suffix and extension are never shortened; only the title is,
 * on a character boundary, so the name (without extension) stays within `maxStemBytes`.
 * ShadowMountPlus cannot mount a PS5 image whose name is longer than 63 bytes.
 */

const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f]/g;

export function cleanTitleForFile(title) {
  return String(title || '')
    .replace(/[®™©℠]/g, '')
    .replace(ILLEGAL, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s.]+$/g, '')
    .trim();
}

const bytes = (s) => Buffer.byteLength(s, 'utf8');

export function libraryName({ titleId, title, version, suffix = '', ext, maxStemBytes = 63 }) {
  const id = String(titleId || '').toUpperCase();
  if (!/^(CUSA|PPSA)\d{5}$/.test(id)) throw new Error(`Missing or invalid title ID (${titleId || 'none'})`);
  const v = version && !/^unknown$/i.test(version) ? ` (v${String(version).replace(ILLEGAL, '')})` : '';
  const tail = `${v}${suffix}`;
  let t = cleanTitleForFile(title);
  const fixed = bytes(`${id}-`) + bytes(tail);
  if (fixed > maxStemBytes) return `${id}${ext}`;
  if (!t) return `${id}${tail}${ext}`;
  const chars = [...t];
  while (chars.length && bytes(chars.join('')) + fixed > maxStemBytes) chars.pop();
  t = chars.join('').replace(/[\s.\-–:]+$/g, '').trim();
  return t ? `${id}-${t}${tail}${ext}` : `${id}${tail}${ext}`;
}

/** PS4: suffix by PKG category (gp = update, ac = add-on). */
export function ps4Suffix(category) {
  if (category === 'gp') return ' patch';
  if (category === 'ac') return ' dlc';
  return '';
}

/** Adds " (2)", " (3)"… before the extension until `exists(name)` is false. */
export function uniqueName(name, exists) {
  if (!exists(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`No free name for ${name}`);
}
