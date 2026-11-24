import { useEffect, useMemo, useState } from 'react';
import { api, store } from '../api.js';
import Poster from '../components/Poster.jsx';
import { PlatformBadge, StarIcon } from '../components/Icons.jsx';

const SORTS = [
  ['title', 'Title A–Z'],
  ['added', 'Date added'],
  ['released', 'Release date'],
  ['rating', 'Rating'],
  ['size', 'File size']
];

export default function Library({ search, scanVersion }) {
  const saved = store('filters.v2') || {};
  const [games, setGames] = useState(null);
  const [error, setError] = useState('');
  const [platform, setPlatform] = useState(saved.platform || 'All');
  const [genre, setGenre] = useState(saved.genre || 'All');
  const [favOnly, setFavOnly] = useState(!!saved.favOnly);
  const [hideApps, setHideApps] = useState(saved.hideApps !== false);
  const [sort, setSort] = useState(saved.sort || 'title');

  useEffect(() => { store('filters.v2', { platform, genre, favOnly, sort, hideApps }); }, [platform, genre, favOnly, sort, hideApps]);

  useEffect(() => {
    api.games({ sort }).then((d) => { setGames(d.games); setError(''); }).catch((e) => setError(e.message));
  }, [sort, scanVersion]);

  const genres = useMemo(() => {
    const counts = new Map();
    for (const g of games || []) for (const x of g.genres) counts.set(x, (counts.get(x) || 0) + 1);
    return ['All', ...[...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n)];
  }, [games]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (games || []).filter((g) =>
      (platform === 'Apps' ? g.isApp : (!hideApps || !g.isApp) && (platform === 'All' || g.platform === platform)) &&
      (genre === 'All' || g.genres.includes(genre)) &&
      (!favOnly || g.favourite) &&
      (!q || g.title.toLowerCase().includes(q)));
  }, [games, platform, genre, favOnly, search, hideApps]);

  async function toggleFav(g) {
    const next = !g.favourite;
    setGames((list) => list.map((x) => (x.id === g.id ? { ...x, favourite: next } : x)));
    try { await api.setFavourite(g.id, next); } catch {
      setGames((list) => list.map((x) => (x.id === g.id ? { ...x, favourite: !next } : x)));
    }
  }

  return (
    <main className="container page">
      <div className="page-head">
        <div>
          <h1>Library</h1>
          <p className="muted">{!games ? 'Loading…' : platform === 'Apps'
            ? `Showing ${visible.length} of ${games.filter((g) => g.isApp).length} apps`
            : `Showing ${visible.length} of ${games.filter((g) => !g.isApp || !hideApps).length} ${hideApps ? 'games' : 'games and apps'}`}</p>
        </div>
        <label className="sort">Sort by
          <select className="select" value={sort} onChange={(e) => setSort(e.target.value)}>
            {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>
      </div>

      <div className="filters">
        <div role="group" aria-label="Platform" className="segmented">
          {['All', 'PS5', 'PS4', ...((games || []).some((g) => g.isApp) ? ['Apps'] : [])].map((p) => (
            <button key={p} aria-pressed={platform === p} onClick={() => setPlatform(p)}>{p}</button>
          ))}
        </div>
        <div className="divider" />
        <div role="group" aria-label="Category" className="chips">
          {genres.map((c) => (
            <button key={c} className="chip" aria-pressed={genre === c} onClick={() => setGenre(c)}>{c}</button>
          ))}
        </div>
        {(games || []).some((g) => g.isApp) && platform !== 'Apps' && (
          <label className="row gap-8 small hide-apps">
            <input type="checkbox" className="switch" checked={hideApps} onChange={(e) => setHideApps(e.target.checked)} />
            Hide apps
          </label>
        )}
        <button className="fav-toggle" aria-pressed={favOnly} onClick={() => setFavOnly(!favOnly)}>
          <StarIcon filled={favOnly} size={16} stroke="#F5B841" /> Favourites only
        </button>
      </div>

      {error && <p className="error">Could not load the library: {error}</p>}

      {games && games.length === 0 && (
        <div className="empty">
          <p className="strong">No games yet</p>
          <p>Add your PS4 and PS5 folders in <a href="#/settings">Settings</a>, then run a scan.</p>
        </div>
      )}
      {games && games.length > 0 && visible.length === 0 && (
        <div className="empty">
          <p className="strong">No games match these filters</p>
          <p>Try another category, clear the search, or turn off Favourites only.</p>
        </div>
      )}

      <div className="grid">
        {visible.map((g) => (
          <div className="tile" key={g.id}>
            <a href={`#/game/${g.id}`} className="tile-link">
              <Poster src={g.cover} title={g.title}>
                <span className="tile-badge"><PlatformBadge platform={g.platform} />{g.isApp && <span className="tag tag-app">APP</span>}</span>
              </Poster>
              <div className="tile-meta">
                <div className="tile-title">{g.title}</div>
                <div className="tile-sub">
                  <span>{g.isApp ? 'Homebrew app' : [g.year, g.genres[0]].filter(Boolean).join(' · ') || (g.matchStatus === 'pending' ? 'Details pending' : '—')}</span>
                  {(g.criticScore ?? g.userScore) != null && <span className="score">{g.criticScore ?? g.userScore}</span>}
                </div>
              </div>
            </a>
            <button className="tile-fav" aria-label={g.favourite ? `Remove ${g.title} from favourites` : `Add ${g.title} to favourites`} aria-pressed={g.favourite} onClick={() => toggleFav(g)}>
              <StarIcon filled={g.favourite} />
            </button>
          </div>
        ))}
      </div>
    </main>
  );
}
