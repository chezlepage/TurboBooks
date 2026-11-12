/** Shimmering placeholders shown while content loads. */
export function GridSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="grid" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="skeleton skeleton-cover" />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line short" />
        </div>
      ))}
    </div>
  );
}

export function ListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <ul className="result-list" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="result">
          <div className="skeleton result-cover" style={{ aspectRatio: '1' }} />
          <div className="result-body">
            <div className="skeleton skeleton-line" />
            <div className="skeleton skeleton-line short" />
            <div className="skeleton skeleton-line" />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function BookSkeleton() {
  return (
    <div className="page book-page" aria-hidden>
      <div className="book-layout">
        <div className="skeleton book-hero-cover" style={{ aspectRatio: '1' }} />
        <div>
          <div className="skeleton skeleton-title" />
          <div className="skeleton skeleton-line short" />
          <div className="skeleton skeleton-button" />
        </div>
      </div>
    </div>
  );
}
