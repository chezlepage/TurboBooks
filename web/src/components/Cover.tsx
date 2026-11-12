import { useState } from 'react';

interface Props {
  src: string | null;
  title: string;
  author?: string | null;
  className?: string;
}

/** Book cover, with a typeset "book" placeholder when there's no image (or it fails to load). */
export function Cover({ src, title, author, className = '' }: Props) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img className={`cover ${className}`} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  // A stable, muted hue per title so placeholder books look distinct but calm.
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <div
      className={`cover cover-placeholder ${className}`}
      style={{ background: `linear-gradient(160deg, hsl(${hue} 28% 24%), hsl(${(hue + 30) % 360} 26% 13%))` }}
      aria-hidden
    >
      <span className="ph-rule" />
      <span className="ph-title">{title}</span>
      {author && <span className="ph-author">{author}</span>}
    </div>
  );
}
