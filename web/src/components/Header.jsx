import { Icon, Logo } from './Icons.jsx';
import { timeAgo } from '../api.js';

export default function Header({ section, search, onSearch, showSearch, scan, conv }) {
  const s = scan.state;
  let status = '';
  if (s?.running) {
    status = s.phase === 'scraping'
      ? `Fetching details ${s.done}/${s.total}`
      : `Scanning ${s.done}/${s.total || '…'}`;
  } else if (s?.finishedAt) {
    status = `Scanned ${timeAgo(s.finishedAt)}`;
  }

  return (
    <header className="topbar">
      <div className="container topbar-inner">
        <a href="#/" className="brand" aria-label="GameVault home"><Logo /><span>Game<span className="brand-accent">Vault</span></span></a>
        <nav aria-label="Main" className="nav">
          <a href="#/" aria-current={section === 'library' ? 'page' : undefined}>Library</a>
          {conv?.enabled && (
            <a href="#/conversions" aria-current={section === 'conversions' ? 'page' : undefined}>
              Conversions{conv.busy > 0 && <span className="nav-count" aria-label={`${conv.busy} in progress or waiting`}>{conv.busy}</span>}
            </a>
          )}
          <a href="#/settings" aria-current={section === 'settings' ? 'page' : undefined}>Settings</a>
        </nav>
        <div className="topbar-search">
          {showSearch && (
            <label className="search">
              <span className="sr-only">Search by title</span>
              <Icon name="search" size={18} />
              <input type="search" placeholder="Search by title…" value={search} onChange={(e) => onSearch(e.target.value)} />
            </label>
          )}
        </div>
        <div className="topbar-status">
          <span className="muted small" aria-live="polite">{status}</span>
          <button className="btn" onClick={() => scan.start()} disabled={s?.running}>
            <Icon name="refresh" /> {s?.running ? 'Scanning…' : 'Scan library'}
          </button>
        </div>
      </div>
    </header>
  );
}
