import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { ApiError, NetworkError, ServerMismatch, chooseServer } from '../src/api.js';
import { capabilities } from '../src/capabilities.js';
import { VERSION } from '../src/config.js';
import { clock, heading, nextLine, remaining, runtime } from '../src/format.js';
import { clientHeader, deviceId, deviceIdKey, deviceOf } from '../src/identity.js';
import { Log, debugEnabled, redact } from '../src/log.js';
import { failureCode, settingsOf, workOf } from '../src/receiver.js';
import { kivoStatus, sanitizeMediaStatus, takeToken } from '../src/status.js';
import * as upnext from '../src/upnext.js';
import { SERVER_ID, fakeServer } from './fakes.js';

test('clock and remaining', () => {
  assert.equal(clock(23 * 60000 + 38000), '23:38');
  assert.equal(clock(72 * 60000 + 34000), '1:12:34');
  assert.equal(clock(-5), '0:00');
  assert.equal(remaining(23 * 60000 + 38000, 96 * 60000 + 12000), '−1:12:34');
  assert.equal(runtime(96 * 60000), '1h 36m');
  assert.equal(runtime(44 * 60000), '44m');
});

test('heading', () => {
  const movie = { title: 'Tremors', year: 1990, durationMs: 96 * 60000, contentRating: 'PG-13' };
  assert.deepEqual(heading(movie, { long: true }), { title: 'Tremors', sub: '1990 · 1h 36m · PG-13' });
  assert.deepEqual(heading(movie), { title: 'Tremors', sub: '1990 · PG-13' });
  const ep = { title: 'Reload', episode: { season: 3, number: 4, seriesTitle: 'The Expanse' } };
  assert.deepEqual(heading(ep), { title: 'The Expanse', sub: 'S3 · E4 · Reload' });
  assert.equal(nextLine({ episode: { season: 3, number: 5 } }), 'Next · S3 · E5');
});

test('capabilities from what the device says', () => {
  // A 4K HDR device: HEVC to 4K at 60 frames, H.264 to 1080p, E-AC-3 passed through.
  const yes = new Set(['avc1.42E01E', 'avc1.4D401F', 'avc1.640028', 'avc1.640029', 'avc1.64002A', 'hvc1.1.6.L120.B0', 'hvc1.2.4.L120.B0',
    'hvc1.1.6.L150.B0', 'hvc1.1.6.L153.B0', 'dvh1.08.06', 'mp4a.40.2', 'ec-3']);
  const caps = capabilities({
    canDisplay: (mime, codecs, w, h, f) => yes.has(codecs) && (!w || (codecs.startsWith('hvc1') ? w <= 3840 : w <= 1920 && (!f || f <= 30))),
    hdr: true,
    dolbyVision: true,
  });
  assert.deepEqual(caps.video, [
    { codec: 'h264', delivery: ['file', 'stream'], profiles: ['Constrained Baseline', 'Baseline', 'Main', 'High'], maxLevel: 4.2, maxBitDepth: 8,
      maxWidth: 1920, maxHeight: 1080, maxFramerate: 30 },
    { codec: 'hevc', delivery: ['file', 'stream'], profiles: ['Main', 'Main 10'], maxLevel: 5.1, maxBitDepth: 10,
      maxWidth: 3840, maxHeight: 2160, maxFramerate: 60, hdr: ['hdr10', 'hlg'], doviFallback: true, dolbyVision: [{ profile: 8 }] },
  ]);
  // E-AC-3 passes through from a file; a stream has it in AAC.
  assert.deepEqual(caps.audio, [
    { codec: 'aac', delivery: ['file', 'stream'], maxChannels: 6 },
    { codec: 'eac3', delivery: ['file'], maxChannels: 6 },
  ]);
  assert.deepEqual(caps.file, { containers: ['mp4'], trackSelection: false });
  assert.deepEqual(caps.subtitles, [{ codec: 'webvtt', delivery: ['stream', 'sidecar'] }]);

  // 4K only at 30 frames, but 1080p at 60: a second entry says so.
  const uhd30 = capabilities({
    canDisplay: (m, c, w, h, f) => c === 'avc1.640028' || (c === 'avc1.640033' && (!f || f <= (w > 1920 ? 30 : 60))),
  });
  assert.deepEqual(uhd30.video.map((v) => [v.maxLevel, v.maxWidth, v.maxHeight, v.maxFramerate]), [[5.1, 3840, 2160, 30], [5.1, 1920, 1080, 60]]);

  // A device that answers no size and no frame rate is taken as 1080p, without a frame rate.
  const old = capabilities({ canDisplay: (m, c, w) => !w && ['avc1.640028', 'mp4a.40.2'].includes(c), hdr: false, dolbyVision: false });
  assert.deepEqual(old.video, [{ codec: 'h264', delivery: ['file', 'stream'], profiles: ['High'], maxLevel: 4, maxBitDepth: 8, maxWidth: 1920, maxHeight: 1080 }]);
  // HDR needs the display: an SDR TV gets 10-bit video without it.
  const sdr = capabilities({ canDisplay: (m, c) => c === 'hvc1.2.4.L120.B0', hdr: false, dolbyVision: true });
  assert.equal(sdr.video[0].hdr, undefined);
  assert.equal(sdr.video[0].dolbyVision, undefined);
  assert.equal(sdr.video[0].doviFallback, undefined);
  assert.equal(capabilities({ canDisplay: () => { throw new Error('not ready'); } }).video.length, 0);
});

test('the Kivo-Client header', () => {
  const m = new Map();
  const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) };
  let n = 0;
  const random = () => `id-${++n}`;
  const gtv = 'Mozilla/5.0 (Linux; Android 12.0; Build/STTL.240206.002) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 CrKey/1.56.500000 DeviceType/AndroidTV';
  assert.equal(clientHeader({ serverId: 's1', storage, userAgent: gtv, random }),
    'app="kivo-cast", app-version="2.0.0", platform="cast", os-version="1.56.500000", device-model="AndroidTV", device-id="id-1"');
  assert.match(clientHeader({ serverId: 's1', storage, userAgent: gtv, random }), /device-id="id-1"$/, 'kept for the server');
  assert.match(clientHeader({ serverId: 's2', storage, userAgent: gtv, random }), /device-id="id-2"$/, 'another server, another ID');
  assert.equal(m.get(deviceIdKey('s2')), 'id-2');
  // No storage: an ID for this load. No Cast user agent: no model.
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(clientHeader({ serverId: 's1', storage: broken, userAgent: 'Mozilla/5.0', random }),
    'app="kivo-cast", app-version="2.0.0", platform="cast", device-id="id-3"');
  assert.deepEqual(deviceOf('Mozilla/5.0 CrKey/1.36.159268'), { osVersion: '1.36.159268', model: 'Chromecast' });
  assert.match(deviceId('s9', undefined), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the version is the package\'s', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
});

test('settings from a LOAD or a quality message', () => {
  assert.deepEqual(settingsOf({ quality: { mode: 'auto' }, remoteQuality: { mode: 'limit', maxBitrateBps: 2000000 }, directPlay: false, kivo: 2, token: 'x' }),
    { quality: { mode: 'auto' }, remoteQuality: { mode: 'limit', maxBitrateBps: 2000000 }, directPlay: false });
  assert.deepEqual(settingsOf({ quality: 'auto', burnSubtitles: 'yes' }), {});
  assert.deepEqual(settingsOf(undefined), {});
});

test('up next rules', () => {
  assert.equal(upnext.showAtMs(9 * 60000), undefined);
  assert.equal(upnext.showAtMs(30 * 60000), 30 * 60000 - 30000);
  assert.equal(upnext.showAtMs(45 * 60000), 45 * 60000 - 35000);
  assert.equal(upnext.showAtMs(55 * 60000), 55 * 60000 - 40000);
  const d = 45 * 60000;
  let s = upnext.at(upnext.hidden, d - 60000, d, true);
  assert.equal(s, upnext.hidden);
  s = upnext.at(s, d - 34000, d, true);
  assert.deepEqual(s, { phase: 'showing', secondsLeft: 10 });
  assert.equal(upnext.at(s, d - 33000, d, true), s);
  for (let i = 0; i < 10; i++) s = upnext.tick(s, true);
  assert.ok(upnext.playsNext(s));
  assert.deepEqual(upnext.tick({ phase: 'showing', secondsLeft: 5 }, false), { phase: 'showing', secondsLeft: 5 });
  assert.equal(upnext.at(upnext.hidden, d - 34000, d, false).phase, 'stillWatching');
  assert.equal(upnext.at(upnext.hidden, d - 10000, d, true).phase, 'hidden'); // a seek to the last seconds
  assert.equal(upnext.hide({ phase: 'showing', secondsLeft: 3 }).phase, 'dismissed');
  assert.equal(upnext.at({ phase: 'dismissed', secondsLeft: 3 }, 1000, d, true), upnext.hidden);
  assert.equal(upnext.atEnd({ episode: true, hasNext: true, autoplayAllowed: true }), 'playNext');
  assert.equal(upnext.atEnd({ episode: true, hasNext: true, autoplayAllowed: false }), 'stillWatching');
  assert.equal(upnext.atEnd({ episode: false, hasNext: false, autoplayAllowed: true }), 'idle');
});

test('status never carries the token or media URLs', () => {
  const custom = { kivo: 2, token: 'SECRET', urls: [] };
  assert.equal(takeToken(custom), 'SECRET');
  assert.equal(custom.token, undefined);
  const status = {
    media: { contentUrl: 'http://192.0.2.10:8484/api/v1/plays/p/hls/index.m3u8', customData: { token: 'SECRET' },
      tracks: [{ trackId: 1, trackContentId: 'http://x/plays/p/subtitles/1.vtt' }] },
  };
  // The framework's queue items hold the sender's LOAD as it came.
  status.items = [{ itemId: 1, customData: { token: 'SECRET' },
    media: { contentId: 'w', contentUrl: 'http://x/plays/p/files/0', customData: { kivo: 1, token: 'SECRET', urls: [] } } }];
  const out = sanitizeMediaStatus(status, kivoStatus({ workId: 'w' }));
  const text = JSON.stringify(out);
  assert.ok(!text.includes('SECRET') && !text.includes('plays/p'), text);
  assert.deepEqual(out.media.customData, { kivo: { error: null, workId: 'w' } });
  assert.deepEqual(out.items[0].media.customData, { kivo: { error: null, workId: 'w' } });
  const own = sanitizeMediaStatus({ media: { contentId: 'w', customData: { kivo: 1, prepared: 'k1' } } }, {});
  assert.deepEqual(own.media.customData, { kivo: {}, prepared: 'k1' });
});

test('kivo status', () => {
  const started = {
    id: 'PLAY-ID', versionId: 'v', local: true, delivery: 'file', url: 'plays/PLAY-ID/files/0',
    tracks: [
      { trackId: 'v0', type: 'video', selected: true, delivery: 'file', index: 0 },
      { trackId: 'a', type: 'audio', selected: true, delivery: 'file', index: 1 },
      { trackId: 's', type: 'subtitle', selected: true, delivery: 'sidecar', codec: 'webvtt', url: 'plays/PLAY-ID/subtitles/s.vtt' },
      { trackId: 'off', type: 'subtitle', delivery: 'none' },
    ],
  };
  const s = kivoStatus({ workId: 'w', nextWorkId: 'n', shownSubtitle: 'off', upNext: { phase: 'showing', secondsLeft: 7 }, started });
  assert.ok(!JSON.stringify(s).includes('PLAY-ID'));
  assert.equal(s.subtitleTrackId, undefined); // switched off
  assert.equal(s.audioTrackId, 'a');
  assert.deepEqual(s.tracks.filter((t) => t.selected).map((t) => t.trackId), ['v0', 'a', 'off']);
  assert.deepEqual(s.tracks[2], { trackId: 's', type: 'subtitle', delivery: 'sidecar', codec: 'webvtt' });
  assert.deepEqual(s.upNext, { phase: 'showing', secondsLeft: 7 });
  assert.equal(s.error, null);
  assert.equal(kivoStatus({ started }).subtitleTrackId, 's');
  assert.equal(started.tracks[2].url, 'plays/PLAY-ID/subtitles/s.vtt', 'the play keeps its own');
});

test('the debug log is off by default and redacts secrets', () => {
  assert.equal(debugEnabled(''), false);
  assert.equal(debugEnabled('?debug'), true);
  assert.equal(debugEnabled('?debug=1'), true);
  const lines = [];
  const off = new Log(false);
  off.to((l, line) => lines.push(line));
  off.info('x', { token: 'SECRET' });
  assert.equal(lines.length, 0);
  const on = new Log(true);
  on.to((l, line) => lines.push(line));
  on.info('LOAD', { customData: { token: 'SECRET', urls: ['http://192.0.2.10:8484'] }, delivery: { url: 'plays/ID/x' } });
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes('SECRET') && !lines[0].includes('192.0.2.10') && !lines[0].includes('plays/ID'), lines[0]);
  assert.deepEqual(redact({ Authorization: 'Bearer x' }), { Authorization: '[redacted]' });
});

test('choosing the server by its ID and protocol', async () => {
  const info = (id, castProtocol) => () => [200, { id, name: 'Den', version: '1', castProtocol }];
  let srv = fakeServer({ 'GET server': info(SERVER_ID, 1) });
  const got = await chooseServer(['http://192.0.2.10:8484/', 'https://media.example'], SERVER_ID, 1, srv.fetch);
  assert.equal(got.base, 'http://192.0.2.10:8484/');
  assert.equal(srv.requests[0].auth, undefined, 'server info is asked for without the token');

  // The first address is another server; the second is the right one.
  srv = fakeServer({ 'GET server': ({ url }) => [200, { id: url.host === '192.0.2.10:8484' ? 'other' : SERVER_ID, castProtocol: 1 }] });
  assert.equal((await chooseServer(['http://192.0.2.10:8484', 'https://media.example'], SERVER_ID, 1, srv.fetch)).base, 'https://media.example');

  srv = fakeServer({});
  await assert.rejects(chooseServer(['http://192.0.2.10:8484'], SERVER_ID, 1, srv.fetch), NetworkError);
  srv = fakeServer({ 'GET server': info('other', 1) });
  await assert.rejects(chooseServer(['http://192.0.2.10:8484'], SERVER_ID, 1, srv.fetch), (e) => e instanceof ServerMismatch && e.kind === 'otherServer');
  srv = fakeServer({ 'GET server': info(SERVER_ID, undefined) });
  await assert.rejects(chooseServer(['http://192.0.2.10:8484'], SERVER_ID, 1, srv.fetch), (e) => e.kind === 'serverOutdated');
  srv = fakeServer({ 'GET server': info(SERVER_ID, 2) });
  await assert.rejects(chooseServer(['http://192.0.2.10:8484'], SERVER_ID, 1, srv.fetch), (e) => e.kind === 'receiverOutdated');
  assert.ok(new ApiError(410, { code: 'playEnded', message: 'Bedtime' }).problemMessage === 'Bedtime');
});

test('helpers', () => {
  assert.equal(workOf({ contentId: 'w' }), 'w');
  assert.equal(workOf({ entity: 'kivo://work/abc' }), 'abc');
  assert.equal(workOf({}), undefined);
  assert.equal(failureCode(103), 'mediaDecodeError');
  assert.equal(failureCode(105), 'unsupported');
  assert.equal(failureCode(311), 'networkError');
  assert.equal(failureCode(110), 'mediaSourceError');
});
