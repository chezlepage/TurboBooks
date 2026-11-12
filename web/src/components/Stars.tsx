interface Props {
  value: number | null;
  /** Omit for a read-only display. */
  onChange?: (value: number | null) => void;
  size?: number;
}

/** 1–5 stars. Tapping the current value again clears it. */
export function Stars({ value, onChange, size = 18 }: Props) {
  const v = value ?? 0;
  if (!onChange && !v) return null;
  return (
    <span className={`stars ${onChange ? 'stars-input' : ''}`} role={onChange ? 'radiogroup' : 'img'} aria-label={`${v} of 5 stars`}>
      {[1, 2, 3, 4, 5].map((n) => {
        const star = (
          <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
            <path
              d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z"
              fill={n <= v ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
          </svg>
        );
        return onChange ? (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={n === v}
            aria-label={`${n} star${n === 1 ? '' : 's'}`}
            className={n <= v ? 'on' : ''}
            onClick={() => onChange(n === v ? null : n)}
          >
            {star}
          </button>
        ) : (
          <span key={n} className={n <= v ? 'on' : ''}>
            {star}
          </span>
        );
      })}
    </span>
  );
}
