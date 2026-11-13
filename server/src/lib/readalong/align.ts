/**
 * Lines an ebook's text up with a transcript of its audiobook, so each sentence knows when
 * it's read aloud. Speech recognition gets names and odd words wrong and audiobooks add and
 * drop bits (credits, front matter), so we don't need every word to match:
 *
 *  1. Anchors: runs of 5 words that occur exactly once in the book and once in the transcript.
 *  2. Keep the longest set of anchors that runs forwards in both (drops chance matches).
 *  3. Between neighbouring anchors, match the remaining words exactly (small LCS).
 *  4. A sentence starts at its first matched word; sentences with no match borrow a time
 *     from their neighbours, unless they sit in a long stretch the narrator never read.
 */

/** Lowercase letters and digits only, accents dropped: "Don’t," → "dont". */
export const norm = (w: string) =>
  w
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Splits text into words worth matching (punctuation-only tokens dropped). */
export const words = (text: string) => text.split(/[\s—–]+|(?<=\w)-(?=\w)/).map(norm).filter(Boolean);

export interface TimedWord {
  w: string;
  /** Seconds from the start of the audiobook. */
  t: number;
}

const N = 5;
/** Book/transcript stretches bigger than this between anchors aren't word-matched. */
const MAX_GAP_CELLS = 250_000;
/** A run of unmatched book words this long was probably not read aloud (e.g. a table of contents). */
const MAX_FILL_WORDS = 120;

/** Longest strictly increasing subsequence of `vals`; returns the indices into `vals`. */
function lis(vals: number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(vals.length).fill(-1);
  for (let i = 0; i < vals.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (vals[tails[mid]] < vals[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;
  }
  const out: number[] = [];
  for (let i = tails[tails.length - 1] ?? -1; i >= 0; i = prev[i]) out.push(i);
  return out.reverse();
}

/** Exact-word LCS between book[b0,b1) and transcript[t0,t1); pushes matched pairs in order. */
function matchGap(book: string[], tr: string[], b0: number, b1: number, t0: number, t1: number, out: [number, number][]) {
  const n = b1 - b0;
  const m = t1 - t0;
  if (n <= 0 || m <= 0 || n * m > MAX_GAP_CELLS) return;
  const dp = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = book[b0 + i] === tr[t0 + j] ? dp[at(i + 1, j + 1)] + 1 : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (book[b0 + i] === tr[t0 + j]) {
      out.push([b0 + i, t0 + j]);
      i++;
      j++;
    } else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) i++;
    else j++;
  }
}

/** For each book word, the index of the transcript word it was matched to (or -1). */
export function matchWords(book: string[], tr: string[]): Int32Array {
  const gram = (arr: string[], i: number) => arr.slice(i, i + N).join(' ');
  const count = (arr: string[]) => {
    const c = new Map<string, number>();
    for (let i = 0; i + N <= arr.length; i++) {
      const g = gram(arr, i);
      c.set(g, (c.get(g) ?? 0) + 1);
    }
    return c;
  };
  const inBook = count(book);
  const trAt = new Map<string, number>();
  const inTr = new Map<string, number>();
  for (let i = 0; i + N <= tr.length; i++) {
    const g = gram(tr, i);
    inTr.set(g, (inTr.get(g) ?? 0) + 1);
    trAt.set(g, i);
  }
  const anchors: [number, number][] = [];
  for (let i = 0; i + N <= book.length; i++) {
    const g = gram(book, i);
    if (inBook.get(g) === 1 && inTr.get(g) === 1) anchors.push([i, trAt.get(g)!]);
  }
  const kept = lis(anchors.map((a) => a[1])).map((k) => anchors[k]);

  // Anchors overlap (consecutive 5-grams); expand each to its 5 word pairs, skipping repeats.
  const pairs: [number, number][] = [];
  let lastB = -1;
  let lastT = -1;
  for (const [b, t] of kept) {
    if (b > lastB + 1 || t > lastT + 1) matchGap(book, tr, lastB + 1, b, lastT + 1, t, pairs);
    for (let k = 0; k < N; k++) {
      if (b + k > lastB && t + k > lastT) {
        pairs.push([b + k, t + k]);
        lastB = b + k;
        lastT = t + k;
      }
    }
  }
  const map = new Int32Array(book.length).fill(-1);
  for (const [b, t] of pairs) map[b] = t;
  return map;
}

/**
 * Start time (seconds) of each sentence, or null where it can't be placed.
 * `sentences` are the book's sentences in reading order.
 */
export function sentenceTimes(sentences: string[], transcript: TimedWord[]): (number | null)[] {
  const bookWords: string[] = [];
  const firstWord: number[] = [];
  for (const s of sentences) {
    firstWord.push(bookWords.length);
    bookWords.push(...words(s));
  }
  const map = matchWords(
    bookWords,
    transcript.map((w) => w.w),
  );
  const time = (b: number) => (map[b] >= 0 ? transcript[map[b]].t : null);

  // Matched word index at or before / after each book word.
  const prevMatch = new Int32Array(bookWords.length);
  const nextMatch = new Int32Array(bookWords.length);
  let p = -1;
  for (let i = 0; i < bookWords.length; i++) prevMatch[i] = p = map[i] >= 0 ? i : p;
  let q = -1;
  for (let i = bookWords.length - 1; i >= 0; i--) nextMatch[i] = q = map[i] >= 0 ? i : q;

  return sentences.map((_, si) => {
    const from = firstWord[si];
    const to = firstWord[si + 1] ?? bookWords.length;
    if (from === to) return null;
    for (let b = from; b < to; b++) {
      const t = time(b);
      if (t !== null) return t;
    }
    // No word of this sentence matched: interpolate between the neighbours if they're close.
    const before = prevMatch[from];
    const after = nextMatch[to - 1];
    if (before < 0 || after < 0 || after - before > MAX_FILL_WORDS) return null;
    const t0 = time(before)!;
    const t1 = time(after)!;
    return t0 + ((t1 - t0) * (from - before)) / (after - before);
  });
}
