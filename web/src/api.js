async function request(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const base = '/api/v1';

export const api = {
  games: (params = {}) => request(`${base}/games?${new URLSearchParams(params)}`),
  game: (id) => request(`${base}/games/${id}`),
  files: (id) => request(`${base}/games/${id}/files`),
  setFavourite: (id, favourite) => request(`${base}/games/${id}/favourite`, { method: 'PUT', body: { favourite } }),
  rescrape: (id) => request(`${base}/games/${id}/rescrape`, { method: 'POST' }),
  candidates: (id, q) => request(`${base}/games/${id}/candidates?${new URLSearchParams({ q })}`),
  match: (id, igdbId) => request(`${base}/games/${id}/match`, { method: 'POST', body: { igdbId } }),
  scan: () => request(`${base}/scan`),
  startScan: (opts = {}) => request(`${base}/scan`, { method: 'POST', body: opts }),
  libraries: () => request(`${base}/libraries`),
  addLibrary: (path, platform) => request(`${base}/libraries`, { method: 'POST', body: { path, platform } }),
  updateLibrary: (id, patch) => request(`${base}/libraries/${id}`, { method: 'PATCH', body: patch }),
  removeLibrary: (id) => request(`${base}/libraries/${id}`, { method: 'DELETE' }),
  review: () => request(`${base}/review`),
  settings: () => request(`${base}/settings`),
  saveSettings: (s) => request(`${base}/settings`, { method: 'PUT', body: s }),
  purgeMissing: () => request(`${base}/maintenance/purge-missing`, { method: 'POST' }),
  conversions: () => request(`${base}/conversions`),
  conversionSettings: (s) => request(`${base}/conversions/settings`, { method: 'PUT', body: s }),
  checkConversions: () => request(`${base}/conversions/check`, { method: 'POST' }),
  cancelConversion: (id) => request(`${base}/conversions/${id}/cancel`, { method: 'POST' }),
  retryConversion: (id) => request(`${base}/conversions/${id}/retry`, { method: 'POST' }),
  removeConversion: (id) => request(`${base}/conversions/${id}`, { method: 'DELETE' }),
  clearConversionHistory: () => request(`${base}/conversions/clear-history`, { method: 'POST' }),
  emptyDone: () => request(`${base}/conversions/empty-done`, { method: 'POST', body: { confirm: true } }),
  usb: (drive) => request(`${base}/usb${drive ? `?drive=${encodeURIComponent(drive)}` : ''}`),
  usbCopy: (drive, gameIds) => request(`${base}/usb/copy`, { method: 'POST', body: { drive, gameIds } }),
  usbCancel: (id) => request(`${base}/usb/jobs/${id}/cancel`, { method: 'POST' }),
  usbRemove: (id) => request(`${base}/usb/jobs/${id}`, { method: 'DELETE' }),
  usbClear: () => request(`${base}/usb/jobs/clear`, { method: 'POST' }),
  renamePreview: (platform) => request(`${base}/maintenance/rename-preview?platform=${platform}`),
  applyRenames: (platform, paths) => request(`${base}/maintenance/rename`, { method: 'POST', body: { platform, paths } })
};

export function formatBytes(n) {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) +
    (withTime ? `, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '');
}

export function timeAgo(iso) {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function store(key, value) {
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(`gv.${key}`));
    localStorage.setItem(`gv.${key}`, JSON.stringify(value));
  } catch { /* storage unavailable */ }
  return undefined;
}
