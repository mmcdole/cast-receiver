// The Kivo-Client header, which says what is asking on every API request:
// this receiver, its version, the Cast device in coarse terms, and a random
// ID the receiver keeps for each server, never a hardware ID.

import { APP, PLATFORM, VERSION } from './config.js';

const MAX_VALUE = 100;

/** The storage key of the device ID for a server. */
export function deviceIdKey(serverId) {
  return `kivo.deviceId.${serverId}`;
}

/**
 * The device's ID for serverId: the one kept in storage, or a new random
 * one, kept for next time. Storage that can't be read or written gives an
 * ID for this load only.
 */
export function deviceId(serverId, storage, random = randomId) {
  const key = deviceIdKey(serverId);
  try {
    const kept = storage?.getItem(key);
    if (kept) return kept;
  } catch { /* no storage */ }
  const id = random();
  try { storage?.setItem(key, id); } catch { /* no storage */ }
  return id;
}

/**
 * The OS version and coarse model in a Cast device's user agent: the
 * CrKey version, and its DeviceType (Chromecast, AndroidTV and the like),
 * or just Chromecast when it names none.
 */
export function deviceOf(userAgent = '') {
  const crkey = /CrKey\/([\d.]+)/.exec(userAgent);
  const type = /DeviceType\/([A-Za-z0-9_-]+)/.exec(userAgent);
  const out = {};
  if (crkey) out.osVersion = crkey[1];
  if (type) out.model = type[1];
  else if (crkey) out.model = 'Chromecast';
  return out;
}

/** The header's value for a server, as an RFC 9651 dictionary of strings. */
export function clientHeader({ serverId, storage, userAgent, random }) {
  const device = deviceOf(userAgent);
  const fields = [
    ['app', APP],
    ['app-version', VERSION],
    ['platform', PLATFORM],
    ['os-version', device.osVersion],
    ['device-model', device.model],
    ['device-id', deviceId(serverId, storage, random)],
  ];
  return fields.filter(([, v]) => v).map(([k, v]) => `${k}=${sfString(v)}`).join(', ');
}

/** A structured-field string: printable ASCII, with quotes and backslashes escaped. */
function sfString(v) {
  const ascii = String(v).replace(/[^\x20-\x7e]/g, '').slice(0, MAX_VALUE);
  return `"${ascii.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

function randomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const b = globalThis.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
