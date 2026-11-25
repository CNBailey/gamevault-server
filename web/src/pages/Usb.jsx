import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatBytes, store } from '../api.js';
import { PlatformBadge } from '../components/Icons.jsx';
import Poster from '../components/Poster.jsx';

function Progress({ value }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

function SpaceBar({ total, free, adding }) {
  const used = total > 0 ? (total - free) / total : 0;
  const add = total > 0 ? Math.min(adding, Math.max(0, free)) / total : 0;
  return (
    <div className="space-bar" aria-hidden="true">
      <div className="space-used" style={{ width: `${used * 100}%` }} />
      <div className={adding > free ? 'space-over' : 'space-add'} style={{ width: `${(adding > free ? free / total : add) * 100}%` }} />
    </div>
  );
}

const STATE = { queued: 'Waiting', copying: 'Copying', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };

function eta(left, speed) {
  if (!speed) return '';
  const s = Math.round(left / speed);
  if (s < 60) return `${s}s left`;
  if (s < 3600) return `${Math.round(s / 60)} min left`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min left`;
}

export default function Usb() {
  const [s, setS] = useState(null);
  const [games, setGames] = useState([]);
  const [drive, setDrive] = useState(() => store('usb.drive') || '');
  const [picked, setPicked] = useState(() => new Set());
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('all');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setS(await api.usb(drive)); setError(''); } catch (e) { setError(e.message); }
  }, [drive]);

  useEffect(() => {
    let timer;
    let stopped = false;
    const loop = async () => {
      await load();
      if (!stopped) timer = setTimeout(loop, 2500);
    };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  }, [load]);

  useEffect(() => {
    api.games({ apps: 'hide', sort: 'title' }).then((r) => setGames(r.games)).catch((e) => setError(e.message));
  }, []);

  // Pick the first drive when none (or a missing one) is chosen.
  useEffect(() => {
    if (!s) return;
    if (!s.drives.some((d) => d.id === drive)) {
      const next = s.drives[0]?.id || '';
      if (next !== drive) setDrive(next);
    }
  }, [s, drive]);
  useEffect(() => { store('usb.drive', drive); }, [drive]);

  const current = s?.drives.find((d) => d.id === drive) || null;
  const present = useMemo(() => new Set(s?.present || []), [s]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return games.filter((g) => (platform === 'all' || g.platform === platform) && (!q || g.title.toLowerCase().includes(q)));
  }, [games, query, platform]);

  const pickedGames = games.filter((g) => picked.has(g.id));
  const pickedBytes = pickedGames.filter((g) => !present.has(g.id)).reduce((n, g) => n + (g.sizeBytes || 0), 0);
  const room = current ? current.free - current.reserved : 0;
  const canCopy = current && current.exfat !== 'no' && current.writable && pickedGames.length > 0 && pickedBytes <= room;

  function toggle(id) {
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function pickAllShown() {
    setPicked((old) => {
      const next = new Set(old);
      const all = shown.every((g) => next.has(g.id));
      for (const g of shown) if (all) next.delete(g.id); else if (!present.has(g.id)) next.add(g.id);
      return next;
    });
  }

  async function act(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { setError(e.message); }
    await load();
    setBusy(false);
  }

  async function copy() {
    setResult(null);
    await act(async () => {
      const r = await api.usbCopy(drive, [...picked]);
      setResult(r);
      if (r.queued) setPicked(new Set());
    });
  }

  if (!s) return <main className="container page"><h1>USB drive</h1><p className="muted">{error || 'Loading…'}</p></main>;

  const active = s.jobs.filter((j) => j.state === 'queued' || j.state === 'copying');
  const finished = s.jobs.filter((j) => j.state !== 'queued' && j.state !== 'copying');

  return (
    <main className="container page">
      <div className="page-head">
        <div>
          <h1>USB drive</h1>
          <p className="muted">
            Copy games to a USB drive plugged into the NAS, then plug it into the PS5. PS5 games go in <code>homebrew</code>, where
            ShadowMountPlus finds them; PS4 games (base game, patches and add-ons) go in the drive’s top folder.
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {!s.mapped && (
        <div className="empty">
          <p className="strong">GameVault can’t see the NAS’s USB ports yet</p>
          <p>Add these lines under <code>volumes:</code> in docker-compose, then rebuild the project in Container Manager:</p>
          <pre className="code-block">{'      - /volumeUSB1:/usb/1:rslave\n      - /volumeUSB2:/usb/2:rslave'}</pre>
        </div>
      )}

      {s.mapped && s.drives.length === 0 && (
        <div className="empty">
          <p className="strong">No USB drive found</p>
          <p>Plug a drive into the NAS. It shows here within a few seconds of DSM mounting it.</p>
        </div>
      )}

      {s.drives.length > 0 && (
        <section className="card" aria-labelledby="h-drive">
          <h2 id="h-drive">Drive</h2>
          <div className="drives" role="radiogroup" aria-label="USB drive">
            {s.drives.map((d) => (
              <label key={d.id} className={`drive ${d.id === drive ? 'drive-on' : ''}`}>
                <input type="radio" name="drive" value={d.id} checked={d.id === drive} onChange={() => setDrive(d.id)} />
                <div className="grow">
                  <div className="row gap-8 wrap">
                    <span className="strong">{d.label}</span>
                    <span className={`pill ${d.exfat === 'yes' ? 'pill-ok' : d.exfat === 'no' ? 'pill-bad' : ''}`}>{d.fsName}</span>
                  </div>
                  <div className="muted small">{formatBytes(d.free)} free of {formatBytes(d.total)}{d.reserved > 0 ? ` · ${formatBytes(d.reserved)} still to copy` : ''}</div>
                  <SpaceBar total={d.total} free={d.free - d.reserved} adding={d.id === drive ? pickedBytes : 0} />
                </div>
              </label>
            ))}
          </div>
          {current?.exfat === 'no' && (
            <p className="error">
              This drive is {current.fsName}. The PS5 reads games from exFAT drives, so GameVault won’t copy to it. To format it
              (this erases everything on it): in DSM open <b>Control Panel → External Devices</b>, select the drive, choose
              <b> Format</b> and pick <b>exFAT</b>. It shows here again once DSM has mounted it.
            </p>
          )}
          {current?.exfat === 'unknown' && (
            <p className="muted small">DSM mounts this drive through FUSE, so GameVault can’t tell whether it’s exFAT or NTFS. Check in DSM (Control Panel → External Devices) that it’s exFAT; the PS5 can’t read NTFS.</p>
          )}
          {current && !current.writable && <p className="error">GameVault can’t write to this drive (it’s mounted read-only).</p>}
          <p className="muted small">When the copies are done, eject the drive in DSM before unplugging it.</p>
        </section>
      )}

      {s.drives.length > 0 && (
        <section className="card" aria-labelledby="h-games">
          <div className="section-head">
            <h2 id="h-games">Games</h2>
            <div className="row gap-8 wrap usb-tools">
              <input type="search" className="usb-search" placeholder="Search…" aria-label="Search by title" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform">
                <option value="all">PS5 and PS4</option>
                <option value="PS5">PS5</option>
                <option value="PS4">PS4</option>
              </select>
              <button className="btn btn-sm btn-ghost" onClick={pickAllShown} disabled={!shown.length}>
                {shown.length && shown.every((g) => picked.has(g.id)) ? 'Clear these' : 'Select these'}
              </button>
            </div>
          </div>
          <ul className="usb-games">
            {shown.map((g) => (
              <li key={g.id}>
                <label className={`usb-game ${picked.has(g.id) ? 'usb-game-on' : ''}`}>
                  <input type="checkbox" checked={picked.has(g.id)} onChange={() => toggle(g.id)} />
                  <Poster src={g.cover} title={g.title} className="usb-thumb" />
                  <span className="grow">
                    <span className="strong usb-title">{g.title}</span>
                    <span className="muted small">{formatBytes(g.sizeBytes)}{g.version ? ` · v${g.version}` : ''}</span>
                  </span>
                  {present.has(g.id) && <span className="pill pill-ok">On the drive</span>}
                  <PlatformBadge platform={g.platform} />
                </label>
              </li>
            ))}
            {shown.length === 0 && <li className="muted">No games match.</li>}
          </ul>
          <div className="usb-footer">
            <span className={pickedBytes > room ? 'error' : 'muted'}>
              {pickedGames.length} selected · {formatBytes(pickedBytes)} to copy{current ? ` · ${formatBytes(Math.max(0, room))} free` : ''}
              {pickedBytes > room ? ' — that’s more than fits' : ''}
            </span>
            <button className="btn btn-primary" disabled={!canCopy || busy} onClick={copy}>
              Copy to {current?.label || 'drive'}
            </button>
          </div>
          {result && (
            <div className="small">
              {result.queued > 0 && <p>{result.queued} game{result.queued === 1 ? '' : 's'} added to the copy queue.</p>}
              {result.errors.map((e) => <p key={e.id} className="error">{e.title || `Game ${e.id}`}: {e.error}</p>)}
            </div>
          )}
        </section>
      )}

      {(active.length > 0 || finished.length > 0) && (
        <section className="card" aria-labelledby="h-copies">
          <div className="section-head">
            <h2 id="h-copies">Copies</h2>
            {finished.length > 0 && <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(api.usbClear)}>Clear finished</button>}
          </div>
          {[...active, ...finished].map((j) => (
            <div key={j.id} className="job">
              <div className="row gap-10 wrap job-head">
                <PlatformBadge platform={j.platform} />
                <div className="grow">
                  <div className="strong">{j.title}</div>
                  <div className="muted small">
                    To {j.drive} · {formatBytes(j.total)}
                    {j.state === 'copying' && j.speed > 0 ? ` · ${formatBytes(j.speed)}/s · ${eta(j.total - j.done, j.speed)}` : ''}
                    {j.note ? ` · ${j.note}` : ''}
                  </div>
                  {j.error && <div className="error small">{j.error}</div>}
                </div>
                <span className={`pill ${j.state === 'done' ? 'pill-ok' : j.state === 'failed' ? 'pill-bad' : ''}`}>{STATE[j.state]}</span>
                {(j.state === 'queued' || j.state === 'copying')
                  ? <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.usbCancel(j.id))}>Cancel</button>
                  : <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.usbRemove(j.id))} aria-label={`Remove ${j.title} from the list`}>Remove</button>}
              </div>
              {(j.state === 'copying' || j.state === 'queued') && <Progress value={j.total ? j.done / j.total : 0} />}
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
