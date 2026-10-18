// Stand-ins for the Cast receiver framework, the screens and the server, so
// the receiver's logic runs under node.

class Track {
  constructor(trackId, type) { this.trackId = trackId; this.type = type; }
}

export class FakePlayer {
  constructor() {
    this.interceptors = {};
    this.listeners = {};
    this.state = 'IDLE';
    this.time = 0;
    this.loads = [];
    this.active = [];
    this.stopped = 0;
  }
  setMessageInterceptor(type, fn) { this.interceptors[type] = fn; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  emit(type, e = {}) { for (const fn of this.listeners[type] || []) fn({ type, ...e }); }
  getCurrentTimeSec() { return this.time; }
  getPlayerState() { return this.state; }
  seek(t) { this.time = t; }
  stop() { this.stopped++; this.state = 'IDLE'; this.emit('MEDIA_FINISHED', { endedReason: 'STOPPED' }); }
  getTextTracksManager() { return { setActiveByIds: (ids) => { this.active = ids; } }; }
  setMediaElement() {}
  getQueueManager() { return { getItems: () => this.queue || [] }; }
  /**
   * A sender's LOAD, through the interceptor, as the framework sends it: it
   * queues a copy of the request as it came first.
   */
  async senderLoad(req) {
    this.queue = [{ itemId: 1, media: JSON.parse(JSON.stringify(req.media)) }];
    this.emit('PLAYER_LOADING');
    const out = await this.interceptors.LOAD(req);
    if (out && out.media) this.loads.push(out);
    return out;
  }
  /** The receiver's own load: queued with its own media, then through the interceptor too. */
  async load(req) {
    this.queue = [{ itemId: 1, media: req.media }];
    this.emit('PLAYER_LOADING');
    const out = await this.interceptors.LOAD(req);
    this.loads.push(out);
    return out;
  }
}

export function fakeFramework() {
  const player = new FakePlayer();
  const context = {
    listeners: {},
    messages: [],
    stopped: false,
    getPlayerManager: () => player,
    addCustomMessageListener(ns, fn) { this.listeners[ns] = fn; },
    addEventListener() {},
    sendCustomMessage(ns, sender, data) { this.messages.push({ ns, data }); },
    start() {},
    stop() { this.stopped = true; },
    canDisplayType: (mime, codecs) => ['avc1.42E01E', 'avc1.4D401F', 'avc1.640028', 'avc1.640029', 'mp4a.40.2', 'ac-3'].includes(codecs),
    getDeviceCapabilities: () => ({}),
  };
  const messages = {
    MessageType: { LOAD: 'LOAD', MEDIA_STATUS: 'MEDIA_STATUS', EDIT_TRACKS_INFO: 'EDIT_TRACKS_INFO' },
    StreamType: { BUFFERED: 'BUFFERED' },
    HlsSegmentFormat: { FMP4: 'fmp4' },
    HlsVideoSegmentFormat: { FMP4: 'fmp4' },
    TrackType: { TEXT: 'TEXT' },
    TextTrackType: { SUBTITLES: 'SUBTITLES' },
    ErrorType: { LOAD_FAILED: 'LOAD_FAILED' },
    ErrorReason: { INVALID_REQUEST: 'INVALID_REQUEST' },
    Track,
    MediaInformation: class {},
    LoadRequestData: class {},
    MovieMediaMetadata: class { constructor() { this.metadataType = 1; } },
    TvShowMediaMetadata: class { constructor() { this.metadataType = 2; } },
    ErrorData: class { constructor(type) { this.type = type; } },
  };
  const E = ['PLAYER_LOADING', 'PLAYER_LOAD_COMPLETE', 'PLAYING', 'PAUSE', 'BUFFERING', 'SEEKED', 'TIME_UPDATE', 'ENDED', 'MEDIA_FINISHED', 'ERROR', 'REQUEST_PLAY', 'REQUEST_PAUSE', 'REQUEST_SEEK'];
  return {
    player,
    context,
    cf: {
      CastReceiverContext: { getInstance: () => context },
      messages,
      events: { EventType: Object.fromEntries(E.map((e) => [e, e])) },
      system: { EventType: { SHUTDOWN: 'SHUTDOWN', READY: 'READY' }, DeviceCapabilities: {} },
    },
  };
}

/** Screens that remember what they were last asked to show. */
export class FakeUI {
  constructor() { this.screen = 'launch'; this.last = {}; this.images = []; this.card = undefined; }
  launching() { this.screen = 'launch'; }
  idle(urls) { this.screen = 'idle'; this.last = { urls }; }
  loading(x) { this.screen = 'loading'; this.last = x; }
  playing() { this.screen = 'playing'; }
  paused(x) { this.screen = x.buffering ? 'buffering' : 'paused'; this.last = x; }
  progress() {}
  get pausedShowing() { return this.screen === 'paused' || this.screen === 'buffering'; }
  error(x) { this.screen = 'error'; this.last = x; }
  upNext(x) { this.card = x; }
  hideUpNext() { this.card = undefined; }
}

export const SERVER_ID = '01a14fd8-0000-7000-8000-000000000001';
export const WORK = '01a14fd8-0000-7000-8000-0000000000aa';
export const NEXT = '01a14fd8-0000-7000-8000-0000000000bb';

/**
 * A server's answers by "METHOD path", each a function of the request
 * returning [status, body], with every request recorded.
 */
export function fakeServer(routes) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const path = u.pathname.replace(/^\/api\/v1\//, '');
    const auth = init.headers?.Authorization;
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, url, auth, body, keepalive: init.keepalive });
    const key = Object.keys(routes).find((k) => {
      const [m, p] = k.split(' ');
      return m === method && new RegExp(`^${p}$`).test(path);
    });
    if (!key) throw new TypeError('network');
    const [status, json] = await routes[key]({ method, path, body, auth, url: u });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (json === undefined ? '' : JSON.stringify(json)),
      json: async () => json,
      blob: async () => new Blob(['img']),
    };
  };
  return { fetch, requests };
}

export function started(over = {}) {
  return {
    id: 'play-1', workId: WORK, versionId: 'v1', startMs: 60000, durationMs: 45 * 60000, local: true,
    delivery: { method: 'hls', url: 'plays/play-1/hls/index.m3u8' },
    decision: { summary: 'directStream', tracks: [{ type: 'subtitle', trackId: 's0', method: 'sidecar' }] },
    parts: [{ durationMs: 45 * 60000 }],
    subtitles: [
      { trackId: 's1', format: 'vtt', ready: true, url: 'plays/play-1/subtitles/s1.vtt' },
      { trackId: 's2', format: 'vtt', ready: false },
    ],
    subtitleTracks: [{ trackId: 's1', onSwitch: 'instant' }, { trackId: 's2', onSwitch: 'newPlay' }],
    audioTrackId: 'a1',
    chapters: [],
    ...over,
  };
}

export const episode = {
  id: WORK, kind: 'episode', title: 'Reload', durationMs: 45 * 60000,
  episode: { season: 3, number: 4, seriesTitle: 'The Expanse', seriesId: 'series', nextId: NEXT },
  images: { still: { id: 'img-still' }, backdrop: { id: 'img-back' } },
  versions: [{ id: 'v1', container: 'matroska,webm', tracks: [{ id: 's1', type: 'subtitle', language: 'en', title: 'English' }] }],
};

export const nextEpisode = {
  id: NEXT, kind: 'episode', title: 'Triple Point', durationMs: 45 * 60000,
  episode: { season: 3, number: 5, seriesTitle: 'The Expanse', seriesId: 'series' },
  images: { still: { id: 'img-next' } }, versions: [],
};

/** A sender's LOAD of WORK with a cast token. */
export function senderLoad(custom = {}, currentTime) {
  const req = {
    media: {
      contentId: WORK,
      metadata: { title: 'Reload', images: [{ url: 'https://sender.example/art.jpg' }] },
      customData: { kivo: 1, serverId: SERVER_ID, urls: ['http://192.0.2.10:8484', 'https://media.example'], token: 'SECRET-CAST-TOKEN', ...custom },
    },
  };
  if (currentTime !== undefined) req.currentTime = currentTime;
  return req;
}
