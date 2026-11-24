import { useEffect, useState } from 'react';
import { api, formatDate, timeAgo } from '../api.js';
import FixMatch from '../components/FixMatch.jsx';
import TidyNames from '../components/TidyNames.jsx';

export default function Settings({ scan, onConversionChange }) {
  const [libs, setLibs] = useState([]);
  const [review, setReview] = useState([]);
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({ igdbClientId: '', igdbClientSecret: '', scanIntervalHours: 6 });
  const [newLib, setNewLib] = useState({ path: '', platform: 'PS5' });
  const [msg, setMsg] = useState({});
  const [fixing, setFixing] = useState(null);
  const [tidy, setTidy] = useState(false);
  const [conv, setConv] = useState(null);
  const [settle, setSettle] = useState(60);

  async function load() {
    const [l, r, s] = await Promise.all([api.libraries(), api.review(), api.settings()]);
    setLibs(l);
    setReview(r);
    setSettings(s);
    setForm((f) => ({ ...f, igdbClientId: s.igdbClientId, scanIntervalHours: s.scanIntervalHours }));
    const c = await api.conversions();
    setConv(c);
    setSettle(c.settleSeconds);
  }

  async function saveConversion(patch) {
    try {
      setConv(await api.conversionSettings(patch));
      setMsg({ conv: patch.enabled === true ? 'Conversion service is on.' : patch.enabled === false ? 'Conversion service is off.' : 'Saved.' });
      onConversionChange?.();
    } catch (err) { setMsg({ conv: err.message }); }
  }

  useEffect(() => { load().catch((e) => setMsg({ page: e.message })); }, [scan.version]);

  const s = scan.state;
  const lastScan = s?.finishedAt || libs.map((l) => l.lastScan).filter(Boolean).sort().pop();
  const pct = s?.total ? Math.round((s.done / s.total) * 100) : 0;

  async function addLibrary(e) {
    e.preventDefault();
    try {
      await api.addLibrary(newLib.path, newLib.platform);
      setNewLib({ path: '', platform: newLib.platform });
      setMsg({});
      load();
    } catch (err) { setMsg({ lib: err.message }); }
  }

  async function saveSettings(e) {
    e.preventDefault();
    try {
      const r = await api.saveSettings(form);
      setForm({ ...form, igdbClientSecret: '' });
      setMsg({ settings: r.scraperConfigured ? 'Saved. New games will be looked up on IGDB.' : 'Saved. Add both the client ID and secret to look up games.' });
      load();
    } catch (err) { setMsg({ settings: err.message }); }
  }

  async function confirm(g) {
    try { await api.match(g.id, g.igdbId); load(); } catch (err) { setMsg({ review: err.message }); }
  }

  return (
    <main className="container page">
      <h1>Settings</h1>
      {msg.page && <p className="error">{msg.page}</p>}

      <div className="settings">
        <div className="settings-main">
          <section className={`card ${s?.running ? 'card-active' : ''}`} aria-labelledby="h-scan">
            <div className="section-head">
              <div>
                <h2 id="h-scan">{s?.running ? (s.phase === 'scraping' ? 'Fetching game details' : 'Scan in progress') : 'Scanning'}</h2>
                <p className="muted small">
                  {s?.running
                    ? `${s.library ? s.library + ' · ' : ''}${s.done} of ${s.total} · ${s.current || ''}`
                    : `Last scan ${timeAgo(lastScan)}${s?.added ? ` · ${s.added} new` : ''}. Automatic scan every ${settings?.scanIntervalHours || 0} h.`}
                </p>
                {s?.error && <p className="error small">{s.error}</p>}
                {!s?.running && s?.orphanPatches?.length > 0 && (
                  <details className="small muted">
                    <summary>{s.orphanPatches.length} PS4 patch(es) with no matching game</summary>
                    <ul>{s.orphanPatches.map((p) => <li key={p} className="mono">{p}</li>)}</ul>
                  </details>
                )}
              </div>
              <div className="row gap-8 wrap">
                <button className="btn btn-primary" disabled={s?.running} onClick={() => scan.start()}>Scan now</button>
                <button className="btn" disabled={s?.running} onClick={() => scan.start({ rescrapeAll: true })}>Scan &amp; refresh all details</button>
              </div>
            </div>
            {s?.running && (
              <div className="progress" role="progressbar" aria-label="Scan progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div style={{ width: `${pct}%` }} />
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="h-libs">
            <h2 id="h-libs">Library folders</h2>
            <p className="muted small">Each .exfat image, .pkg file or game folder is one game; PKG updates and DLC in the same folder are grouped with their game. Paths are as seen inside the container (see docker-compose.yml).</p>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Folder</th><th>Type</th><th>Games</th><th>Last scan</th><th>Enabled</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {libs.map((l) => (
                    <tr key={l.id}>
                      <td className="mono">{l.path}{l.fromEnv && <span className="muted small"> · from docker-compose</span>}</td>
                      <td>
                        <label className="sr-only" htmlFor={`plat-${l.id}`}>Type</label>
                        <select id={`plat-${l.id}`} className="select select-sm" value={l.platform} onChange={(e) => api.updateLibrary(l.id, { platform: e.target.value }).then(load)}>
                          <option value="PS5">PS5</option><option value="PS4">PS4</option><option value="AUTO">Auto</option>
                        </select>
                      </td>
                      <td>{l.games}</td>
                      <td className="muted">{l.lastScan ? formatDate(l.lastScan, true) : 'Never'}</td>
                      <td><input type="checkbox" className="switch" checked={l.enabled} aria-label={`Scan ${l.path}`} onChange={(e) => api.updateLibrary(l.id, { enabled: e.target.checked }).then(load)} /></td>
                      <td className="right row gap-8">
                        <button className="btn btn-sm" disabled={s?.running} onClick={() => scan.start({ libraryId: l.id })}>Rescan</button>
                        {!l.fromEnv && <button className="btn btn-sm btn-ghost" onClick={() => api.removeLibrary(l.id).then(load)}>Remove</button>}
                      </td>
                    </tr>
                  ))}
                  {libs.length === 0 && <tr><td colSpan="6" className="muted">No folders yet. Add one below.</td></tr>}
                </tbody>
              </table>
            </div>
            <form className="row gap-8 wrap add-lib" onSubmit={addLibrary}>
              <label className="grow"><span className="sr-only">Folder path</span>
                <input className="input" placeholder="/games/PS5" value={newLib.path} onChange={(e) => setNewLib({ ...newLib, path: e.target.value })} />
              </label>
              <label><span className="sr-only">Type</span>
                <select className="select" value={newLib.platform} onChange={(e) => setNewLib({ ...newLib, platform: e.target.value })}>
                  <option value="PS5">PS5 dumps</option><option value="PS4">PS4 PKGs</option><option value="AUTO">Auto-detect</option>
                </select>
              </label>
              <button className="btn btn-primary">Add folder</button>
            </form>
            {msg.lib && <p className="error small">{msg.lib}</p>}
            <div className="row gap-10 wrap tidy-row">
              <button className="btn" onClick={() => setTidy(true)}>Tidy file names…</button>
              <span className="muted small">Rename PS4/PS5 files to the standard <code>CUSA00021-Title (v01.00).pkg</code> form. You see a preview first.</span>
            </div>
          </section>

          <section className="card" aria-labelledby="h-review">
            <div className="row gap-10"><h2 id="h-review">Needs review</h2>{review.length > 0 && <span className="count">{review.length}</span>}</div>
            <p className="muted small">Games the scraper could not match confidently. Confirm the guess or search by another name.</p>
            {msg.review && <p className="error small">{msg.review}</p>}
            {review.length === 0 && <p className="muted">Nothing to review.</p>}
            <ul className="review">
              {review.map((g) => (
                <li key={g.id}>
                  {g.cover ? <img src={g.cover} alt="" /> : <div className="cand-ph" />}
                  <div className="grow">
                    <div className="mono small muted">{g.platform}/{g.folder}</div>
                    {g.matchStatus === 'review'
                      ? <div className="strong">Best guess: {g.title} <span className="warn">· {Math.round((g.matchScore || 0) * 100)}% match</span></div>
                      : <div className="strong">No match found <span className="muted">· searched for “{g.localTitle}”</span></div>}
                  </div>
                  {g.matchStatus === 'review' && <button className="btn btn-primary" onClick={() => confirm(g)}>Confirm</button>}
                  <button className="btn" onClick={() => setFixing(g)}>Search manually</button>
                </li>
              ))}
            </ul>
            {settings?.missingCount > 0 && (
              <p className="small">
                {settings.missingCount} game(s) are no longer on disk.{' '}
                <button className="link-btn" onClick={() => api.purgeMissing().then(load)}>Remove them from the catalogue</button>
              </p>
            )}
          </section>
        </div>

        <aside className="settings-side">
          <section className="card" aria-labelledby="h-prov">
            <h2 id="h-prov">Metadata &amp; media</h2>
            <p className="muted small">Titles, art, screenshots and trailers come from IGDB. Create a free app at dev.twitch.tv to get a client ID and secret.</p>
            <form className="stack" onSubmit={saveSettings}>
              <label className="field">IGDB client ID
                <input className="input" value={form.igdbClientId} onChange={(e) => setForm({ ...form, igdbClientId: e.target.value })} autoComplete="off" />
              </label>
              <label className="field">IGDB client secret
                <input className="input" type="password" value={form.igdbClientSecret} placeholder={settings?.igdbSecretSet ? 'Saved – type to replace' : ''} onChange={(e) => setForm({ ...form, igdbClientSecret: e.target.value })} autoComplete="new-password" />
              </label>
              <label className="field">Automatic scan every (hours, 0 = off)
                <input className="input" type="number" min="0" value={form.scanIntervalHours} onChange={(e) => setForm({ ...form, scanIntervalHours: e.target.value })} />
              </label>
              <button className="btn btn-primary">Save</button>
              {msg.settings && <p className="small" role="status">{msg.settings}</p>}
            </form>
          </section>

          <section className="card" aria-labelledby="h-conv">
            <h2 id="h-conv">Conversion service</h2>
            <p className="muted small">Converts PS5 games dropped in the incoming folder to .exfat and renames PS4 .pkg files, then moves them into your library.</p>
            {conv && (
              <div className="stack">
                {!conv.layout.ok && <p className="error small">{conv.layout.problem}</p>}
                <label className="row gap-10 strong">
                  <input type="checkbox" className="switch" checked={conv.enabled} onChange={(e) => saveConversion({ enabled: e.target.checked })} />
                  {conv.enabled ? 'On' : 'Off'}
                </label>
                <dl className="dl">
                  <dt>PS5 incoming</dt><dd className="mono small">{conv.folders.PS5}</dd>
                  <dt>PS4 incoming</dt><dd className="mono small">{conv.folders.PS4}</dd>
                  <dt>Originals</dt><dd className="mono small">{conv.folders.done}</dd>
                  <dt>Converter</dt><dd className="small">{conv.forge.available ? `PS5 Dump Forge ${conv.forge.version || ''}` : <span className="error">Not available: {conv.forge.error}</span>}</dd>
                </dl>
                <label className="field">Wait after a file stops changing (seconds)
                  <span className="row gap-8">
                    <input className="input" type="number" min="10" value={settle} onChange={(e) => setSettle(e.target.value)} />
                    <button className="btn" onClick={() => saveConversion({ settleSeconds: Number(settle) })}>Save</button>
                  </span>
                </label>
                {conv.enabled && <a href="#/conversions">Open the Conversions page →</a>}
                {msg.conv && <p className="small" role="status">{msg.conv}</p>}
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="h-badges">
            <h2 id="h-badges">Platform badges</h2>
            <p className="muted small">GameVault ships with PS5 and PS4 logo badges. To use different images, put files named <code>ps5.svg</code> and <code>ps4.svg</code> (or .png / .webp) in <code>docker/gamevault/badges</code> on the NAS and reload the page.</p>
          </section>

          <section className="card" aria-labelledby="h-api">
            <h2 id="h-api">Server &amp; API</h2>
            <p className="muted small">The web page and the future PS5 app both read from this API.</p>
            <dl className="dl">
              <dt>Version</dt><dd>{settings?.version}</dd>
              <dt>API base</dt><dd className="mono small">{window.location.origin}/api/v1</dd>
            </dl>
            <pre className="code">{`GET  /games?platform=&genre=&q=&fav=1&sort=
GET  /games/{id}
PUT  /games/{id}/favourite
GET  /games/{id}/files
GET  /games/{id}/files/{path}   · Range`}</pre>
          </section>
        </aside>
      </div>

      {fixing && <FixMatch game={fixing} onClose={() => setFixing(null)} onMatched={() => load()} />}
      {tidy && <TidyNames onClose={() => setTidy(false)} onDone={() => setTimeout(load, 4000)} />}
    </main>
  );
}
