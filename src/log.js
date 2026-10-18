// The debug log: off unless the receiver's URL has ?debug. It goes to the
// console, Google's CastDebugLogger and, as JSON, to senders on the debug
// namespace. Tokens and play IDs never reach it: keys that can hold one are
// redacted, and URLs are cut to their path's shape.

const SECRET_KEYS = /^(token|authorization|contentUrl|trackContentId|url|urls|delivery|parts|subtitles|previews)$/i;

/** v with anything that can hold a credential replaced. */
export function redact(v, depth = 0) {
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (v === null || typeof v !== 'object' || depth > 6) return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(x, depth + 1);
  return out;
}

/** Whether ?debug is in the page's URL. */
export function debugEnabled(search) {
  return new URLSearchParams(search).has('debug');
}

export class Log {
  constructor(enabled) {
    this.enabled = enabled;
    this.sinks = [];
  }

  /** Adds a place lines go: fn(level, line, data). */
  to(fn) {
    if (this.enabled) this.sinks.push(fn);
  }

  info(msg, data) { this.write('info', msg, data); }
  error(msg, data) { this.write('error', msg, data); }

  write(level, msg, data) {
    if (!this.enabled) return;
    const clean = data === undefined ? undefined : redact(data);
    const line = clean === undefined ? msg : `${msg} ${JSON.stringify(clean)}`;
    for (const sink of this.sinks) {
      try { sink(level, line, clean); } catch { /* a sink failing doesn't stop the others */ }
    }
  }
}
