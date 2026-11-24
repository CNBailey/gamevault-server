import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Icon } from './Icons.jsx';

/** Dialog to search IGDB and pick the right game for a folder. */
export default function FixMatch({ game, onClose, onMatched }) {
  const ref = useRef(null);
  const [q, setQ] = useState(game.localTitle || game.title || '');
  const [results, setResults] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    ref.current?.showModal();
    search();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search(e) {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try { setResults(await api.candidates(game.id, q)); } catch (err) { setError(err.message); setResults([]); }
    setBusy(false);
  }

  async function pick(igdbId) {
    setBusy(true);
    try {
      const updated = await api.match(game.id, igdbId);
      onMatched?.(updated);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="fix-title">
      <div className="dialog-head">
        <h2 id="fix-title">Fix match</h2>
        <button className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" size={20} /></button>
      </div>
      <p className="muted small">Folder: <code>{game.path || game.folder}</code></p>
      <form onSubmit={search} className="row gap-8">
        <label className="grow">
          <span className="sr-only">Game title</span>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Game title" />
        </label>
        <button className="btn btn-primary" disabled={busy}>Search</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="candidates">
        {results === null && <li className="muted">Searching…</li>}
        {results?.length === 0 && !error && <li className="muted">No results. Try a shorter or different title.</li>}
        {results?.map((c) => (
          <li key={c.igdbId}>
            {c.cover ? <img src={c.cover} alt="" /> : <div className="cand-ph" />}
            <div className="grow">
              <div className="strong">{c.name}</div>
              <div className="muted small">{c.year || 'Year unknown'}{c.score != null ? ` · ${c.score}% title match` : ''}</div>
            </div>
            <button className="btn" disabled={busy} onClick={() => pick(c.igdbId)}>Use this</button>
          </li>
        ))}
      </ul>
    </dialog>
  );
}
