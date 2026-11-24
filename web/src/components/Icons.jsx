import { useEffect, useState } from 'react';

const STAR = 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z';

export function StarIcon({ filled, size = 20, stroke = filled ? '#F5B841' : '#E8ECF1' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? '#F5B841' : 'none'} stroke={stroke} strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
      <path d={STAR} />
    </svg>
  );
}

/** GameVault mark: two game cases leaning together into a V. */
export function Logo({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <path d="M7 7 H20 L37 57 H25 Z" fill="#5B8CFF" stroke="#5B8CFF" strokeWidth="2" strokeLinejoin="round" />
      <path d="M57 7 H44 L27 57 H39 Z" fill="#A9C2FF" stroke="#10141A" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

const paths = {
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></>,
  back: <path d="M15 18l-6-6 6-6" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></>
};

export function Icon({ name, size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

export function PlayIcon({ size = 16, color = 'currentColor' }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill={color} aria-hidden="true"><path d="M7 4l13 8-13 8z" /></svg>;
}

let badgeRequest = null;
function loadBadges() {
  if (!badgeRequest) badgeRequest = fetch('/api/v1/badges').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  return badgeRequest;
}

/** Platform badge: your own image from /data/badges when present, else a text badge. */
export function PlatformBadge({ platform, large }) {
  const [images, setImages] = useState(null);
  useEffect(() => { let on = true; loadBadges().then((b) => on && setImages(b)); return () => { on = false; }; }, []);
  const src = images?.[platform];
  if (src) return <img className={`badge-img${large ? ' badge-img-lg' : ''}`} src={src} alt={platform} />;
  return <span className={`badge badge-${(platform || '').toLowerCase()}${large ? ' badge-lg' : ''}`}>{platform}</span>;
}
