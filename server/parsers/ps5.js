import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSfo } from './sfo.js';

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function fromParamJson(json) {
  const lp = json.localizedParameters || {};
  const lang = lp.defaultLanguage || 'en-US';
  const localized = lp[lang] || lp['en-US'] || lp['en-GB'] || Object.values(lp).find((v) => v && v.titleName) || {};
  return {
    titleId: json.titleId || null,
    contentId: json.contentId || null,
    version: json.contentVersion || json.masterVersion || null,
    category: json.applicationCategoryType != null ? String(json.applicationCategoryType) : null,
    title: localized.titleName || null
  };
}

/** "PPSA22453-Tomb Raider Legend (v01.000.004).exfat" */
export function parseExfatName(file) {
  const base = path.basename(file).replace(/\.exfat$/i, '');
  const m = /^((?:PPSA|CUSA)\d{5})[-_ ]+(.*?)\s*(?:\(v?([\d.]+)\))?\s*$/i.exec(base);
  if (!m) return { titleId: null, title: base.trim(), version: null };
  return { titleId: m[1].toUpperCase(), title: m[2].trim() || null, version: m[3] || null };
}

/**
 * PS5 exFAT image (<name>.exfat). Details come from sce_sys/param.json inside the
 * image, falling back to the file name: "PPSA22453-Tomb Raider Legend (v01.000.004).exfat".
 */
export async function readPs5Exfat(file, readImage) {
  const fromName = parseExfatName(file);
  let image = {};
  let icon = null;
  let backdrop = null;
  try {
    const g = await readImage(file);
    if (g) {
      if (g.param) image = fromParamJson(g.param);
      icon = g.icon;
      backdrop = g.backdrop;
    }
  } catch { /* unreadable image: fall back to the name */ }

  const pick = (k) => image[k] || fromName[k] || null;
  return {
    platform: 'PS5',
    kind: 'ps5-exfat',
    titleId: pick('titleId'),
    contentId: pick('contentId'),
    version: pick('version'),
    category: image.category || null,
    title: pick('title'),
    iconBuf: icon,
    backdropBuf: backdrop
  };
}

/** PS5 folder dump: <game>/sce_sys/param.json */
export async function readPs5Folder(dir) {
  const file = path.join(dir, 'sce_sys', 'param.json');
  if (!(await exists(file))) return null;
  const json = JSON.parse(await fs.readFile(file, 'utf8'));
  const lp = json.localizedParameters || {};
  const lang = lp.defaultLanguage || 'en-US';
  const localized = lp[lang] || lp['en-US'] || lp['en-GB'] || Object.values(lp).find((v) => v && v.titleName) || {};
  return {
    platform: 'PS5',
    kind: 'ps5-folder',
    titleId: json.titleId || null,
    contentId: json.contentId || null,
    version: json.contentVersion || json.masterVersion || null,
    category: json.applicationCategoryType != null ? String(json.applicationCategoryType) : null,
    title: localized.titleName || null,
    icon: (await exists(path.join(dir, 'sce_sys', 'icon0.png'))) ? path.join(dir, 'sce_sys', 'icon0.png') : null,
    backdrop: (await exists(path.join(dir, 'sce_sys', 'pic0.png'))) ? path.join(dir, 'sce_sys', 'pic0.png') : null
  };
}

/** PS4 folder dump (extracted game): <game>/sce_sys/param.sfo */
export async function readPs4Folder(dir) {
  const file = path.join(dir, 'sce_sys', 'param.sfo');
  if (!(await exists(file))) return null;
  const sfo = parseSfo(await fs.readFile(file));
  const icon = path.join(dir, 'sce_sys', 'icon0.png');
  const pic = path.join(dir, 'sce_sys', 'pic1.png');
  return {
    platform: 'PS4',
    kind: 'ps4-folder',
    titleId: sfo.TITLE_ID || null,
    contentId: sfo.CONTENT_ID || null,
    version: sfo.APP_VER || sfo.VERSION || null,
    category: sfo.CATEGORY || null,
    title: sfo.TITLE || null,
    icon: (await exists(icon)) ? icon : null,
    backdrop: (await exists(pic)) ? pic : null
  };
}
