// The media server's API, as the receiver uses it: with the cast token in
// the Authorization header, never in a URL, and never written to a log.

/** A request the server answered with a problem document. */
export class ApiError extends Error {
  constructor(status, problem) {
    super(problem?.code || `HTTP ${status}`);
    this.status = status;
    this.code = problem?.code || '';
    /** For playEnded, the admin's words, if any. */
    this.problemMessage = problem?.message || '';
    this.reason = problem?.reason || '';
  }
}

/** A request that got no answer: the server can't be reached. */
export class NetworkError extends Error {}

const TIMEOUT_MS = 15000;

async function send(fetchImpl, url, init, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
  } catch (e) {
    throw new NetworkError(e?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

/** The API root of a server's base URL: its /api/v1/ path. */
export function apiRoot(base) {
  return base.replace(/\/+$/, '') + '/api/v1/';
}

/** One server, reached at base, as the cast token's user. */
export class Server {
  constructor(base, token, fetchImpl = globalThis.fetch.bind(globalThis)) {
    this.root = apiRoot(base);
    this.token = token;
    this.fetch = fetchImpl;
  }

  /** An absolute URL for a path relative to the API root, such as a play's media. */
  url(path) {
    return new URL(path, this.root).href;
  }

  async request(method, path, body, { timeoutMs = TIMEOUT_MS, keepalive = false } = {}) {
    const headers = { Authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await send(this.fetch, this.url(path), {
      method, headers, keepalive, body: body === undefined ? undefined : JSON.stringify(body),
    }, timeoutMs);
    if (res.status === 204) {
      res.body?.cancel?.();
      return undefined;
    }
    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) throw new ApiError(res.status, json);
    return json;
  }

  start(body) { return this.request('POST', 'plays', body); }
  heartbeat(id, body) { return this.request('PATCH', `plays/${id}`, body); }
  stop(id, body, opts) { return this.request('POST', `plays/${id}/stop`, body, opts); }
  fallback(id, body) { return this.request('POST', `plays/${id}/fallback`, body); }
  work(id) { return this.request('GET', `works/${id}`); }
  home() { return this.request('GET', 'home'); }
  endToken(opts) { return this.request('DELETE', 'cast-tokens/current', undefined, opts); }

  /** An image as an object URL, fetched with the token; the caller revokes it. */
  async image(id, width) {
    const res = await send(this.fetch, this.url(`images/${id}?width=${width}`), {
      headers: { Authorization: `Bearer ${this.token}` },
    }, TIMEOUT_MS);
    if (!res.ok) throw new ApiError(res.status);
    return URL.createObjectURL(await res.blob());
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** A server answered, but not as the one the sender named, or it speaks another protocol. */
export class ServerMismatch extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind; // 'otherServer', 'serverOutdated' or 'receiverOutdated'
  }
}

const PROBE_TIMEOUT_MS = 4000;

/**
 * The first of urls that answers server info as the server serverId, with
 * its info. A server speaking another protocol is a ServerMismatch; none
 * answering is a NetworkError.
 */
export async function chooseServer(urls, serverId, protocol, fetchImpl = globalThis.fetch.bind(globalThis)) {
  let other = false;
  for (const base of urls) {
    let info;
    try {
      const res = await send(fetchImpl, apiRoot(base) + 'server', { credentials: 'omit' }, PROBE_TIMEOUT_MS);
      if (!res.ok) continue;
      info = await res.json();
    } catch {
      continue;
    }
    if (info?.id !== serverId) {
      other = true;
      continue;
    }
    if (info.castProtocol === undefined || info.castProtocol < protocol) throw new ServerMismatch('serverOutdated');
    if (info.castProtocol > protocol) throw new ServerMismatch('receiverOutdated');
    return { base, info };
  }
  if (other) throw new ServerMismatch('otherServer');
  throw new NetworkError('unreachable');
}
