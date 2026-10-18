// Words and numbers the TV shows.

const MINUS = '−';

/** A position as the player shows it: 23:38, or 1:12:34 past an hour. */
export function clock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The time left, with a minus sign: −1:12:34. */
export function remaining(positionMs, durationMs) {
  return MINUS + clock(Math.max(0, durationMs - positionMs));
}

/** A running time: 1h 36m, or 44m under an hour. */
export function runtime(ms) {
  const minutes = Math.round(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** An episode's code: S3 · E4, or S3 · E4–E5 for a file of two. */
export function episodeCode(ep) {
  const end = ep.endNumber ? `–E${ep.endNumber}` : '';
  return `S${ep.season} · E${ep.number}${end}`;
}

/**
 * What the TV calls a work: its title, or an episode's series, and a line
 * under it. With `long`, a movie's line adds its running time, as the
 * loading screen shows it.
 */
export function heading(work, { long = false } = {}) {
  if (!work) return { title: '', sub: '' };
  if (work.episode) {
    return { title: work.episode.seriesTitle, sub: [episodeCode(work.episode), work.title].join(' · ') };
  }
  const parts = [];
  if (work.year) parts.push(String(work.year));
  if (long && work.durationMs) parts.push(runtime(work.durationMs));
  if (work.contentRating) parts.push(work.contentRating);
  return { title: work.title, sub: parts.join(' · ') };
}

/** The up-next card's line over the next episode's title: Next · S3 · E5. */
export function nextLine(next) {
  return next?.episode ? `Next · ${episodeCode(next.episode)}` : 'Next';
}
