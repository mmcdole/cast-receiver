// What senders learn of a cast. Every sender on the network can read the
// receiver's status, so it never holds the cast token or a play's ID, which
// is a credential: media URLs (the content's and its text tracks') are
// left out.

import * as legacy from './legacy.js'; // Migration (api-naming): remove after every client has updated past this release.

/**
 * The receiver's own status, which senders draw their menus and stream
 * info from: the play's tracks and choices, up next, and any error. The
 * tracks are the play's, with the subtitle showing marked selected, and
 * without the URLs of subtitle files, which hold the play's ID.
 */
export function receiverStatus(s) {
  const out = { error: s.error || null };
  if (s.workId) out.workId = s.workId;
  if (s.nextWorkId) out.nextWorkId = s.nextWorkId;
  const p = s.started;
  if (p) {
    const tracks = p.tracks || [];
    const subtitle = s.shownSubtitle ?? selected(tracks, 'subtitle') ?? 'off';
    out.versionId = p.versionId;
    out.tracks = tracks.map((t) => statusTrack(t, subtitle));
    if (p.quality) out.quality = p.quality;
    if (p.limitBps) out.limitBps = p.limitBps;
    if (p.dialogueBoost) out.dialogueBoost = p.dialogueBoost;
    const audio = selected(tracks, 'audio');
    if (audio) out.audioTrackId = audio;
    if (subtitle !== 'off') out.subtitleTrackId = subtitle;
    out.local = p.local;
  }
  if (s.upNext && s.upNext.phase !== 'hidden') out.upNext = { phase: s.upNext.phase, secondsLeft: s.upNext.secondsLeft };
  if (s.errorMessage) out.message = s.errorMessage;
  return out;
}

/** The ID of the track of type the play shows, if any. */
export function selected(tracks, type) {
  return tracks.find((t) => t.type === type && t.selected)?.trackId;
}

function statusTrack(t, subtitle) {
  const { url, fonts, selected: _, ...rest } = t;
  const shows = t.type === 'subtitle' ? t.trackId === subtitle : t.selected;
  return shows ? { ...rest, selected: true } : rest;
}

/**
 * A MEDIA_STATUS message cleaned for every sender to read, with the
 * receiver's status added. Every media object in it is cleaned, the queue's
 * items too, which the framework fills from the sender's LOAD as it came,
 * token and all. It's a copy: the media in a status can be the very object
 * the player is loading from, and a status sent mid-load would take its URL.
 */
export function sanitizeMediaStatus(mediaStatus, status) {
  if (!mediaStatus) return mediaStatus;
  const out = JSON.parse(JSON.stringify(mediaStatus));
  clean(out, status, 0, true);
  out.customData = legacy.withStatus({ status }); // Migration (api-naming): remove after every client has updated past this release.
  return out;
}

/**
 * Cleans media objects, or anything holding them, in place: the queue's
 * items, which a sender can ask for. With urls false, the media URLs stay,
 * as they must while the player is still loading from them.
 */
export function sanitizeMedia(v, status, urls = true) {
  clean(v, status, 0, urls);
}

function clean(v, status, depth, urls) {
  if (v === null || typeof v !== 'object' || depth > 8) return;
  if (Array.isArray(v)) {
    for (const x of v) clean(x, status, depth + 1, urls);
    return;
  }
  const media = 'contentId' in v || 'contentUrl' in v || 'entity' in v || 'streamType' in v;
  delete v.token;
  if (urls) {
    delete v.contentUrl;
    delete v.trackContentId;
  }
  // A load this receiver started keeps its marker, which is no secret.
  if (media) {
    const data = v.customData?.prepared ? { status, prepared: v.customData.prepared } : { status };
    v.customData = legacy.withStatus(data); // Migration (api-naming): remove after every client has updated past this release.
  }
  for (const x of Object.values(v)) clean(x, status, depth + 1, urls);
}

/** customData from a sender's LOAD with the token taken out, so it can't be echoed. */
export function takeToken(customData) {
  const token = customData?.token;
  if (customData) delete customData.token;
  return token;
}
