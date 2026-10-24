// The capability report a play starts with: what this Cast device decodes,
// measured at each load, since the TV it's plugged into decides HDR and
// surround and can change between casts.

// Profile names as the server compares them (the prober's), each with a
// codec string to ask about.
const videoCandidates = [
  { codec: 'h264', profile: 'Constrained Baseline', bitDepth: 8, codecs: 'avc1.42E01E' },
  { codec: 'h264', profile: 'Baseline', bitDepth: 8, codecs: 'avc1.42E01E' },
  { codec: 'h264', profile: 'Main', bitDepth: 8, codecs: 'avc1.4D401F' },
  { codec: 'h264', profile: 'High', bitDepth: 8, codecs: 'avc1.640028' },
  { codec: 'hevc', profile: 'Main', bitDepth: 8, codecs: 'hvc1.1.6.L120.B0' },
  { codec: 'hevc', profile: 'Main 10', bitDepth: 10, codecs: 'hvc1.2.4.L120.B0' },
  { codec: 'vp9', profile: 'Profile 0', bitDepth: 8, codecs: 'vp09.00.40.08', mime: 'video/webm' },
  { codec: 'vp9', profile: 'Profile 2', bitDepth: 10, codecs: 'vp09.02.40.10', mime: 'video/webm' },
  { codec: 'av1', profile: 'Main', bitDepth: 8, codecs: 'av01.0.08M.08' },
  { codec: 'av1', profile: 'Main', bitDepth: 10, codecs: 'av01.0.08M.10' },
];

// Levels to try, highest first, in the prober's numbering (41 is H.264 4.1,
// 153 is HEVC 5.1).
const levelCandidates = {
  h264: [[52, 'avc1.640034'], [51, 'avc1.640033'], [50, 'avc1.640032'], [42, 'avc1.64002A'], [41, 'avc1.640029'], [40, 'avc1.640028']],
  hevc: [[153, 'hvc1.1.6.L153.B0'], [150, 'hvc1.1.6.L150.B0'], [123, 'hvc1.1.6.L123.B0'], [120, 'hvc1.1.6.L120.B0']],
};

// Audio in MP4. A codec the TV only passes through (AC-3, E-AC-3) is
// offered only where the device says it plays it, which it does only when
// the TV or receiver decodes it, and only from a file: see streamAudio.
const audioCandidates = [
  { codec: 'aac', codecs: 'mp4a.40.2', channels: 6 },
  { codec: 'mp3', codecs: 'mp4a.40.34', channels: 2 },
  { codec: 'ac3', codecs: 'ac-3', channels: 6 },
  { codec: 'eac3', codecs: 'ec-3', channels: 6 },
  { codec: 'opus', codecs: 'opus', channels: 6 },
  { codec: 'flac', codecs: 'flac', channels: 6 },
];

/** The audio a stream carries: what Media Source Extensions take in fragmented MP4. */
const streamAudio = ['aac'];

/**
 * The report from a probe: canDisplay(mime, codecs, width, height,
 * framerate) is the device's own answer (CastReceiverContext's
 * canDisplayType), hdr and dolbyVision what its display supports now.
 * Files play directly only as MP4 or WebM: anything else is streamed. Text
 * subtitles are drawn as WebVTT; anything else is burned in.
 *
 * A file and a stream are reported apart. The device plays a file itself,
 * passing Dolby audio through to the TV; a stream plays through Media
 * Source Extensions, which take only AAC audio in a fragmented MP4
 * segment, so E-AC-3 copied into a stream fails to load (as Jellyfin's
 * receiver found too) and the server has it in AAC instead.
 */
export function capabilities(probe) {
  const can = (mime, codecs, ...size) => {
    try { return Boolean(probe.canDisplay(mime, codecs, ...size)); } catch { return false; }
  };
  const found = videoCandidates.filter((c) => can(c.mime || 'video/mp4', c.codecs));
  const video = [...new Set(found.map((c) => c.codec))].map((codec) => {
    const of = found.filter((c) => c.codec === codec);
    const out = { codec, profiles: [...new Set(of.map((c) => c.profile))], maxBitDepth: Math.max(...of.map((c) => c.bitDepth)) };
    const level = (levelCandidates[codec] || []).find(([, codecs]) => can('video/mp4', codecs));
    if (level) out.maxLevel = level[0];
    if (codec === 'hevc' && out.maxBitDepth >= 10) {
      const ranges = ['sdr'];
      if (probe.hdr) ranges.push('hdr10', 'hlg');
      if (probe.dolbyVision) ranges.push('dolbyVision');
      if (ranges.length > 1) out.dynamicRanges = ranges;
    }
    return out;
  });
  const audio = audioCandidates
    .filter((a) => can('audio/mp4', a.codecs))
    .map((a) => ({ codec: a.codec, maxChannels: a.channels }));
  const containers = ['mp4'];
  if (can('video/webm', 'vp9')) containers.push('webm');
  const uhd = can('video/mp4', 'hvc1.1.6.L150.B0', 3840, 2160, 30) || can('video/mp4', 'avc1.640033', 3840, 2160, 30);
  return {
    file: { containers, video, audio },
    stream: { video, audio: audio.filter((a) => streamAudio.includes(a.codec)) },
    subtitles: ['vtt'],
    maxWidth: uhd ? 3840 : 1920,
    maxHeight: uhd ? 2160 : 1080,
  };
}
