// The capability report a play starts with: what this Cast device decodes,
// measured at each load, since the TV it's plugged into decides HDR and
// surround and can change between casts. Codec and profile names are
// ffmpeg's, as the server compares them.

// Profiles, each with a codec string to ask about.
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

// Levels to try, highest first, as the codec's specification writes them.
const levelCandidates = {
  h264: [[5.2, 'avc1.640034'], [5.1, 'avc1.640033'], [5, 'avc1.640032'], [4.2, 'avc1.64002A'], [4.1, 'avc1.640029'], [4, 'avc1.640028']],
  hevc: [[5.1, 'hvc1.1.6.L153.B0'], [5, 'hvc1.1.6.L150.B0'], [4.1, 'hvc1.1.6.L123.B0'], [4, 'hvc1.1.6.L120.B0']],
};

// Sizes to step down through, largest first, and frame rates, highest first.
const sizes = [[3840, 2160], [2560, 1440], [1920, 1080], [1280, 720]];
const framerates = [60, 50, 30, 25, 24];
const FULL_HD = [1920, 1080];

// Dolby Vision profiles, each with a codec string to ask about.
const dolbyVisionCandidates = [
  { profile: 5, codecs: 'dvh1.05.06' },
  { profile: 8, codecs: 'dvh1.08.06' },
];

// Audio in MP4, with the channels each reaches the TV with. A codec the TV
// only passes through (AC-3, E-AC-3) is offered only where the device says
// it plays it, which it does only when the TV or receiver decodes it.
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
 *
 * A file and a stream are told apart where they differ. The device plays a
 * file itself, passing Dolby audio through to the TV; a stream plays
 * through Media Source Extensions, which take only AAC audio in a
 * fragmented MP4 segment, so E-AC-3 copied into a stream fails to load and
 * the server has it in AAC instead. Video decodes the same either way.
 *
 * Files play directly only as MP4 or WebM, and only with their default
 * audio track: the receiver selects no other track inside a file. Text
 * subtitles are drawn as WebVTT, from the stream or a file of their own;
 * anything else is burned in.
 */
export function capabilities(probe) {
  const can = (mime, codecs, ...size) => {
    try { return Boolean(probe.canDisplay(mime, codecs, ...size)); } catch { return false; }
  };
  const found = videoCandidates.filter((c) => can(c.mime || 'video/mp4', c.codecs));
  const video = [...new Set(found.map((c) => c.codec))].flatMap((codec) => videoEntries(codec, found.filter((c) => c.codec === codec), probe, can));
  const audio = audioCandidates
    .filter((a) => can('audio/mp4', a.codecs))
    .map((a) => ({ codec: a.codec, delivery: streamAudio.includes(a.codec) ? ['file', 'stream'] : ['file'], maxChannels: a.channels }));
  const containers = ['mp4'];
  if (can('video/webm', 'vp9')) containers.push('webm');
  return {
    file: { containers, trackSelection: false },
    video,
    audio,
    subtitles: [{ codec: 'webvtt', delivery: ['stream', 'external'] }],
  };
}

/**
 * A codec's video entries. Its size is the largest canDisplayType says it
 * decodes, and its frame rate the highest at that size. Where 1080p plays
 * at a higher frame rate than the largest size, a second entry says so.
 */
function videoEntries(codec, of, probe, can) {
  const top = of.at(-1);
  const mime = top.mime || 'video/mp4';
  const level = (levelCandidates[codec] || []).find(([, codecs]) => can(mime, codecs));
  const codecs = level ? level[1] : top.codecs;
  const entry = { codec, delivery: ['file', 'stream'], profiles: [...new Set(of.map((c) => c.profile))] };
  if (level) entry.maxLevel = level[0];
  entry.maxBitDepth = Math.max(...of.map((c) => c.bitDepth));
  const [width, height] = sizes.find(([w, h]) => can(mime, codecs, w, h)) || FULL_HD;
  entry.maxWidth = width;
  entry.maxHeight = height;
  const framerate = framerates.find((f) => can(mime, codecs, width, height, f));
  if (framerate) entry.maxFrameRate = framerate;
  if (entry.maxBitDepth >= 10 && probe.hdr) {
    entry.hdr = ['hdr10', 'hlg'];
    // A Dolby Vision video (HEVC, or AV1 for profile 10) whose profile
    // isn't listed plays its HDR10 or HLG base layer.
    if (codec === 'hevc' || codec === 'av1') entry.doviFallback = true;
  }
  if (codec === 'hevc' && entry.maxBitDepth >= 10 && probe.dolbyVision) {
    const profiles = dolbyVisionCandidates.filter((d) => can('video/mp4', d.codecs)).map((d) => ({ profile: d.profile }));
    if (profiles.length > 0) entry.dolbyVision = profiles;
  }
  const entries = [entry];
  if (framerate && width * height > FULL_HD[0] * FULL_HD[1]) {
    const fullHd = framerates.find((f) => can(mime, codecs, ...FULL_HD, f));
    if (fullHd > framerate) entries.push({ ...entry, maxWidth: FULL_HD[0], maxHeight: FULL_HD[1], maxFrameRate: fullHd });
  }
  return entries;
}
