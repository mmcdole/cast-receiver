// The receiver: it takes a sender's LOAD, starts the play itself as the
// cast token's user with this device's own capabilities, plays it, sends
// its heartbeats, and runs track changes and up next, so the cast goes on
// when every sender has gone. Senders read its state from the media status
// and send its own messages on NAMESPACE.

import { ApiError, NetworkError, Server, ServerMismatch, chooseServer } from './api.js';
import { capabilities } from './capabilities.js';
import { NAMESPACE, PROTOCOL } from './config.js';
import { clock, heading, nextLine } from './format.js';
import { kivoStatus, sanitizeMedia, sanitizeMediaStatus, takeToken } from './status.js';
import * as upnext from './upnext.js';

const HEARTBEAT_MS = 10000;
/** How long the server may go unanswered before the TV says it can't be reached. */
const UNREACHABLE_MS = 30000;
/** Idle this long, the receiver closes. */
const IDLE_CLOSE_MS = 5 * 60000;
/** Paused this long, the play stops. */
const PAUSED_STOP_MS = 20 * 60000;
/** Resuming after a pause this long goes back a few seconds. */
const LONG_PAUSE_MS = 5 * 60000;
const RESUME_REWIND_S = 5;
const BACKDROP_WIDTH = 1920;
const STILL_WIDTH = 640;
const IDLE_BACKDROPS = 6;

/** What the TV says for an error, by the status's error code. */
const errorLines = {
  signedOut: 'Signed out. Cast again from your phone.',
  playEnded: 'Playback was stopped.',
  serverUnreachable: "Can't reach the server.",
  otherServer: "Can't reach the server.",
  serverOutdated: 'Update the server to cast to this TV.',
  receiverOutdated: 'This receiver is older than the server. Try again later.',
  streamLimit: 'Stream limit reached. Stop another stream and try again.',
  notPlayable: "This can't be played on this TV.",
  playbackFailed: "This can't be played on this TV.",
  noFallback: "This can't be played on this TV.",
  transcodeBusy: "The server can't start another transcode right now. Try again shortly.",
  notFound: "This title isn't available.",
  invalidRequest: 'Something went wrong.',
};

export class Receiver {
  /**
   * cf is the Cast receiver framework (cast.framework); ui the screens;
   * log the debug log; fetch the network.
   */
  constructor({ cf, ui, log, fetch: fetchImpl = globalThis.fetch.bind(globalThis), now = () => Date.now() }) {
    this.cf = cf;
    this.context = cf.CastReceiverContext.getInstance();
    this.player = this.context.getPlayerManager();
    this.ui = ui;
    this.log = log;
    this.fetch = fetchImpl;
    this.now = now;

    this.server = undefined; // the Server, with the cast token
    this.choices = undefined; // what the play was asked for: the work, version, tracks, quality and boost
    this.started = undefined; // the play: PlayStarted
    this.work = undefined; // its work's detail
    this.next = undefined; // the next episode's detail, for the card
    this.autoplayRun = 0;
    this.upNext = upnext.hidden;
    this.shownSubtitle = undefined; // a subtitle switched to without a new play, or 'off'
    this.textTracks = new Map(); // the play's sidecar subtitles: Cast track ID → track ID
    this.positionMs = 0;
    this.durationMs = 0;
    this.error = undefined;
    this.errorMessage = '';
    this.fellBack = false;
    this.lastContact = 0;
    this.unreachable = false;
    this.restartWhenReachable = false;
    this.pausedAt = 0;
    this.prepared = undefined; // a play started here, which the next LOAD plays
    this.failing = undefined; // the play whose media error is being handled
    this.switching = false; // a new play replacing the current one is loading
    this.heartbeat = undefined;
    this.countdown = undefined;
    this.idleTimer = undefined;
    this.pausedTimer = undefined;
    this.objectUrls = [];
    this.generation = 0; // counts sender LOADs, so a slow idle screen doesn't cover a newer cast
    if (log.enabled) ui.onShow = (screen) => log.info('screen', { screen });
  }

  /** Wires the framework's messages and events, then starts the receiver. */
  start(options) {
    const { MessageType } = this.cf.messages;
    const E = this.cf.events.EventType;
    this.player.setMessageInterceptor(MessageType.LOAD, (req) => this.onLoad(req));
    this.player.setMessageInterceptor(MessageType.MEDIA_STATUS, (s) => sanitizeMediaStatus(s, this.status()));
    this.player.setMessageInterceptor(MessageType.EDIT_TRACKS_INFO, (req) => this.onEditTracks(req));
    this.player.addEventListener(E.PLAYING, () => this.onPlaying());
    this.player.addEventListener(E.PAUSE, () => this.onPause());
    this.player.addEventListener(E.BUFFERING, (e) => this.onBuffering(e.isBuffering));
    this.player.addEventListener(E.SEEKED, () => this.beat());
    this.player.addEventListener(E.TIME_UPDATE, (e) => this.onTime(e.currentMediaTime));
    this.player.addEventListener(E.ENDED, () => this.onEnded());
    this.player.addEventListener(E.MEDIA_FINISHED, (e) => this.onFinished(e.endedReason));
    for (const loaded of [E.PLAYER_LOADING, E.PLAYER_LOAD_COMPLETE]) this.player.addEventListener(loaded, () => this.cleanQueue());
    this.player.addEventListener(E.ERROR, (e) => this.onMediaError(e));
    for (const request of [E.REQUEST_PLAY, E.REQUEST_PAUSE, E.REQUEST_SEEK]) {
      this.player.addEventListener(request, () => { this.autoplayRun = 0; });
    }
    this.player.addEventListener(E.REQUEST_PLAY, () => this.onResumeRequest());
    this.context.addCustomMessageListener(NAMESPACE, (e) => this.onMessage(e.data));
    this.context.addEventListener(this.cf.system.EventType.SHUTDOWN, () => this.onShutdown());
    this.ui.launching();
    this.context.start(options);
  }

  // ---- Loading -------------------------------------------------------------

  /** A LOAD: a sender's cast, or a play this receiver started itself. */
  async onLoad(req) {
    const custom = req.media?.customData || {};
    if (this.prepared && custom.prepared === this.prepared.key) {
      const prepared = this.prepared;
      this.prepared = undefined;
      this.apply(req, prepared.started);
      return req;
    }
    return this.senderLoad(req, custom);
  }

  async senderLoad(req, custom) {
    const token = takeToken(custom);
    this.log.info('LOAD', { contentId: req.media?.contentId, customData: custom, currentTime: req.currentTime });
    if (custom.kivo !== PROTOCOL || !token || !Array.isArray(custom.urls) || !custom.serverId) {
      const kind = typeof custom.kivo === 'number' && custom.kivo > PROTOCOL ? 'receiverOutdated' : 'invalidRequest';
      await this.endPlay('replaced');
      this.fail(kind);
      return this.loadError();
    }
    const workId = workOf(req.media);
    this.generation++;
    await this.endPlay('replaced');
    this.clearError();
    this.clearTimer('idleTimer');
    this.fellBack = false;
    this.autoplayRun = Number.isInteger(custom.autoplayCount) ? custom.autoplayCount : 0;
    this.ui.loading({ title: req.media?.metadata?.title || '', sub: '', image: undefined });
    try {
      const { base } = await chooseServer(custom.urls, custom.serverId, PROTOCOL, this.fetch);
      this.server = new Server(base, token, this.fetch);
      this.contacted();
      this.choices = {
        workId,
        versionId: custom.versionId,
        audioTrackId: custom.audioTrackId,
        subtitleTrackId: custom.subtitleTrackId,
        dialogueBoost: custom.dialogueBoost,
        quality: custom.quality,
        remoteQuality: custom.remoteQuality,
      };
      const position = typeof req.currentTime === 'number' && req.currentTime >= 0 ? Math.round(req.currentTime * 1000) : undefined;
      const started = await this.startPlay({ ...this.choices, positionMs: position });
      this.apply(req, started);
      return req;
    } catch (e) {
      this.failWith(e);
      return this.loadError();
    }
  }

  /**
   * Starts a play of choices with this device's capabilities, and reads its
   * work (and the next episode) for the screens. A version in parts is
   * asked for again as one stream.
   */
  async startPlay(choices, overrides) {
    const body = { workId: choices.workId, capabilities: this.capabilities() };
    for (const k of ['versionId', 'audioTrackId', 'subtitleTrackId', 'quality', 'remoteQuality', 'positionMs']) {
      if (choices[k] !== undefined && choices[k] !== null && choices[k] !== '') body[k] = choices[k];
    }
    if (body.positionMs !== undefined) body.positionMs = Math.max(0, Math.round(body.positionMs));
    if (typeof choices.dialogueBoost === 'boolean') body.dialogueBoost = choices.dialogueBoost;
    if (overrides) body.overrides = overrides;
    const workP = this.work?.id === choices.workId ? Promise.resolve(this.work) : this.server.work(choices.workId);
    const started = await this.server.start(body);
    this.contacted();
    if (started.delivery.method === 'file' && started.parts.length > 1 && !overrides) {
      await this.server.stop(started.id, {}).catch(() => {});
      return this.startPlay(choices, { allowDirectPlay: false });
    }
    const work = await workP.catch(() => this.work);
    this.adopt(started, work);
    this.log.info('play started', { decision: started.decision, local: started.local });
    return started;
  }

  /** Makes started the current play, of work. */
  adopt(started, work) {
    const sameWork = this.work?.id === work?.id;
    this.started = started;
    this.work = work;
    this.durationMs = started.durationMs;
    this.positionMs = started.startMs;
    this.shownSubtitle = undefined;
    this.fellBack = this.fellBack && sameWork;
    if (!sameWork) {
      this.upNext = upnext.hidden;
      this.next = undefined;
      this.loadNext();
    }
    this.ui.loading({ ...heading(work, { long: true }), image: undefined });
    this.backdropFor(work).then((url) => {
      if (url && this.started === started && !this.playingNow()) this.ui.loading({ ...heading(work, { long: true }), image: url });
    });
    this.startHeartbeat();
  }

  /** Reads the next episode, for the up-next card. */
  loadNext() {
    const nextId = this.work?.episode?.nextId;
    if (!nextId) return;
    const work = this.work;
    this.server.work(nextId).then(async (next) => {
      if (this.work !== work) return;
      this.next = next;
      const still = next.images?.still || next.images?.backdrop;
      if (still) this.next.stillUrl = await this.image(still.id, STILL_WIDTH).catch(() => undefined);
    }).catch(() => {});
  }

  /** Fills a LOAD with the play: its media URL, format, start and subtitles. */
  apply(req, started) {
    const m = this.cf.messages;
    const media = req.media || (req.media = new m.MediaInformation());
    media.contentId = started.workId;
    media.contentUrl = this.server.url(started.delivery.url);
    media.streamType = m.StreamType.BUFFERED;
    if (started.delivery.method === 'hls') {
      media.contentType = 'application/x-mpegurl';
      media.hlsSegmentFormat = m.HlsSegmentFormat.FMP4;
      media.hlsVideoSegmentFormat = m.HlsVideoSegmentFormat.FMP4;
    } else {
      media.contentType = this.fileType(started.versionId);
    }
    media.duration = started.durationMs / 1000;
    const images = media.metadata?.images;
    media.metadata = this.metadata();
    if (images) media.metadata.images = images;
    media.customData = { kivo: PROTOCOL };
    this.textTracks = new Map();
    const tracks = [];
    let active;
    for (const s of started.subtitles || []) {
      if (s.format !== 'vtt' || !s.ready || !s.url) continue;
      const castId = tracks.length + 1;
      const t = new m.Track(castId, m.TrackType.TEXT);
      t.trackContentId = this.server.url(s.url);
      t.trackContentType = 'text/vtt';
      t.subtype = m.TextTrackType.SUBTITLES;
      const info = this.trackInfo(s.trackId);
      if (info?.language) t.language = info.language;
      t.name = info?.title || info?.language || `Subtitles ${castId}`;
      tracks.push(t);
      this.textTracks.set(castId, s.trackId);
      if (s.trackId === started.subtitleTrackId) active = castId;
    }
    media.tracks = tracks;
    req.activeTrackIds = active ? [active] : [];
    req.currentTime = started.startMs / 1000;
    req.autoplay = true;
  }

  metadata() {
    const m = this.cf.messages;
    const w = this.work;
    if (w?.episode) {
      const md = new m.TvShowMediaMetadata();
      md.title = w.title;
      md.seriesTitle = w.episode.seriesTitle;
      md.season = w.episode.season;
      md.episode = w.episode.number;
      return md;
    }
    const md = new m.MovieMediaMetadata();
    md.title = w?.title || '';
    if (w?.year) md.releaseDate = String(w.year);
    return md;
  }

  fileType(versionId) {
    const v = this.work?.versions?.find((x) => x.id === versionId);
    return v?.container?.includes('webm') && !v.container.includes('mp4') ? 'video/webm' : 'video/mp4';
  }

  trackInfo(trackId) {
    for (const v of this.work?.versions || []) {
      const t = v.tracks?.find((x) => x.id === trackId);
      if (t) return t;
    }
    return undefined;
  }

  /** Plays a play started here, through a LOAD of its own. */
  async loadStarted(started) {
    const m = this.cf.messages;
    const req = new m.LoadRequestData();
    req.media = new m.MediaInformation();
    req.media.contentId = started.workId;
    // A random marker, not the play's ID: the framework can show it to senders.
    const key = Math.random().toString(36).slice(2);
    req.media.customData = { kivo: PROTOCOL, prepared: key };
    this.prepared = { key, started };
    this.switching = true;
    try {
      await this.player.load(req);
    } finally {
      this.switching = false;
    }
  }

  /**
   * A new play at the position with changed choices: another audio track, a
   * subtitle the play can't switch to by itself, the dialogue boost, the
   * quality or the version.
   */
  async switchTo(changes) {
    if (!this.started || !this.server) return;
    const positionMs = this.currentMs();
    this.choices = { ...this.choices, ...changes };
    this.switching = true;
    try {
      await this.endPlay('switched', positionMs);
      const started = await this.startPlay({ ...this.choices, positionMs });
      await this.loadStarted(started);
    } catch (e) {
      this.failWith(e);
    } finally {
      this.switching = false;
    }
  }

  /** The next episode, on its own when the countdown ran out or by a sender's Play now. */
  async playNext(automatic) {
    const nextId = this.work?.episode?.nextId;
    if (!nextId || !this.server) return;
    this.autoplayRun = automatic ? this.autoplayRun + 1 : 0;
    const positionMs = this.currentMs();
    this.switching = true;
    try {
      await this.endPlay('next', positionMs);
      this.choices = { ...this.choices, workId: nextId, versionId: undefined, audioTrackId: undefined, subtitleTrackId: undefined };
      const started = await this.startPlay(this.choices);
      await this.loadStarted(started);
    } catch (e) {
      this.failWith(e);
    } finally {
      this.switching = false;
    }
  }

  /** Starts the play again at its position: the server lost it, as on a restart. */
  async restart() {
    if (!this.choices || !this.server) return;
    const positionMs = this.currentMs();
    this.started = undefined;
    try {
      const started = await this.startPlay({ ...this.choices, positionMs });
      await this.loadStarted(started);
    } catch (e) {
      this.failWith(e);
    }
  }

  // ---- Playback events -------------------------------------------------------

  onPlaying() {
    if (!this.started) return;
    this.clearTimer('pausedTimer');
    this.clearTimer('idleTimer');
    this.pausedAt = 0;
    if (!this.unreachable && !this.error) this.ui.playing();
    this.renderUpNext();
    this.beat('playing');
  }

  onPause() {
    if (!this.started) return;
    this.pausedAt = this.now();
    this.showPaused(false);
    this.beat('paused');
    this.clearTimer('pausedTimer');
    this.pausedTimer = setTimeout(() => this.stopFromPause(), PAUSED_STOP_MS);
  }

  onBuffering(buffering) {
    if (!this.started || this.unreachable || this.error) return;
    if (buffering) {
      if (this.playingNow() || this.ui.pausedShowing) this.showPaused(true);
      return;
    }
    if (this.playerState() === 'PAUSED') this.showPaused(false);
    else if (this.playerState() === 'PLAYING') this.ui.playing();
  }

  /** Resuming after a long pause goes back a few seconds, to pick up the thread. */
  onResumeRequest() {
    if (this.pausedAt && this.now() - this.pausedAt > LONG_PAUSE_MS) {
      const t = this.player.getCurrentTimeSec();
      this.player.seek(Math.max(0, t - RESUME_REWIND_S));
    }
  }

  onTime(seconds) {
    if (!this.started || typeof seconds !== 'number') return;
    this.positionMs = Math.round(seconds * 1000);
    if (this.ui.pausedShowing) this.ui.progress(this.positionMs, this.durationMs);
    if (this.work?.episode?.nextId) {
      const before = this.upNext;
      this.upNext = upnext.at(this.upNext, this.positionMs, this.durationMs, this.autoplayRun < upnext.AUTOPLAY_LIMIT);
      if (before !== this.upNext) this.renderUpNext();
    }
  }

  async onEnded() {
    if (!this.started) return;
    this.positionMs = this.durationMs;
    await this.beat('ended');
    const next = upnext.atEnd({
      episode: Boolean(this.work?.episode), hasNext: Boolean(this.work?.episode?.nextId),
      autoplayAllowed: this.autoplayRun < upnext.AUTOPLAY_LIMIT,
    });
    if (next === 'playNext') return this.playNext(true);
    if (next === 'stillWatching') {
      this.upNext = { phase: 'stillWatching', secondsLeft: upnext.COUNTDOWN_SECONDS };
      this.renderUpNext();
      await this.endPlay('ended', this.durationMs);
      this.idleSoon();
      return;
    }
    await this.endPlay('ended', this.durationMs);
    this.goIdle();
  }

  /** The media ended other than at its end: a sender's Stop, or another LOAD. */
  async onFinished(reason) {
    if (reason !== 'STOPPED' || this.switching || !this.started) return;
    await this.endPlay('stopped', this.positionMs);
    this.goIdle();
  }

  // ---- Heartbeats and errors ---------------------------------------------

  startHeartbeat() {
    this.clearInterval('heartbeat');
    this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
  }

  /** Reports the position and keeps the play alive. */
  async beat(state) {
    const play = this.started;
    if (!play || !this.server) return;
    const body = { positionMs: Math.max(0, Math.round(this.currentMs())), state: state || this.heartbeatState() };
    if (this.shownSubtitle) body.subtitleTrackId = this.shownSubtitle;
    try {
      await this.server.heartbeat(play.id, body);
      this.contacted();
    } catch (e) {
      if (this.started !== play) return;
      this.onPlayProblem(e);
    }
  }

  heartbeatState() {
    switch (this.playerState()) {
      case 'PAUSED': return 'paused';
      case 'BUFFERING': return 'buffering';
      default: return 'playing';
    }
  }

  /** A heartbeat's or a request's failure while playing. */
  onPlayProblem(e) {
    if (e instanceof ApiError && e.status === 401) return this.fail('signedOut');
    if (e instanceof ApiError && e.code === 'playEnded') return this.fail('playEnded', e.problemMessage);
    if (e instanceof ApiError && e.status === 404) return this.restart();
    if (e instanceof NetworkError) return this.checkReachable();
    this.log.error('request failed', { status: e.status, code: e.code });
  }

  /** The server answered: an error saying it couldn't be reached clears. */
  contacted() {
    this.lastContact = this.now();
    if (!this.unreachable) return;
    this.unreachable = false;
    this.setError(undefined);
    if (this.restartWhenReachable) {
      this.restartWhenReachable = false;
      this.restart();
      return;
    }
    if (this.playerState() === 'PAUSED') this.showPaused(false);
    else this.ui.playing();
  }

  /** After 30 seconds without an answer, the TV says the server can't be reached. */
  checkReachable() {
    if (this.unreachable || this.now() - this.lastContact < UNREACHABLE_MS) return;
    this.unreachable = true;
    this.setError('serverUnreachable');
    this.ui.error({ line: errorLines.serverUnreachable, sub: this.errorSub(), image: undefined });
  }

  /**
   * The player failed. With the server reachable, the play falls back once
   * to a transcode at the position; after that, it can't play here.
   */
  async onMediaError(e) {
    const play = this.started;
    // The framework reports one failure more than once, and the first
    // report claims it before anything is awaited: a second one handled
    // alongside would end the cast while the first falls back.
    if (!play || this.switching || this.failing === play) return;
    this.failing = play;
    try {
      await this.recover(play, e);
    } finally {
      if (this.failing === play) this.failing = undefined;
    }
  }

  async recover(play, e) {
    this.log.error('media error', { detailedErrorCode: e.detailedErrorCode, reason: e.reason });
    try {
      await this.server.request('GET', 'server', undefined, { timeoutMs: 4000 });
      this.contacted();
    } catch {
      this.restartWhenReachable = true;
      this.lastContact = Math.min(this.lastContact, this.now() - UNREACHABLE_MS);
      this.checkReachable();
      return;
    }
    if (this.fellBack) return this.fail('playbackFailed');
    this.fellBack = true;
    try {
      const started = await this.server.fallback(play.id, {
        positionMs: Math.round(this.currentMs()), code: failureCode(e.detailedErrorCode), detail: String(e.detailedErrorCode || ''),
      });
      this.adopt(started, this.work);
      await this.loadStarted(started);
    } catch (err) {
      this.failWith(err);
    }
  }

  /** Shows an error that ends the cast: the play is gone or can't go on. */
  fail(code, message) {
    const sub = this.errorSub();
    const image = this.ui.images?.[0];
    this.started = undefined;
    this.clearInterval('heartbeat');
    this.setError(code, message);
    if (this.playerState() !== 'IDLE') {
      this.switching = true;
      try { this.player.stop(); } catch { /* nothing playing */ }
      this.switching = false;
    }
    this.ui.error({ line: message || errorLines[code] || 'Something went wrong.', sub, image });
    this.idleSoon();
  }

  failWith(e) {
    this.log.error('cast failed', { name: e?.name, status: e?.status, code: e?.code, kind: e?.kind });
    if (e instanceof ServerMismatch) return this.fail(e.kind);
    if (e instanceof NetworkError) return this.fail('serverUnreachable');
    if (e instanceof ApiError) {
      if (e.status === 401) return this.fail('signedOut');
      if (e.code === 'playEnded') return this.fail('playEnded', e.problemMessage);
      return this.fail(e.code || 'invalidRequest');
    }
    this.fail('invalidRequest');
  }

  loadError() {
    const m = this.cf.messages;
    const err = new m.ErrorData(m.ErrorType.LOAD_FAILED);
    err.reason = m.ErrorReason.INVALID_REQUEST;
    return err;
  }

  errorSub() {
    if (!this.work) return '';
    const { title } = heading(this.work);
    return this.positionMs > 0 ? `${title} · ${clock(this.positionMs)}` : title;
  }

  setError(code, message = '') {
    this.error = code;
    this.errorMessage = message;
    this.broadcast();
  }

  clearError() {
    this.unreachable = false;
    this.restartWhenReachable = false;
    this.setError(undefined);
  }

  // ---- Ending ----------------------------------------------------------------

  /** Stops the current play on the server, saving the position. */
  async endPlay(why, positionMs = this.currentMs()) {
    const play = this.started;
    this.clearInterval('heartbeat');
    this.clearTimer('pausedTimer');
    if (!play || !this.server) return;
    this.started = undefined;
    this.log.info('play ends', { why });
    try {
      await this.server.stop(play.id, { positionMs: Math.max(0, Math.round(positionMs)) });
    } catch {
      // The play expires on the server by itself.
    }
  }

  async stopFromPause() {
    await this.endPlay('paused', this.currentMs());
    this.switching = true;
    try { this.player.stop(); } catch { /* nothing playing */ }
    this.switching = false;
    this.goIdle();
  }

  /** Nothing plays: the idle screen with the user's backdrops, then closing after 5 minutes. */
  async goIdle() {
    const generation = this.generation;
    this.upNext = upnext.hidden;
    this.ui.idle([]);
    this.idleSoon();
    this.broadcast();
    const urls = await this.idleBackdrops().catch(() => []);
    if (generation === this.generation && !this.started && !this.error && urls.length > 0) this.ui.idle(urls);
  }

  idleSoon() {
    this.clearTimer('idleTimer');
    this.idleTimer = setTimeout(() => this.context.stop(), IDLE_CLOSE_MS);
  }

  /** The cast token's user's recently added backdrops. */
  async idleBackdrops() {
    if (!this.server) return [];
    const home = await this.server.home();
    const ids = [];
    for (const row of home?.rows || []) {
      if (row.kind !== 'recentlyAdded') continue;
      for (const item of row.items || []) {
        const b = item.images?.backdrop;
        if (b && !ids.includes(b.id)) ids.push(b.id);
      }
    }
    const urls = [];
    for (const id of ids.slice(0, IDLE_BACKDROPS)) {
      const url = await this.image(id, BACKDROP_WIDTH).catch(() => undefined);
      if (url) urls.push(url);
    }
    return urls;
  }

  async onShutdown() {
    const play = this.started;
    if (play && this.server) {
      this.started = undefined;
      this.server.stop(play.id, { positionMs: Math.round(this.currentMs()) }, { keepalive: true }).catch(() => {});
    }
    this.server?.endToken({ keepalive: true }).catch(() => {});
  }

  // ---- Senders -----------------------------------------------------------------

  /** A message on NAMESPACE from a sender. */
  async onMessage(data) {
    const msg = typeof data === 'string' ? safeParse(data) : data;
    if (!msg || typeof msg.type !== 'string') return;
    this.log.info('message', { type: msg.type });
    switch (msg.type) {
      case 'kivo.token':
        if (typeof msg.token === 'string' && this.server) this.server.token = msg.token;
        return;
      case 'kivo.setTracks':
        this.autoplayRun = 0;
        return this.setTracks(msg);
      case 'kivo.setDialogueBoost':
        return this.switchTo({ dialogueBoost: Boolean(msg.on) });
      case 'kivo.setQuality':
        return this.switchTo({ quality: msg.quality, remoteQuality: msg.remoteQuality });
      case 'kivo.setVersion':
        return this.switchTo({ versionId: msg.versionId, audioTrackId: undefined, subtitleTrackId: undefined });
      case 'kivo.upNext':
        this.autoplayRun = 0;
        if (msg.action === 'playNow') return this.playNext(false);
        if (msg.action === 'hide') {
          this.upNext = upnext.hide(this.upNext);
          this.renderUpNext();
        }
        return;
      case 'kivo.getStatus':
        return this.broadcast();
    }
  }

  /**
   * Audio always starts a new play. A subtitle shows at once when the play
   * can switch to it by itself; otherwise it starts a new play too.
   */
  async setTracks({ audioTrackId, subtitleTrackId }) {
    if (!this.started) return;
    if (audioTrackId && audioTrackId !== this.started.audioTrackId) {
      return this.switchTo({ audioTrackId, ...(subtitleTrackId ? { subtitleTrackId } : {}) });
    }
    if (!subtitleTrackId) return;
    if (this.instantSubtitle(subtitleTrackId)) {
      const castId = [...this.textTracks].find(([, id]) => id === subtitleTrackId)?.[0];
      this.player.getTextTracksManager().setActiveByIds(castId ? [castId] : []);
      this.shownSubtitle = subtitleTrackId;
      this.beat();
      this.broadcast();
      return;
    }
    return this.switchTo({ subtitleTrackId });
  }

  /**
   * Whether the play shows a subtitle choice by itself: off, or a sidecar
   * file, while the play's own subtitle isn't burned in or in its stream.
   */
  instantSubtitle(trackId) {
    const own = this.started.decision?.tracks?.find((t) => t.type === 'subtitle');
    if (own && (own.method === 'burnIn' || own.method === 'stream')) return false;
    if (trackId === 'off') return true;
    const sw = this.started.subtitleTracks?.find((t) => t.trackId === trackId);
    return sw?.onSwitch === 'instant' && [...this.textTracks.values()].includes(trackId);
  }

  /** A stock sender's subtitle switch, among the play's sidecar tracks. */
  onEditTracks(req) {
    const ids = req.activeTrackIds;
    if (Array.isArray(ids) && this.started) {
      const text = ids.map((id) => this.textTracks.get(id)).filter(Boolean);
      this.shownSubtitle = text[0] || 'off';
      setTimeout(() => this.beat(), 0);
    }
    return req;
  }

  /**
   * Cleans the framework's queue items, which it keeps as the sender's LOAD
   * came, token and all, and gives any sender that asks for the queue.
   */
  cleanQueue() {
    let items = [];
    try { items = this.player.getQueueManager()?.getItems() || []; } catch { /* no queue */ }
    sanitizeMedia(items, this.status());
  }

  /** The receiver's own status, for the media status and its namespace. */
  status() {
    return kivoStatus({
      workId: this.work?.id, nextWorkId: this.work?.episode?.nextId, started: this.started,
      shownSubtitle: this.shownSubtitle, upNext: this.upNext, error: this.error, errorMessage: this.errorMessage,
    });
  }

  broadcast() {
    try {
      this.context.sendCustomMessage(NAMESPACE, undefined, { type: 'kivo.status', ...this.status() });
    } catch {
      // No sender connected.
    }
  }

  // ---- Screens -------------------------------------------------------------

  showPaused(buffering) {
    if (this.unreachable || this.error) return;
    this.ui.paused({ ...heading(this.work), positionMs: this.currentMs(), durationMs: this.durationMs, buffering });
  }

  renderUpNext() {
    const s = this.upNext;
    if (!upnext.shows(s) || !this.work?.episode?.nextId) {
      this.ui.hideUpNext();
      this.clearInterval('countdown');
      return;
    }
    const next = this.next;
    this.ui.upNext({
      image: next?.stillUrl, line: nextLine(next), title: next?.title || '', secondsLeft: s.secondsLeft,
      stillWatching: s.phase === 'stillWatching',
    });
    if (s.phase === 'showing' && !this.countdown) {
      this.countdown = setInterval(() => this.countDown(), 1000);
    }
    this.broadcast();
  }

  countDown() {
    this.upNext = upnext.tick(this.upNext, this.playingNow());
    if (upnext.playsNext(this.upNext)) {
      this.clearInterval('countdown');
      this.upNext = upnext.hidden;
      this.ui.hideUpNext();
      this.playNext(true);
      return;
    }
    this.renderUpNext();
  }

  async backdropFor(work) {
    const img = work?.images?.backdrop || work?.images?.still;
    if (!img) return undefined;
    return this.image(img.id, BACKDROP_WIDTH).catch(() => undefined);
  }

  /** An image's object URL; the oldest are let go so a long cast doesn't fill the memory. */
  async image(id, width) {
    const url = await this.server.image(id, width);
    this.objectUrls.push(url);
    while (this.objectUrls.length > 24) URL.revokeObjectURL(this.objectUrls.shift());
    return url;
  }

  // ---- Helpers ---------------------------------------------------------------

  capabilities() {
    let device = {};
    try { device = this.context.getDeviceCapabilities() || {}; } catch { /* not ready */ }
    const caps = this.cf.system.DeviceCapabilities || {};
    return capabilities({
      canDisplay: (mime, codecs, ...size) => this.context.canDisplayType(mime, codecs, ...size),
      hdr: Boolean(device[caps.IS_HDR_SUPPORTED]),
      dolbyVision: Boolean(device[caps.IS_DV_SUPPORTED]),
    });
  }

  currentMs() {
    try {
      const t = this.player.getCurrentTimeSec();
      if (typeof t === 'number' && t > 0) return t * 1000;
    } catch { /* nothing loaded */ }
    return this.positionMs;
  }

  playerState() {
    try { return this.player.getPlayerState(); } catch { return 'IDLE'; }
  }

  playingNow() {
    return this.playerState() === 'PLAYING';
  }

  clearTimer(name) {
    clearTimeout(this[name]);
    this[name] = undefined;
  }

  clearInterval(name) {
    clearInterval(this[name]);
    this[name] = undefined;
  }
}

/** A LOAD's work: its contentId, or its entity's kivo://work/<id>. */
export function workOf(media) {
  if (media?.contentId) return media.contentId;
  const m = /^kivo:\/\/work\/(.+)$/.exec(media?.entity || '');
  return m ? m[1] : undefined;
}

/** The fallback code for the player's error, by the framework's detailed code. */
export function failureCode(detailed) {
  if (detailed === 103) return 'mediaDecodeError';
  if (detailed === 105) return 'unsupported';
  if (detailed === 104 || (detailed >= 300 && detailed < 400)) return 'networkError';
  return 'mediaSourceError';
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return undefined; }
}
