import { useState } from 'react';

interface Props {
  src: string | null;
  title: string;
  className?: string;
}

/** Book cover with a generated placeholder when there is no image. */
export function Cover({ src, title, className = '' }: Props) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return <img className={`cover ${className}`} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
  }
  // Pick a stable hue from the title.
  let hash = 0;
  for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <div
      className={`cover cover-placeholder ${className}`}
      style={{ background: `linear-gradient(150deg, hsl(${hue} 35% 26%), hsl(${(hue + 40) % 360} 30% 14%))` }}
      aria-hidden
    >
      <span>{title}</span>
    </div>
  );
}
