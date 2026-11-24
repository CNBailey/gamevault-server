import { useState } from 'react';

const COLORS = ['#27456F', '#584829', '#6A2430', '#3A2A57', '#47392F', '#523767', '#22495A', '#33303C', '#6A3A24', '#2C4838'];

function colorFor(text) {
  let h = 0;
  for (const ch of text || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/** Cover image, or a coloured placeholder with the title when there is no art yet. */
export default function Poster({ src, title, className = '', children }) {
  const [failed, setFailed] = useState(false);
  const showImg = src && !failed;
  return (
    <div className={`poster ${className}`} style={showImg ? undefined : { background: colorFor(title) }}>
      {showImg
        ? <img src={src} alt="" loading="lazy" className={src.includes('/local-icon') ? 'icon-art' : undefined} onError={() => setFailed(true)} />
        : <span className="poster-title">{title}</span>}
      {children}
    </div>
  );
}
