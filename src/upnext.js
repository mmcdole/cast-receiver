// Up next for an episode with a next one, by the same rules as every other
// player: its card a fixed time before the end, counting the seconds left,
// the next episode when this one ends, and "Still watching?" after three
// episodes played on without input.

/** Episodes played on by themselves before asking "Still watching?". */
export const AUTOPLAY_LIMIT = 3;
const MIN_EPISODE_MS = 10 * 60000;
const MIN_LEFT_MS = 20000;

/**
 * Where the card appears in an episode of durationMs: 30 seconds before the
 * end, 35 for one of 40 minutes or more, 40 for 50 minutes or more;
 * undefined for one shorter than 10 minutes.
 */
export function showAtMs(durationMs) {
  if (durationMs < MIN_EPISODE_MS) return undefined;
  const lead = durationMs >= 50 * 60000 ? 40000 : durationMs >= 40 * 60000 ? 35000 : 30000;
  return durationMs - lead;
}

/** The card's state: hidden, countingDown (counting the seconds left), dismissed, or stillWatching. */
export const hidden = Object.freeze({ phase: 'hidden', secondsLeft: 0 });

/** Whether the card shows. */
export function shows(s) {
  return s.phase === 'countingDown' || s.phase === 'stillWatching';
}

/** The whole seconds left in an episode of durationMs at positionMs. */
function secondsToEnd(positionMs, durationMs) {
  return Math.max(0, Math.ceil((durationMs - positionMs) / 1000));
}

/**
 * The card at positionMs: it appears at its time with 20 seconds or more
 * left, asking "Still watching?" unless autoplay is allowed, and a position
 * before its time hides it again. Counting down, it counts the seconds left in the
 * episode. The same object when nothing changes.
 */
export function at(s, positionMs, durationMs, autoplayAllowed) {
  const when = showAtMs(durationMs);
  if (positionMs < (when ?? durationMs - MIN_LEFT_MS)) return s.phase === 'hidden' ? s : hidden;
  const secondsLeft = secondsToEnd(positionMs, durationMs);
  if (s.phase === 'countingDown') return secondsLeft === s.secondsLeft ? s : { ...s, secondsLeft };
  const appears = s.phase === 'hidden' && when !== undefined && durationMs - positionMs >= MIN_LEFT_MS;
  if (!appears) return s;
  return autoplayAllowed ? { phase: 'countingDown', secondsLeft } : { phase: 'stillWatching', secondsLeft: 0 };
}

/** Hide: the card stays away for the rest of the episode, which still plays on at its end. */
export function hide(s) {
  return shows(s) ? { ...s, phase: 'dismissed' } : s;
}

/**
 * What follows a video playing to its end: the next episode, unless three
 * have played on without input; with none next, or for anything but an
 * episode, the end of the cast.
 */
export function atEnd({ episode, hasNext, autoplayAllowed }) {
  if (!episode || !hasNext) return 'idle';
  return autoplayAllowed ? 'playNext' : 'stillWatching';
}
