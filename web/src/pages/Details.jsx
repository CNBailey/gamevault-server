import { useEffect, useRef, useState } from 'react';
import { api, formatBytes, formatDate } from '../api.js';
import Poster from '../components/Poster.jsx';
import FixMatch from '../components/FixMatch.jsx';
import { Icon, PlatformBadge, PlayIcon, StarIcon } from '../components/Icons.jsx';

const KIND = { 'ps5-exfat': 'PS5 exFAT image', 'ps5-folder': 'PS5 folder dump', 'ps4-folder': 'PS4 folder dump', 'ps4-pkg': 'PS4 PKG' };
const PART = { gd: 'Game', gp: 'Update', ac: 'Add-on', image: 'Game image' };
const STATUS = {
  matched: ['#3FCF8E', 'Matched on IGDB by name'],
  manual: ['#3FCF8E', 'Matched on IGDB (chosen by you, remembered by title ID)'],
  review: ['#F5B841', 'Matched on IGDB — please check it is the right game'],
  unmatched: ['#F07A7A', 'No match found on IGDB'],
  pending: ['#9AA4B2', 'Not looked up yet']
};

export default function Details({ id, scanVersion }) {
  const [game, setGame] = useState(null);
  const [error, setError] = useState('');
  const [video, setVideo] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shot, setShot] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState(false);
  const trailerRef = useRef(null);
  const lightbox = useRef(null);

  useEffect(() => {
    api.game(id).then(setGame).catch((e) => setError(e.message));
  }, [id, scanVersion]);

  useEffect(() => {
    if (shot != null) lightbox.current?.showModal();
  }, [shot]);

  if (error) return <main className="container page"><p className="error">{error}</p><a href="#/">Back to library</a></main>;
  if (!game) return <main className="container page"><p className="muted">Loading…</p></main>;

  const status = STATUS[game.matchStatus] || STATUS.pending;
  const videos = game.videos || [];
  const current = videos[video];

  async function toggleFav() {
    const updated = await api.setFavourite(game.id, !game.favourite);
    setGame({ ...game, favourite: updated.favourite });
  }

  async function rescrape() {
    setBusy('Refreshing details…');
    try { setGame(await api.rescrape(game.id)); setBusy(''); } catch (e) { setBusy(e.message); }
  }

  function watch() {
    setPlaying(true);
    trailerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function copyPath() {
    try { await navigator.clipboard.writeText(game.path); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  }

  const companies = [game.developer, game.publisher].filter(Boolean);
  const uniqueCompanies = [...new Set(companies.join(', ').split(', ').filter(Boolean))];

  return (
    <>
      <section className="hero">
        {game.backdrop && <img className="hero-bg" src={game.backdrop} alt="" />}
        <div className="hero-shade" />
        <div className="container hero-inner">
          <a href="#/" className="back"><Icon name="back" /> Back to library</a>
          <div className="hero-row">
            <Poster src={game.cover} title={game.title} className="hero-poster" />
            <div className="hero-text">
              <div className="row gap-8 wrap">
                <PlatformBadge platform={game.platform} large />
                {game.genres.map((g) => <span key={g} className="tag">{g}</span>)}
                {game.missing && <span className="tag tag-warn">Missing from disk</span>}
              </div>
              <h1 className="hero-title">{game.title}</h1>
              <p className="hero-sub">{[game.year, ...uniqueCompanies].filter(Boolean).join(' · ') || game.localTitle}</p>
              <div className="row gap-20 wrap scores">
                {game.criticScore != null && (
                  <div className="score-box"><span className="score-num score-good">{game.criticScore}</span><span>Critic score<br />IGDB</span></div>
                )}
                {game.userScore != null && (
                  <div className="score-box"><span className="score-num">{game.userScore}</span><span>User rating<br />IGDB</span></div>
                )}
              </div>
              <div className="row gap-10 wrap actions">
                {current && <button className="btn btn-primary btn-lg" onClick={watch}><PlayIcon /> Watch trailer</button>}
                <button className="btn btn-lg fav-toggle" aria-pressed={game.favourite} onClick={toggleFav}>
                  <StarIcon filled={game.favourite} size={18} stroke="#F5B841" /> {game.favourite ? 'In favourites' : 'Add to favourites'}
                </button>
                <button className="btn btn-lg btn-ghost" onClick={() => setFixing(true)}>Fix match</button>
                <button className="btn btn-lg btn-ghost" onClick={rescrape}>Refresh details</button>
                <button className="btn btn-lg btn-dashed" disabled><Icon name="download" /> Send to PS5 · with console app</button>
              </div>
              {busy && <p className="muted small" role="status">{busy}</p>}
            </div>
          </div>
        </div>
      </section>

      <main className="container page details">
        <div className="details-main">
          <section ref={trailerRef} aria-labelledby="h-trailer">
            <div className="section-head">
              <h2 id="h-trailer">Gameplay trailer</h2>
              {videos.length > 1 && (
                <select className="select" value={video} onChange={(e) => { setVideo(Number(e.target.value)); setPlaying(true); }} aria-label="Choose video">
                  {videos.map((v, i) => <option key={v.id} value={i}>{v.name}</option>)}
                </select>
              )}
            </div>
            <div className="video">
              {current && playing && (
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${current.id}?autoplay=1&rel=0`}
                  title={`${game.title} – ${current.name}`}
                  allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                  allowFullScreen
                />
              )}
              {current && !playing && (
                <button className="video-poster" onClick={() => setPlaying(true)} aria-label={`Play ${current.name}`}>
                  <img src={`https://i.ytimg.com/vi/${current.id}/hqdefault.jpg`} alt="" />
                  <span className="play"><PlayIcon size={28} color="#0D1015" /></span>
                  <span className="video-label">{current.name}</span>
                </button>
              )}
              {!current && <p className="muted">No trailer found for this game.</p>}
            </div>
          </section>

          <section aria-labelledby="h-summary">
            <h2 id="h-summary">Summary</h2>
            <p className="summary">{game.summary || 'No summary yet. Run a scan with IGDB set up in Settings, or use Fix match.'}</p>
          </section>

          {game.screenshots.length > 0 && (
            <section aria-labelledby="h-shots">
              <div className="section-head">
                <h2 id="h-shots">Screenshots</h2>
                <span className="muted small">{game.screenshots.length} images</span>
              </div>
              <div className="shots">
                {game.screenshots.map((s, i) => (
                  <button key={s} className="shot" onClick={() => setShot(i)} aria-label={`Open screenshot ${i + 1}`}>
                    <img src={s} alt="" loading="lazy" />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        <aside className="details-side">
          <section className="card" aria-labelledby="h-files">
            <h2 id="h-files">File information</h2>
            <dl className="dl">
              <dt>Format</dt><dd>{KIND[game.kind] || game.kind}</dd>
              <dt>Size on disk</dt><dd>{formatBytes(game.sizeBytes)}</dd>
              <dt>{game.kind === 'ps4-pkg' ? 'PKG files' : 'Files'}</dt><dd>{game.fileCount?.toLocaleString('en-GB')}</dd>
              <dt>Title ID</dt><dd className="mono">{game.titleId || '—'}</dd>
              <dt>Content ID</dt><dd className="mono small">{game.contentId || '—'}</dd>
              <dt>Version</dt><dd className="mono">{game.version || '—'}</dd>
              <dt>Date added</dt><dd>{formatDate(game.addedAt, true)}</dd>
              <dt>Last modified</dt><dd>{formatDate(game.modifiedAt, true)}</dd>
              <dt>Path</dt><dd className="mono small">{game.path}</dd>
            </dl>
            {game.pkgs?.length > 1 && (
              <ul className="pkg-list">
                {game.pkgs.map((p) => (
                  <li key={p.path}><span className="mono small">{p.path}</span><span className="muted small">{PART[p.category] || p.category || 'PKG'} {p.version ? `v${p.version}` : ''} · {formatBytes(p.size)}</span></li>
                ))}
              </ul>
            )}
            <button className="btn btn-block" onClick={copyPath}><Icon name="copy" /> {copied ? 'Copied' : 'Copy path'}</button>
          </section>

          <section className="card" aria-labelledby="h-meta">
            <h2 id="h-meta">Game information</h2>
            <dl className="dl">
              <dt>Release date</dt><dd>{game.releaseDate ? formatDate(game.releaseDate) : '—'}</dd>
              <dt>Developer</dt><dd>{game.developer || '—'}</dd>
              <dt>Publisher</dt><dd>{game.publisher || '—'}</dd>
              <dt>Category</dt><dd>{game.genres.join(', ') || '—'}</dd>
              <dt>Modes</dt><dd>{game.modes.join(', ') || '—'}</dd>
              <dt>Name in dump</dt><dd>{game.localTitle || '—'}</dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="h-src">
            <h2 id="h-src">Metadata source</h2>
            <p className="row gap-10 small"><span className="dot" style={{ background: status[0] }} />{status[1]}{game.scrapedAt ? ` · ${formatDate(game.scrapedAt)}` : ''}</p>
            {game.scrapeError && <p className="error small">{game.scrapeError}</p>}
            <p className="muted small">Artwork is saved on the NAS so pages load quickly. Trailers play from YouTube.</p>
          </section>
        </aside>
      </main>

      {fixing && <FixMatch game={game} onClose={() => setFixing(false)} onMatched={setGame} />}

      {shot != null && (
        <dialog ref={lightbox} className="lightbox" onClose={() => setShot(null)} onClick={(e) => e.target === lightbox.current && lightbox.current.close()}>
          <img src={game.screenshots[shot]} alt={`Screenshot ${shot + 1} of ${game.title}`} />
          <div className="row gap-10 lightbox-bar">
            <button className="btn" onClick={() => setShot((shot - 1 + game.screenshots.length) % game.screenshots.length)}>Previous</button>
            <span className="muted">{shot + 1} / {game.screenshots.length}</span>
            <button className="btn" onClick={() => setShot((shot + 1) % game.screenshots.length)}>Next</button>
            <button className="btn" onClick={() => lightbox.current.close()}>Close</button>
          </div>
        </dialog>
      )}
    </>
  );
}
