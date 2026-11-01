// The identity headers, which say what is asking on every API request: this
// receiver, its version and the Cast device in coarse terms, a header per
// field.

import { APP, PLATFORM, VERSION } from './config.js';

const MAX_VALUE = 100;

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

/**
 * The identity headers for a device's user agent. Each value keeps
 * printable ASCII only and at most 100 characters; one left empty is left
 * out.
 */
export function identityHeaders(userAgent) {
  const device = deviceOf(userAgent);
  const fields = [
    ['Kivo-App', APP],
    ['Kivo-App-Version', VERSION],
    ['Kivo-Platform', PLATFORM],
    ['Kivo-OS-Version', device.osVersion],
    ['Kivo-Device-Model', device.model],
  ];
  const out = {};
  for (const [name, v] of fields) {
    const value = String(v ?? '').replace(/[^\x20-\x7e]/g, '').slice(0, MAX_VALUE);
    if (value) out[name] = value;
  }
  return out;
}
