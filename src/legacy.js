// Migration (api-naming): remove after every client has updated past this release.
// Protocol 2, for senders and servers that still speak it: the receiver
// works in protocol 3 throughout, and these turn what a protocol 2 sender
// sends into protocol 3, add the protocol 2 status beside the protocol 3
// one, and add the protocol 2 names to what the receiver sends a server,
// which ignores names it doesn't know.

import { PROTOCOL } from './config.js';

// Migration (api-naming): remove after every client has updated past this release.
/** The oldest server protocol the receiver casts with. */
export const OLDEST_SERVER_PROTOCOL = 2;

// Migration (api-naming): remove after every client has updated past this release.
/**
 * A LOAD's customData in protocol 3. A protocol 2 LOAD (`kivo: 2`) names
 * its local quality `quality`. Anything else comes back as it is.
 */
export function load(custom) {
  if (custom?.kivo !== 2 || custom.protocol !== undefined) return custom;
  const { kivo, quality, ...rest } = custom;
  const out = { ...rest, protocol: PROTOCOL };
  if (quality !== undefined && out.localQuality === undefined) out.localQuality = quality;
  return out;
}

// Migration (api-naming): remove after every client has updated past this release.
/**
 * A sender's message in protocol 3: `kivo.upNext` with action `playNow` or
 * `hide`, `kivo.setDialogueBoost` with `on`, and `kivo.setQuality` with
 * `quality` become their protocol 3 forms. Anything else comes back as it is.
 */
export function message(msg) {
  switch (msg.type) {
    case 'kivo.upNext':
      if (msg.action === 'playNow') return { type: 'kivo.playNext' };
      if (msg.action === 'hide') return { type: 'kivo.hideUpNext' };
      return msg;
    case 'kivo.setDialogueBoost':
      return msg.enabled === undefined && msg.on !== undefined ? { ...msg, enabled: msg.on } : msg;
    case 'kivo.setQuality':
      return msg.localQuality === undefined && msg.quality !== undefined ? { ...msg, localQuality: msg.quality } : msg;
    default:
      return msg;
  }
}

// Migration (api-naming): remove after every client has updated past this release.
/** The receiver's status as protocol 2 senders read it: up next's countingDown is `showing`. */
export function status(s) {
  if (s?.upNext?.phase !== 'countingDown') return s;
  return { ...s, upNext: { ...s.upNext, phase: 'showing' } };
}

// Migration (api-naming): remove after every client has updated past this release.
/** customData holding the status under `status`, with the protocol 2 status added under `kivo`. */
export function withStatus(customData) {
  return { ...customData, kivo: status(customData.status) };
}

// Migration (api-naming): remove after every client has updated past this release.
/**
 * A `kivo.status` message with the protocol 2 status added under `kivo`,
 * where protocol 2 senders look for it first.
 */
export function statusMessage(msg) {
  const { type, ...s } = msg;
  return { ...msg, kivo: status(s) };
}

// Migration (api-naming): remove after every client has updated past this release.
/** A play's settings with the local quality also named `quality`, for a protocol 2 server. */
export function settings(s) {
  return s.localQuality === undefined ? s : { ...s, quality: s.localQuality };
}

// Migration (api-naming): remove after every client has updated past this release.
/** A capability report whose video entries also name their frame rate `maxFramerate`, for a protocol 2 server. */
export function capabilities(caps) {
  const video = (caps.video || []).map((v) => (v.maxFrameRate === undefined ? v : { ...v, maxFramerate: v.maxFrameRate }));
  return { ...caps, video };
}

// Migration (api-naming): remove after every client has updated past this release.
/** An episode's season number, from a protocol 3 server's `seasonNumber` or a protocol 2 server's `season`. */
export function season(episode) {
  return episode?.seasonNumber ?? episode?.season;
}
