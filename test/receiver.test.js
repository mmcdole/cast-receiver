import assert from 'node:assert/strict';
import test from 'node:test';

import { Log } from '../src/log.js';
import { Receiver } from '../src/receiver.js';
import { FakeUI, NEXT, SERVER_ID, WORK, episode, fakeFramework, fakeServer, nextEpisode, senderLoad, started } from './fakes.js';

const ok = (body) => () => [200, body];

/** A receiver over fakes, with the server's routes; its timers are cleared when the test ends. */
function setup(t, routes = {}, { logLines, answer = () => ({}), storage = memoryStorage() } = {}) {
  const fw = fakeFramework();
  const plays = [];
  const srv = fakeServer({
    'GET server': ok({ id: SERVER_ID, name: 'Den', version: '1', castProtocol: 2 }),
    'POST plays': ({ body }) => {
      const p = started({ id: `play-${plays.length + 1}`, workId: body.workId, startMs: body.positionMs ?? 60000, ...answer(body, plays.length) });
      plays.push({ body, p });
      return [201, p];
    },
    [`GET works/${WORK}`]: ok(episode),
    [`GET works/${NEXT}`]: ok(nextEpisode),
    'PATCH plays/[^/]+': () => [204],
    'POST plays/[^/]+/stop': () => [204],
    'GET home': ok({ rows: [{ kind: 'recentlyAdded', items: [{ images: { backdrop: { id: 'b1' } } }, { images: { backdrop: { id: 'b2' } } }] }] }),
    'GET images/.*': ok({}),
    'DELETE cast-tokens/current': () => [204],
    ...routes,
  });
  const log = new Log(Boolean(logLines));
  if (logLines) log.to((level, line) => logLines.push(line));
  const ui = new FakeUI();
  const userAgent = 'Mozilla/5.0 (X11; Linux armv7l) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0 Safari/537.36 CrKey/1.56.500000 DeviceType/Chromecast';
  const r = new Receiver({ cf: fw.cf, ui, log, fetch: srv.fetch, storage, userAgent });
  r.start({});
  t.after(() => {
    for (const k of ['heartbeat', 'countdown']) clearInterval(r[k]);
    for (const k of ['idleTimer', 'pausedTimer']) clearTimeout(r[k]);
  });
  return { r, fw, srv, ui, plays, player: fw.player, context: fw.context };
}

/** localStorage's calls over a Map. */
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), map: m };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('a LOAD starts the play as the token, with the device capabilities, and plays its stream', async (t) => {
  const lines = [];
  const { player, srv, plays, ui } = setup(t, {}, { logLines: lines });
  const req = await player.senderLoad(senderLoad({
    audioTrackId: 'a2', subtitleTrackId: 'off', quality: { mode: 'limit', maxBitrateBps: 4000000 }, remoteQuality: { mode: 'auto' },
  }, 120));
  assert.equal(plays.length, 1);
  const body = plays[0].body;
  assert.equal(body.workId, WORK);
  assert.equal(body.positionMs, 120000);
  assert.equal(body.audioTrackId, 'a2');
  assert.equal(body.subtitleTrackId, 'off');
  assert.deepEqual(body.settings, { quality: { mode: 'limit', maxBitrateBps: 4000000 }, remoteQuality: { mode: 'auto' } });
  assert.equal(body.quality, undefined);
  assert.deepEqual(body.capabilities.video.map((v) => [v.codec, v.delivery]), [['h264', ['file', 'stream']]]);
  assert.deepEqual(body.capabilities.audio.map((a) => [a.codec, a.delivery]), [['aac', ['file', 'stream']], ['ac3', ['file']]]);
  assert.deepEqual(body.capabilities.subtitles, [{ codec: 'webvtt', delivery: ['stream', 'external'] }]);
  assert.deepEqual(body.capabilities.file, { containers: ['mp4'], trackSelection: false });

  // The token goes in the Authorization header of every API request, never a URL.
  for (const q of srv.requests) {
    assert.ok(!q.url.includes('SECRET'), q.url);
    if (q.path !== 'server') assert.equal(q.auth, 'Bearer SECRET-CAST-TOKEN', q.path);
  }
  assert.equal(srv.requests[0].url, 'http://192.0.2.10:8484/api/v1/server');

  // The request plays the stream from the chosen address, at the play's start.
  assert.equal(req.media.contentUrl, 'http://192.0.2.10:8484/api/v1/plays/play-1/hls/index.m3u8');
  assert.equal(req.media.contentType, 'application/x-mpegurl');
  assert.equal(req.media.hlsSegmentFormat, 'fmp4');
  assert.equal(req.currentTime, 120);
  assert.equal(req.media.tracks.length, 1);
  assert.equal(req.media.tracks[0].trackContentId, 'http://192.0.2.10:8484/api/v1/plays/play-1/subtitles/s1.vtt');
  assert.equal(req.media.tracks[0].language, 'en');
  assert.equal(req.media.metadata.seriesTitle, 'The Expanse');
  assert.deepEqual(req.media.metadata.images, [{ url: 'https://sender.example/art.jpg' }]);
  assert.deepEqual(req.media.customData, { kivo: 2 }); // the token is gone, so status can't echo it
  assert.deepEqual(req.activeTrackIds, []); // subtitles off
  assert.equal(ui.screen, 'loading');
  assert.ok(!lines.join('\n').includes('SECRET'), 'the debug log holds the token');
  assert.ok(!JSON.stringify(player.queue).includes('SECRET'), 'the queue holds the token');
});

test('the media status hides media URLs and adds the receiver status', async (t) => {
  const { player } = setup(t);
  const req = await player.senderLoad(senderLoad());
  const status = player.interceptors.MEDIA_STATUS({ media: JSON.parse(JSON.stringify(req.media)) });
  const text = JSON.stringify(status);
  assert.ok(!text.includes('play-1') && !text.includes('SECRET'), text);
  assert.equal(status.customData.kivo.workId, WORK);
  assert.equal(status.customData.kivo.nextWorkId, NEXT);
  assert.equal(status.customData.kivo.audioTrackId, 'a1');
  assert.equal(status.customData.kivo.subtitleTrackId, undefined);
  assert.deepEqual(status.customData.kivo.tracks.map((t) => [t.trackId, t.delivery, t.selected]), [
    ['v0', 'stream', true], ['a1', 'stream', true], ['a9', undefined, undefined], ['s1', 'external', undefined],
    ['s2', undefined, undefined], ['off', 'none', true],
  ]);
  assert.equal(status.customData.kivo.decision, undefined);
});

test('every API request but server info names the receiver in Kivo-Client, with a device ID kept per server', async (t) => {
  const storage = memoryStorage();
  const { player, srv } = setup(t, {}, { storage });
  await player.senderLoad(senderLoad());
  const header = srv.requests.find((q) => q.method === 'POST' && q.path === 'plays').client;
  const id = storage.map.get(`kivo.deviceId.${SERVER_ID}`);
  assert.match(id, /^[0-9a-f-]{36}$/);
  assert.equal(header, `app="kivo-cast", app-version="2.0.0", platform="cast", os-version="1.56.500000", device-model="Chromecast", device-id="${id}"`);
  for (const q of srv.requests) assert.equal(q.client, q.path === 'server' ? undefined : header, q.path);
  await player.senderLoad(senderLoad());
  assert.equal(srv.requests.at(-1).client, header, 'the same ID next time');
});

test('a LOAD without the protocol or token is refused', async (t) => {
  const { player, ui } = setup(t);
  const out = await player.senderLoad(senderLoad({ kivo: undefined }));
  assert.equal(out.type, 'LOAD_FAILED');
  const older = await player.senderLoad(senderLoad({ kivo: 1 }));
  assert.equal(older.type, 'LOAD_FAILED');
  const newer = await player.senderLoad(senderLoad({ kivo: 3 }));
  assert.equal(newer.type, 'LOAD_FAILED');
  assert.equal(ui.screen, 'error');
  assert.match(ui.last.line, /older than the server/);
});

test('heartbeats report the position and state', async (t) => {
  const { r, player, srv } = setup(t);
  await player.senderLoad(senderLoad());
  player.state = 'PLAYING';
  player.time = 61.5;
  player.emit('PLAYING');
  await settle();
  player.state = 'PAUSED';
  player.emit('PAUSE');
  await settle();
  const beats = srv.requests.filter((q) => q.method === 'PATCH');
  assert.deepEqual(beats.map((b) => b.body), [{ positionMs: 61500, state: 'playing' }, { positionMs: 61500, state: 'paused' }]);
  assert.equal(r.ui.screen, 'paused');
});

test('a 401 says signed out; a 410 shows the admin\'s words; a 404 starts again at the position', async (t) => {
  let answer = [401, { code: 'unauthenticated' }];
  const { r, player, ui, plays } = setup(t, { 'PATCH plays/[^/]+': () => answer });
  await player.senderLoad(senderLoad());
  player.state = 'PLAYING';
  await r.beat();
  assert.equal(ui.screen, 'error');
  assert.equal(ui.last.line, 'Signed out. Cast again from your phone.');
  assert.equal(r.status().error, 'signedOut');

  await player.senderLoad(senderLoad());
  answer = [410, { code: 'playEnded', message: 'Server maintenance' }];
  player.state = 'PLAYING';
  await r.beat();
  assert.equal(ui.last.line, 'Server maintenance');
  assert.equal(r.status().error, 'playEnded');

  await player.senderLoad(senderLoad());
  const before = plays.length;
  answer = [404, { code: 'notFound' }];
  player.state = 'PLAYING';
  player.time = 300;
  await r.beat();
  await settle();
  assert.equal(plays.length, before + 1);
  assert.equal(plays.at(-1).body.positionMs, 300000);
  assert.equal(player.loads.at(-1).media.contentUrl, `http://192.0.2.10:8484/api/v1/plays/play-${plays.length}/hls/index.m3u8`);
});

test('an unreachable server shows after 30 seconds and clears when it answers', async (t) => {
  let down = true;
  let now = 1_000_000;
  const { r, player, ui } = setup(t, { 'PATCH plays/[^/]+': () => { if (down) throw new TypeError('down'); return [204]; } });
  r.now = () => now;
  await player.senderLoad(senderLoad());
  player.state = 'PLAYING';
  ui.playing();
  now += 10000;
  await r.beat();
  assert.equal(ui.screen, 'playing');
  now += 25000;
  await r.beat();
  assert.equal(ui.screen, 'error');
  assert.equal(ui.last.line, "Can't reach the server.");
  assert.equal(r.status().error, 'serverUnreachable');
  down = false;
  await r.beat();
  assert.equal(ui.screen, 'playing');
  assert.equal(r.status().error, null);
});

test('a subtitle with a delivery shows at once, one without and audio start a new play', async (t) => {
  const { r, player, plays, srv } = setup(t);
  await player.senderLoad(senderLoad());
  player.state = 'PLAYING';
  player.time = 99.9996;
  await r.onMessage({ type: 'kivo.setTracks', subtitleTrackId: 's1' });
  assert.deepEqual(player.active, [1]);
  assert.equal(plays.length, 1);
  let beat = srv.requests.filter((q) => q.method === 'PATCH').at(-1);
  assert.equal(beat.body.subtitleTrackId, 's1');
  let status = r.status();
  assert.equal(status.subtitleTrackId, 's1');
  assert.deepEqual(status.tracks.filter((t) => t.selected).map((t) => t.trackId), ['v0', 'a1', 's1']);
  assert.ok(!JSON.stringify(status).includes('play-1'), 'the status holds the subtitle file URL');

  await r.onMessage({ type: 'kivo.setTracks', subtitleTrackId: 'off' });
  assert.deepEqual(player.active, []);
  beat = srv.requests.filter((q) => q.method === 'PATCH').at(-1);
  assert.equal(beat.body.subtitleTrackId, 'off');
  status = r.status();
  assert.equal(status.subtitleTrackId, undefined);
  assert.equal(status.tracks.find((t) => t.trackId === 'off').selected, true);

  await r.onMessage({ type: 'kivo.setTracks', subtitleTrackId: 's2' }); // no delivery: a new play shows it
  assert.equal(plays.length, 2);
  assert.equal(plays[1].body.subtitleTrackId, 's2');
  assert.equal(plays[1].body.positionMs, 100000);
  const stops = srv.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/stop'));
  assert.deepEqual(stops.at(-1).body, { positionMs: 100000 });

  await r.onMessage({ type: 'kivo.setTracks', audioTrackId: 'a1' }); // the one playing
  assert.equal(plays.length, 2);
  await r.onMessage({ type: 'kivo.setTracks', audioTrackId: 'a9' });
  assert.equal(plays.length, 3);
  assert.equal(plays[2].body.audioTrackId, 'a9');
  await r.onMessage({ type: 'kivo.setDialogueBoost', on: true });
  assert.equal(plays[3].body.dialogueBoost, true);
  await r.onMessage({ type: 'kivo.setQuality', quality: { mode: 'original' }, remoteQuality: { mode: 'original' } });
  assert.deepEqual(plays[4].body.settings, { quality: { mode: 'original' }, remoteQuality: { mode: 'original' } });
});

test('a subtitle a play carries in its stream is matched to its rendition and shows at once', async (t) => {
  const tracks = [
    { trackId: 'v0', type: 'video', selected: true, delivery: 'stream', codec: 'hevc' },
    { trackId: 'a1', type: 'audio', selected: true, delivery: 'stream', codec: 'aac' },
    { trackId: 's1', type: 'subtitle', delivery: 'stream', codec: 'webvtt' },
    { trackId: 's2', type: 'subtitle', selected: true, delivery: 'stream', codec: 'webvtt' },
    { trackId: 's3', type: 'subtitle', reason: 'subtitleCodecUnsupported' },
    { trackId: 'off', type: 'subtitle', delivery: 'none' },
  ];
  const { r, player, plays } = setup(t, {}, { answer: () => ({ tracks }) });
  await player.senderLoad(senderLoad());
  assert.equal(player.loads[0].media.tracks.length, 0, 'no subtitle files');
  // The player lists the stream's renditions once it has loaded it, in the playlist's order.
  player.renditions = [{ trackId: 7, type: 'TEXT', language: 'en' }, { trackId: 8, type: 'TEXT', language: 'fr' }];
  player.emit('PLAYER_LOAD_COMPLETE');
  assert.deepEqual(player.active, [8], 'the play\'s own subtitle');
  await r.onMessage({ type: 'kivo.setTracks', subtitleTrackId: 's1' });
  assert.deepEqual(player.active, [7]);
  assert.equal(plays.length, 1);
  await r.onMessage({ type: 'kivo.setTracks', subtitleTrackId: 's3' });
  assert.equal(plays.length, 2);

  // A player that keeps the rendition's ID is matched by it, whatever the order.
  player.renditions = [{ trackId: 9, type: 'TEXT', customData: { id: 's2' } }, { trackId: 10, type: 'TEXT', customData: { id: 's1' } }];
  player.emit('PLAYER_LOAD_COMPLETE');
  assert.deepEqual(player.active, [9]);
  r.onEditTracks({ activeTrackIds: [10] }); // a stock sender's switch
  assert.equal(r.status().subtitleTrackId, 's1');
});

test('while a subtitle is burned in, only a new play changes it', async (t) => {
  const tracks = [
    { trackId: 'v0', type: 'video', selected: true, delivery: 'stream', codec: 'h264', transcode: { width: 1920, height: 1080 }, reason: 'subtitleCodecUnsupported' },
    { trackId: 's1', type: 'subtitle', selected: true, delivery: 'burn', codec: 'hdmv_pgs_subtitle' },
    { trackId: 's2', type: 'subtitle' },
    { trackId: 'off', type: 'subtitle' },
  ];
  const { r, player, plays } = setup(t, {}, { answer: () => ({ tracks }) });
  await player.senderLoad(senderLoad());
  await r.onMessage({ type: 'kivo.setTracks', subtitleTrackId: 's1' });
  assert.equal(plays.length, 1);
  await r.onMessage({ type: 'kivo.setTracks', subtitleTrackId: 'off' });
  assert.equal(plays.length, 2);
  assert.equal(plays[1].body.subtitleTrackId, 'off');
});

test('a file plays directly, with its subtitle file showing; one in parts is asked for again as one stream', async (t) => {
  const file = (id) => ({
    delivery: 'file', url: `plays/${id}/files/0`,
    tracks: [
      { trackId: 'v0', type: 'video', selected: true, delivery: 'file', codec: 'h264', index: 0 },
      { trackId: 'a1', type: 'audio', selected: true, delivery: 'file', codec: 'eac3', index: 1 },
      { trackId: 's1', type: 'subtitle', selected: true, delivery: 'external', codec: 'webvtt', url: `plays/${id}/subtitles/s1.vtt` },
      { trackId: 'off', type: 'subtitle', delivery: 'none' },
    ],
  });
  let parts = 1;
  const { player, plays, srv } = setup(t, {}, {
    answer: (body, n) => (body.settings?.directPlay === false ? {} : { ...file(`play-${n + 1}`), parts: Array(parts).fill({ durationMs: 1 }) }),
  });
  const req = await player.senderLoad(senderLoad());
  assert.equal(req.media.contentUrl, 'http://192.0.2.10:8484/api/v1/plays/play-1/files/0');
  assert.equal(req.media.contentType, 'video/webm');
  assert.deepEqual(req.activeTrackIds, [1]);
  assert.equal(req.media.tracks[0].trackContentId, 'http://192.0.2.10:8484/api/v1/plays/play-1/subtitles/s1.vtt');

  parts = 2;
  const again = await player.senderLoad(senderLoad({ quality: { mode: 'auto' } }));
  assert.deepEqual(plays.at(-1).body.settings, { quality: { mode: 'auto' }, directPlay: false });
  assert.ok(srv.requests.some((q) => q.path === `plays/play-${plays.length - 1}/stop`));
  assert.equal(again.media.contentType, 'application/x-mpegurl');
});

test('up next counts down near the end and plays the next episode', async (t) => {
  const { r, player, plays } = setup(t);
  await player.senderLoad(senderLoad());
  await settle(); // the next episode's detail
  player.state = 'PLAYING';
  const d = 45 * 60000;
  player.emit('TIME_UPDATE', { currentMediaTime: (d - 34000) / 1000 });
  assert.equal(r.status().upNext.phase, 'showing');
  assert.equal(r.ui.card.title, 'Triple Point');
  assert.equal(r.ui.card.line, 'Next · S3 · E5');
  clearInterval(r.countdown);
  r.countdown = undefined;
  for (let i = 0; i < 10; i++) r.countDown();
  await settle();
  assert.equal(plays.length, 2);
  assert.equal(plays[1].body.workId, NEXT);
  assert.equal(plays[1].body.positionMs, undefined);
  assert.equal(r.autoplayRun, 1);
});

test('after three on their own, the end asks "Still watching?"', async (t) => {
  const { r, player, plays } = setup(t);
  await player.senderLoad(senderLoad({ autoplayCount: 3 }));
  await settle();
  player.state = 'PLAYING';
  await r.onEnded();
  assert.equal(plays.length, 1);
  assert.equal(r.status().upNext.phase, 'stillWatching');
  assert.equal(r.ui.card.stillWatching, true);
  await r.onMessage({ type: 'kivo.upNext', action: 'playNow' });
  assert.equal(plays.length, 2);
  assert.equal(r.autoplayRun, 0);
});

test('a sender\'s Stop saves the position and goes idle with the user\'s backdrops', async (t) => {
  const { r, player, srv, ui } = setup(t);
  await player.senderLoad(senderLoad());
  player.state = 'PLAYING';
  player.emit('TIME_UPDATE', { currentMediaTime: 200 });
  player.time = 0;
  await r.onFinished('STOPPED');
  const stop = srv.requests.find((q) => q.path === 'plays/play-1/stop');
  assert.deepEqual(stop.body, { positionMs: 200000 });
  await settle();
  assert.equal(ui.screen, 'idle');
  assert.equal(ui.last.urls.length, 2);
});

test('a media error falls back once, then says it can\'t play', async (t) => {
  const { r, player, srv, ui } = setup(t, {
    'POST plays/[^/]+/fallback': ({ path }) => [201, started({ id: `fb-${path}`, url: 'plays/fb/hls/index.m3u8' })],
  });
  await player.senderLoad(senderLoad());
  player.state = 'PLAYING';
  player.time = 30;
  await r.onMediaError({ detailedErrorCode: 103 });
  const fb = srv.requests.find((q) => q.path.endsWith('/fallback'));
  assert.deepEqual(fb.body, { positionMs: 30000, code: 'mediaDecodeError', detail: '103' });
  assert.equal(player.loads.at(-1).media.contentUrl, 'http://192.0.2.10:8484/api/v1/plays/fb/hls/index.m3u8');
  await r.onMediaError({ detailedErrorCode: 103 });
  assert.equal(ui.screen, 'error');
  assert.equal(ui.last.line, "This can't be played on this TV.");
});

test('a failure the framework reports twice falls back once and plays the fallback', async (t) => {
  const { r, player, srv, ui } = setup(t, {
    'POST plays/[^/]+/fallback': ({ path }) => [201, started({ id: `fb-${path}`, url: 'plays/fb/hls/index.m3u8' })],
  });
  await player.senderLoad(senderLoad());
  await Promise.all([r.onMediaError({ detailedErrorCode: 410 }), r.onMediaError({ detailedErrorCode: 410 })]);
  assert.equal(srv.requests.filter((q) => q.path.endsWith('/fallback')).length, 1);
  assert.equal(player.loads.at(-1).media.contentUrl, 'http://192.0.2.10:8484/api/v1/plays/fb/hls/index.m3u8');
  assert.equal(player.stopped, 0);
  assert.notEqual(ui.screen, 'error');
  assert.equal(r.error, undefined);
});

test('a status sent while a load is under way leaves the media it loads from alone', async (t) => {
  const { r, player } = setup(t, {
    'POST plays/[^/]+/fallback': ({ path }) => [201, started({ id: `fb-${path}`, url: 'plays/fb/hls/index.m3u8' })],
  });
  await player.senderLoad(senderLoad());
  await r.onMediaError({ detailedErrorCode: 100 });
  const media = player.loads.at(-1).media;
  // The fallback's own load: queued, starting, with a status asked for meanwhile.
  player.emit('PLAYER_LOADING');
  const status = player.interceptors.MEDIA_STATUS({ media, items: [{ media }] });
  assert.equal(media.contentUrl, 'http://192.0.2.10:8484/api/v1/plays/fb/hls/index.m3u8');
  assert.equal(player.queue[0].media.contentUrl, media.contentUrl);
  assert.equal(status.media.contentUrl, undefined);
  assert.equal(status.items[0].media.contentUrl, undefined);
  // Loaded, the queue has its URLs taken out.
  player.emit('PLAYER_LOAD_COMPLETE');
  assert.equal(player.queue[0].media.contentUrl, undefined);
});

test('closing stops the play and ends the token', async (t) => {
  const { r, player, srv } = setup(t);
  await player.senderLoad(senderLoad());
  player.time = 42;
  await r.onShutdown();
  await settle();
  const stop = srv.requests.find((q) => q.path === 'plays/play-1/stop');
  assert.ok(stop.keepalive);
  assert.ok(srv.requests.some((q) => q.method === 'DELETE' && q.path === 'cast-tokens/current' && q.keepalive));
});

test('a new token from a reconnecting sender is used from then on', async (t) => {
  const { r, player, srv } = setup(t);
  await player.senderLoad(senderLoad());
  await r.onMessage({ type: 'kivo.token', token: 'FRESH' });
  await r.beat();
  assert.equal(srv.requests.at(-1).auth, 'Bearer FRESH');
});
