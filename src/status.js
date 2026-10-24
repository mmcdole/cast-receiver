// What senders learn of a cast. Every sender on the network can read the
// receiver's status, so it never holds the cast token or a play's ID, which
// is a credential: media URLs (the content's and its text tracks') are
// left out.

/**
 * The receiver's own status, which senders draw their menus and stream
 * info from: the play's decisions and choices, up next, and any error.
 */
export function kivoStatus(s) {
  const out = { error: s.error || null };
  if (s.workId) out.workId = s.workId;
  if (s.nextWorkId) out.nextWorkId = s.nextWorkId;
  const p = s.started;
  if (p) {
    out.versionId = p.versionId;
    out.decision = p.decision;
    if (p.quality) out.quality = p.quality;
    if (p.limitBps) out.limitBps = p.limitBps;
    if (p.dialogueBoost) out.dialogueBoost = p.dialogueBoost;
    if (p.audioTrackId) out.audioTrackId = p.audioTrackId;
    const subtitle = s.shownSubtitle ?? p.subtitleTrackId;
    if (subtitle && subtitle !== 'off') out.subtitleTrackId = subtitle;
    if (p.subtitleTracks) out.subtitleTracks = p.subtitleTracks;
    out.local = p.local;
  }
  if (s.upNext && s.upNext.phase !== 'hidden') out.upNext = { phase: s.upNext.phase, secondsLeft: s.upNext.secondsLeft };
  if (s.errorMessage) out.message = s.errorMessage;
  return out;
}

/**
 * A MEDIA_STATUS message cleaned for every sender to read, with the
 * receiver's status added. Every media object in it is cleaned, the queue's
 * items too, which the framework fills from the sender's LOAD as it came,
 * token and all. It's a copy: the media in a status can be the very object
 * the player is loading from, and a status sent mid-load would take its URL.
 */
export function sanitizeMediaStatus(status, kivo) {
  if (!status) return status;
  const out = JSON.parse(JSON.stringify(status));
  clean(out, kivo, 0, true);
  out.customData = { kivo };
  return out;
}

/**
 * Cleans media objects, or anything holding them, in place: the queue's
 * items, which a sender can ask for. With urls false, the media URLs stay,
 * as they must while the player is still loading from them.
 */
export function sanitizeMedia(v, kivo, urls = true) {
  clean(v, kivo, 0, urls);
}

function clean(v, kivo, depth, urls) {
  if (v === null || typeof v !== 'object' || depth > 8) return;
  if (Array.isArray(v)) {
    for (const x of v) clean(x, kivo, depth + 1, urls);
    return;
  }
  const media = 'contentId' in v || 'contentUrl' in v || 'entity' in v || 'streamType' in v;
  delete v.token;
  if (urls) {
    delete v.contentUrl;
    delete v.trackContentId;
  }
  // A load this receiver started keeps its marker, which is no secret.
  if (media) v.customData = v.customData?.prepared ? { kivo, prepared: v.customData.prepared } : { kivo };
  for (const x of Object.values(v)) clean(x, kivo, depth + 1, urls);
}

/** customData from a sender's LOAD with the token taken out, so it can't be echoed. */
export function takeToken(customData) {
  const token = customData?.token;
  if (customData) delete customData.token;
  return token;
}
