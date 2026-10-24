// Starts the receiver. With ?debug in the page's URL, it also turns on the
// debug log: the console, Google's CastDebugLogger (whose panel a sender
// shows with {"command":"SHOW"} on urn:x-cast:com.google.cast.debuglogger)
// and JSON lines to senders on DEBUG_NAMESPACE, plus a report of what the
// device decodes and the URLs its media requests go to, cut to their shape.

import { DEBUG_NAMESPACE, NAMESPACE } from './config.js';
import { Log, debugEnabled } from './log.js';
import { Receiver } from './receiver.js';
import { UI } from './ui.js';

const cf = globalThis.cast.framework;
const log = new Log(true || debugEnabled(location.search)); // TEMPORARY: debugging the fallback
const context = cf.CastReceiverContext.getInstance();
const player = context.getPlayerManager();
player.setMediaElement(document.getElementById('video'));

const options = new cf.CastReceiverOptions();
options.useShakaForHls = true;
options.customNamespaces = { [NAMESPACE]: cf.system.MessageType.JSON };
options.playbackConfig = new cf.PlaybackConfig();

if (log.enabled) await debug();

const receiver = new Receiver({ cf, ui: new UI(), log });
receiver.start(options);
log.info('started', { path: location.pathname });

async function debug() {
  const TAG = 'RECEIVER';
  options.customNamespaces[DEBUG_NAMESPACE] = cf.system.MessageType.JSON;
  log.to((level, line) => (level === 'error' ? console.error : console.log)(`[${TAG}] ${line}`));
  log.to((level, line, data) => context.sendCustomMessage(DEBUG_NAMESPACE, undefined, { level, line, data, t: Date.now() }));
  await new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://www.gstatic.com/cast/sdk/libs/devtools/debug_layer/caf_receiver_logger.js';
    s.onload = resolve;
    s.onerror = resolve;
    document.head.append(s);
  });
  const logger = globalThis.cast.debug?.CastDebugLogger?.getInstance();
  if (logger) {
    log.to((level, line) => (level === 'error' ? logger.error(TAG, line) : logger.info(TAG, line)));
    context.addEventListener(cf.system.EventType.READY, () => {
      logger.setEnabled(true);
      logger.loggerLevelByTags = { [TAG]: cf.LoggerLevel.DEBUG };
    });
  }
  context.setLoggerLevel(cf.LoggerLevel.DEBUG);

  window.addEventListener('error', (e) => log.error('window error', { message: e.message, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => log.error('unhandled rejection', e.reason));
  document.addEventListener('securitypolicyviolation', (e) => log.error('CSP violation', { directive: e.violatedDirective }));

  // Media requests, by their path's shape: a play's ID is a credential.
  const shape = (url) => url.replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[0-9a-f-]{36}/gi, '{id}');
  let segments = 0;
  options.playbackConfig.manifestRequestHandler = (req) => { log.info('manifest request', { path: shape(req.url) }); return req; };
  options.playbackConfig.segmentRequestHandler = (req) => {
    if (segments++ < 3) log.info('segment request', { path: shape(req.url) });
    return req;
  };
  const E = cf.events.EventType;
  for (const type of [E.PLAYER_LOADING, E.PLAYER_LOAD_COMPLETE, E.PLAYING, E.PAUSE, E.BUFFERING, E.ENDED, E.MEDIA_FINISHED]) {
    player.addEventListener(type, (e) => log.info(`event ${type}`, { time: e.currentMediaTime, reason: e.endedReason ?? e.isBuffering }));
  }
  player.addEventListener(E.ERROR, (e) => log.error('media error', { detailedErrorCode: e.detailedErrorCode, reason: e.reason, error: e.error }));
  context.addEventListener(cf.system.EventType.READY, () => {
    let device;
    try { device = context.getDeviceCapabilities(); } catch (e) { device = String(e); }
    const can = {};
    for (const [mime, codecs] of [['video/mp4', 'avc1.640028'], ['video/mp4', 'avc1.640033'], ['video/mp4', 'hvc1.1.6.L150.B0'],
      ['video/mp4', 'hvc1.2.4.L153.B0'], ['video/mp4', 'dvh1.08.06'], ['video/mp4', 'av01.0.08M.08'], ['video/webm', 'vp9'],
      ['audio/mp4', 'mp4a.40.2'], ['audio/mp4', 'ac-3'], ['audio/mp4', 'ec-3'], ['audio/mp4', 'opus'], ['audio/mp4', 'flac']]) {
      try { can[`${mime}; codecs=${codecs}`] = context.canDisplayType(mime, codecs); } catch (e) { can[`${mime}; codecs=${codecs}`] = String(e); }
    }
    log.info('device', { device, can, userAgent: navigator.userAgent });
  });
}
