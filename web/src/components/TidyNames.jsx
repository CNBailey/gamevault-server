import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';

/** Preview and apply standard file names (from the details inside each file). */
export default function TidyNames({ onClose, onDone }) {
  const ref = useRef(null);
  const [platform, setPlatform] = useState('PS4');
  const [items, setItems] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { ref.current?.showModal(); }, []);

  useEffect(() => {
    setItems(null);
    setResult(null);
    setError('');
    api.renamePreview(platform)
      .then((list) => { setItems(list); setPicked(new Set(list.filter((i) => !i.conflict).map((i) => i.path))); })
      .catch((e) => { setError(e.message); setItems([]); });
  }, [platform]);

  function toggle(p) {
    const next = new Set(picked);
    if (next.has(p)) next.delete(p); else next.add(p);
    setPicked(next);
  }

  async function apply() {
    setBusy(true);
    try {
      const r = await api.applyRenames(platform, [...picked]);
      setResult(r);
      onDone?.();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }

  const failed = result?.filter((r) => !r.ok) || [];

  return (
    <dialog ref={ref} className="dialog dialog-wide" onClose={onClose} aria-labelledby="tidy-title">
      <div className="dialog-head">
        <h2 id="tidy-title">Tidy file names</h2>
        <button className="icon-btn" aria-label="Close" onClick={() => ref.current.close()}><Icon name="close" size={20} /></button>
      </div>
      <p className="muted small">Renames library files to <code>CUSA00021-WATCH_DOGS (v01.00).pkg</code> / <code>PPSA01417-Title (v01.015.001).exfat</code>, using the details stored inside each file. Files stay in their folders; favourites and matches are kept.</p>
      <div role="group" aria-label="Platform" className="segmented tidy-tabs">
        {['PS4', 'PS5'].map((p) => <button key={p} aria-pressed={platform === p} onClick={() => setPlatform(p)}>{p}</button>)}
      </div>
      {error && <p className="error">{error}</p>}
      {items === null && <p className="muted">Reading files…</p>}
      {items?.length === 0 && !error && <p className="muted">All {platform} files already have standard names.</p>}
      {result && (
        <p role="status" className="small">
          Renamed {result.length - failed.length} file{result.length - failed.length === 1 ? '' : 's'}.
          {failed.length > 0 && <span className="error"> {failed.length} failed: {failed.map((f) => `${f.path.split('/').pop()} (${f.error})`).join('; ')}</span>}
        </p>
      )}
      {items?.length > 0 && !result && (
        <>
          <ul className="rename-list">
            {items.map((i) => (
              <li key={i.path}>
                <label className="row gap-10">
                  <input type="checkbox" className="switch" checked={picked.has(i.path)} disabled={i.conflict} onChange={() => toggle(i.path)} />
                  <span className="grow">
                    <span className="mono small muted">{i.folder !== '.' ? `${i.folder}/` : ''}{i.from}</span>
                    <span className="mono small rename-to">→ {i.to}{i.conflict && <span className="error"> (a file with this name already exists)</span>}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="row gap-8 dialog-actions">
            <button className="btn btn-primary" disabled={busy || picked.size === 0} onClick={apply}>Rename {picked.size} file{picked.size === 1 ? '' : 's'}</button>
            <button className="btn" onClick={() => ref.current.close()}>Cancel</button>
          </div>
        </>
      )}
    </dialog>
  );
}
