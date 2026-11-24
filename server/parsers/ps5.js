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

/** Breadth-first search for the first key (case-insensitive) with a string value. */
function findKey(obj, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const queue = [obj];
  let guard = 0;
  while (queue.length && guard++ < 2000) {
    const cur = queue.shift();
    if (!cur || typeof cur !== 'object') continue;
    for (const [k, v] of Object.entries(cur)) {
      if (wanted.includes(k.toLowerCase()) && (typeof v === 'string' || typeof v === 'number') && String(v).trim()) return String(v).trim();
    }
    for (const v of Object.values(cur)) if (v && typeof v === 'object') queue.push(v);
  }
  return null;
}

/** "PPSA22453-Tomb Raider Legend (v01.000.004).exfat" */
export function parseExfatName(file) {
  const base = path.basename(file).replace(/\.exfat$/i, '');
  const m = /^((?:PPSA|CUSA)\d{5})[-_ ]+(.*?)\s*(?:\(v?([\d.]+)\))?\s*$/i.exec(base);
  if (!m) return { titleId: null, title: base.trim(), version: null };
  return { titleId: m[1].toUpperCase(), title: m[2].trim() || null, version: m[3] || null };
}

/**
 * PS5 exFAT image (<name>.exfat), optionally with a "<name>.exfat.ps5-archive.json" beside it.
 * Details come from param.json inside the image, then the sidecar JSON, then the file name.
 */
export async function readPs5Exfat(file, readImage) {
  const fromName = parseExfatName(file);
  let sidecar = {};
  try {
    const json = JSON.parse(await fs.readFile(`${file}.ps5-archive.json`, 'utf8'));
    if (json.localizedParameters) sidecar = fromParamJson(json);
    else {
      sidecar = {
        titleId: findKey(json, ['titleId', 'title_id']),
        contentId: findKey(json, ['contentId', 'content_id']),
        version: findKey(json, ['contentVersion', 'appVersion', 'app_ver', 'version']),
        title: findKey(json, ['titleName', 'title_name', 'title'])
      };
    }
  } catch { /* no sidecar, or not JSON */ }

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

  const pick = (k) => image[k] || sidecar[k] || fromName[k] || null;
  return {
    platform: 'PS5',
    kind: 'ps5-exfat',
    titleId: pick('titleId'),
    contentId: pick('contentId'),
    version: pick('version'),
    category: image.category || null,
    title: pick('title'),
    iconBuf: icon,
    backdropBuf: backdrop,
    hasSidecar: Object.keys(sidecar).length > 0
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
