import { useCallback, useEffect, useState } from 'react';
import { api, formatBytes, formatDate } from '../api.js';
import { PlatformBadge } from '../components/Icons.jsx';

function Progress({ value }) {
  const pct = Math.round((value || 0) * 100);
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${pct}%` }} />
    </div>
  );
}

const ACTION = { rename: 'Rename', convert: 'Convert to .exfat', publish: 'Rename (already .exfat)' };

export default function Conversions({ onChange }) {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setS(await api.conversions()); setError(''); } catch (e) { setError(e.message); }
  }, []);

  useEffect(() => {
    let timer;
    let stopped = false;
    const loop = async () => {
      await load();
      if (!stopped) timer = setTimeout(loop, 2000);
    };
    loop();
    return () => { stopped = true; clearTimeout(timer); };
  }, [load]);

  async function act(fn) {
    setBusy(true);
    try { await fn(); } catch (e) { setError(e.message); }
    await load();
    setBusy(false);
    onChange?.();
  }

  if (!s) return <main className="container page"><h1>Conversions</h1><p className="muted">{error || 'Loading…'}</p></main>;

  const busyAny = s.active.length + s.queued.length + s.waiting.length > 0;

  return (
    <main className="container page">
      <div className="page-head">
        <div>
          <h1>Conversions</h1>
          <p className="muted">
            Drop PS5 games in <code>{s.folders.PS5}</code> and PS4 .pkg files in <code>{s.folders.PS4}</code>.
          </p>
        </div>
        <div className="row gap-8 wrap">
          <button className="btn" disabled={busy || !s.enabled} onClick={() => act(api.checkConversions)}>Check now</button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {!s.enabled && (
        <div className="empty">
          <p className="strong">The conversion service is off</p>
          <p>Turn it on in <a href="#/settings">Settings → Conversion service</a>.</p>
        </div>
      )}
      {s.enabled && !s.forge.available && (
        <p className="error">PS5 Dump Forge isn’t available ({s.forge.error}). PS4 renaming still works; PS5 conversions will fail.</p>
      )}

      {s.enabled && (
        <div className="conv">
          <section className="card" aria-labelledby="h-now">
            <h2 id="h-now">In progress</h2>
            {s.active.length === 0 && <p className="muted">{busyAny ? 'Starting…' : 'Nothing running. New files are picked up within about 15 seconds of finishing copying.'}</p>}
            {s.active.map((j) => (
              <div key={j.id} className="job">
                <div className="row gap-10 wrap job-head">
                  <PlatformBadge platform={j.platform} />
                  <div className="grow">
                    <div className="strong">{j.title || j.sourceName}</div>
                    <div className="muted small">{j.sourceName}{j.version ? ` · v${j.version}` : ''}{j.sizeBytes ? ` · ${formatBytes(j.sizeBytes)}` : ''}</div>
                  </div>
                  <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.cancelConversion(j.id))}>Cancel</button>
                </div>
                <div className="row gap-10 small job-stage">
                  <span>{ACTION[j.action] || 'Working'} · {j.stage || 'Starting'}</span>
                  <span className="muted">{j.progress != null ? `${Math.round(j.progress * 100)}%` : ''}</span>
                </div>
                <Progress value={j.progress} />
              </div>
            ))}
          </section>

          {(s.waiting.length > 0 || s.queued.length > 0) && (
            <section className="card" aria-labelledby="h-wait">
              <h2 id="h-wait">Up next</h2>
              <ul className="plain-list">
                {s.waiting.map((w) => (
                  <li key={`w-${w.platform}-${w.name}`} className="row gap-10">
                    <PlatformBadge platform={w.platform} />
                    <span className="grow">{w.name}</span>
                    <span className="muted small">Waiting for the copy to finish · {formatBytes(w.size)}{w.secondsLeft > 0 ? ` · ~${w.secondsLeft}s` : ''}</span>
                  </li>
                ))}
                {s.queued.map((q) => (
                  <li key={q.id} className="row gap-10">
                    <PlatformBadge platform={q.platform} />
                    <span className="grow">{q.sourceName}</span>
                    <span className="muted small">Queued{q.message ? ` · ${q.message}` : ''}</span>
                    <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.cancelConversion(q.id))}>Cancel</button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card" aria-labelledby="h-hist">
            <div className="section-head">
              <h2 id="h-hist">History</h2>
              {s.history.some((h) => h.status === 'done') && (
                <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(api.clearConversionHistory)}>Clear finished</button>
              )}
            </div>
            {s.history.length === 0 && <p className="muted">No conversions yet.</p>}
            {s.history.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Result</th><th>Platform</th><th>Dropped in</th><th>Outcome</th><th>Finished</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {s.history.map((h) => (
                      <tr key={h.id}>
                        <td><span className={`pill ${h.status === 'done' ? 'pill-ok' : 'pill-bad'}`}>{h.status === 'done' ? 'Done' : 'Failed'}</span></td>
                        <td><PlatformBadge platform={h.platform} /></td>
                        <td className="mono small">{h.sourceName}</td>
                        <td className="small">
                          {h.status === 'done'
                            ? <><span className="mono">{h.output}</span>{h.message && <div className="muted">{h.message}</div>}</>
                            : <span className="error">{h.message}</span>}
                        </td>
                        <td className="muted small">{formatDate(h.finishedAt, true)}</td>
                        <td className="right row gap-8">
                          {h.status === 'failed' && <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api.retryConversion(h.id))}>Retry</button>}
                          <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => act(() => api.removeConversion(h.id))} aria-label={`Remove ${h.sourceName} from history`}>Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">A failed file stays in the incoming folder. Fix it or replace it and it is picked up again, or press Retry.</p>
          </section>

          <section className="card" aria-labelledby="h-done">
            <h2 id="h-done">Originals</h2>
            <p className="small">
              After a PS5 conversion the original is moved to <code>{s.done.path}</code>.
              It holds {s.done.items} item{s.done.items === 1 ? '' : 's'} ({formatBytes(s.done.size)}).
            </p>
            {s.done.items > 0 && (
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Permanently delete ${s.done.items} original${s.done.items === 1 ? '' : 's'} (${formatBytes(s.done.size)}) from _done? This can’t be undone. The converted games in your library are not affected.`)) {
                    act(api.emptyDone);
                  }
                }}
              >
                Delete originals…
              </button>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
