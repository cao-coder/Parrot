/**
 * WebM보내기 Worker — WebCodecs 인코딩 + webm-muxer(CDN)
 */
import { Muxer, ArrayBufferTarget } from "https://cdn.jsdelivr.net/npm/webm-muxer@5.0.4/+esm";

const AUDIO_BLOCK_SAMPLES = 1024;

let muxer = null;
let target = null;
let videoEncoder = null;
let audioEncoder = null;
let exportConfig = null;
let encodedVideoFrames = 0;
let cancelled = false;
let audioDone = false;
let videoDone = false;
let finalizePending = false;
let includeAudio = false;

function postProgress(phase, percent, etaSec) {
  self.postMessage({
    type: "progress",
    phase,
    percent,
    etaSec,
  });
}

function postError(message) {
  self.postMessage({ type: "error", message });
}

function postDone(buffer) {
  self.postMessage({ type: "done", buffer }, [buffer]);
}

function maybeFinalize() {
  if (!finalizePending || !audioDone || !videoDone || cancelled) {
    return;
  }

  try {
    muxer.finalize();
    const buffer = target.buffer;
    postDone(buffer);
  } catch (err) {
    postError(
      err && err.message ? err.message : "WebM 파일을 만들지 못했습니다."
    );
  }
}

async function isVideoConfigSupported(config) {
  if (typeof VideoEncoder === "undefined") {
    return false;
  }
  try {
    const result = await VideoEncoder.isConfigSupported(config);
    return Boolean(result && result.supported);
  } catch (_err) {
    return false;
  }
}

async function isAudioConfigSupported(config) {
  if (typeof AudioEncoder === "undefined") {
    return false;
  }
  try {
    const result = await AudioEncoder.isConfigSupported(config);
    return Boolean(result && result.supported);
  } catch (_err) {
    return false;
  }
}

async function pickVideoCodec() {
  const candidates = ["vp09.00.10.08", "vp8"];
  for (let i = 0; i < candidates.length; i += 1) {
    const codec = candidates[i];
    const config = {
      codec,
      width: exportConfig.width,
      height: exportConfig.height,
      bitrate: exportConfig.videoBitrate,
      framerate: exportConfig.fps,
    };
    if (await isVideoConfigSupported(config)) {
      return codec;
    }
  }
  return "vp8";
}

function mapVideoCodecForMuxer(codec) {
  if (codec.startsWith("vp09")) {
    return "V_VP9";
  }
  return "V_VP8";
}

async function pickAudioEncoderConfig(config) {
  const candidates = [
    {
      codec: "opus",
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.audioBitrate,
    },
    {
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: config.audioBitrate,
    },
    {
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 1,
      bitrate: config.audioBitrate,
    },
    {
      codec: "opus",
      sampleRate: 44100,
      numberOfChannels: 2,
      bitrate: config.audioBitrate,
    },
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const result = await AudioEncoder.isConfigSupported(candidate);
      if (!result || !result.supported) {
        continue;
      }
      if (result.config) {
        return result.config;
      }
      return candidate;
    } catch (_err) {
      /* try next */
    }
  }

  return null;
}

async function initEncoders(config) {
  exportConfig = config;
  encodedVideoFrames = 0;
  cancelled = false;
  audioDone = false;
  videoDone = false;
  finalizePending = false;
  includeAudio = false;
  audioEncoder = null;

  target = new ArrayBufferTarget();
  const videoCodec = await pickVideoCodec();

  const audioEncoderConfig = await pickAudioEncoderConfig(config);
  if (audioEncoderConfig) {
    try {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => {
          if (muxer) {
            muxer.addAudioChunk(chunk, meta);
          }
        },
        error: (err) => {
          postError(err && err.message ? err.message : "오디오 인코딩 오류");
        },
      });
      audioEncoder.configure(audioEncoderConfig);
      includeAudio = true;
    } catch (err) {
      console.warn("[exportWorker] AudioEncoder 초기화 실패, 영상만 저장:", err);
      if (audioEncoder) {
        try {
          audioEncoder.close();
        } catch (_closeErr) {
          /* ignore */
        }
      }
      audioEncoder = null;
      includeAudio = false;
    }
  }

  if (!includeAudio) {
    audioDone = true;
  }

  const muxerOptions = {
    target,
    video: {
      codec: mapVideoCodecForMuxer(videoCodec),
      width: config.width,
      height: config.height,
      frameRate: config.fps,
    },
    firstTimestampBehavior: "offset",
  };

  if (includeAudio && audioEncoderConfig) {
    muxerOptions.audio = {
      codec: "A_OPUS",
      sampleRate: audioEncoderConfig.sampleRate,
      numberOfChannels: audioEncoderConfig.numberOfChannels,
    };
  }

  muxer = new Muxer(muxerOptions);

  videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      muxer.addVideoChunk(chunk, meta);
    },
    error: (err) => {
      postError(err && err.message ? err.message : "영상 인코딩 오류");
    },
  });

  videoEncoder.configure({
    codec: videoCodec,
    width: config.width,
    height: config.height,
    bitrate: config.videoBitrate,
    framerate: config.fps,
    latencyMode: "quality",
  });

  self.postMessage({
    type: "ready",
    videoCodec: mapVideoCodecForMuxer(videoCodec),
    includeAudio,
  });
}

async function encodeAudioPcm(pcm, sampleRate, channels) {
  if (!audioEncoder || cancelled) {
    audioDone = true;
    maybeFinalize();
    return;
  }

  const totalFrames = Math.floor(pcm.length / channels);
  let offset = 0;
  let timestampUs = 0;
  const sampleDurUs = Math.round(1_000_000 / sampleRate);

  while (offset < totalFrames && !cancelled) {
    const blockFrames = Math.min(AUDIO_BLOCK_SAMPLES, totalFrames - offset);
    const planar = new Float32Array(blockFrames * channels);

    for (let ch = 0; ch < channels; ch += 1) {
      const channelOffset = ch * blockFrames;
      for (let i = 0; i < blockFrames; i += 1) {
        planar[channelOffset + i] = pcm[(offset + i) * channels + ch];
      }
    }

    const audioData = new AudioData({
      format: "f32-planar",
      sampleRate,
      numberOfFrames: blockFrames,
      numberOfChannels: channels,
      timestamp: timestampUs,
      data: planar,
    });

    audioEncoder.encode(audioData);
    audioData.close();

    offset += blockFrames;
    timestampUs += blockFrames * sampleDurUs;

    if (offset % (sampleRate * 2) === 0) {
      const audioPct = Math.min(99, Math.round((offset / totalFrames) * 100));
      postProgress("encode-audio", audioPct, null);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  if (audioEncoder && audioEncoder.state === "configured") {
    await audioEncoder.flush();
    try {
      audioEncoder.close();
    } catch (_err) {
      /* ignore */
    }
    audioEncoder = null;
  }

  audioDone = true;
  maybeFinalize();
}

async function encodeVideoFrame(bitmap, frameIndex) {
  if (!videoEncoder || cancelled) {
    if (bitmap) {
      bitmap.close();
    }
    return;
  }

  const frameDurationUs = Math.round(1_000_000 / exportConfig.fps);
  const timestampUs = frameIndex * frameDurationUs;

  const frame = new VideoFrame(bitmap, {
    timestamp: timestampUs,
    duration: frameDurationUs,
  });
  bitmap.close();

  videoEncoder.encode(frame, { keyFrame: frameIndex % (exportConfig.fps * 2) === 0 });
  frame.close();

  encodedVideoFrames += 1;
  const pct = Math.min(
    99,
    Math.round((encodedVideoFrames / exportConfig.totalFrames) * 100)
  );
  postProgress("encode-video", pct, null);
}

async function handleFinalize() {
  if (cancelled) {
    return;
  }

  finalizePending = true;

  if (videoEncoder && videoEncoder.state === "configured") {
    await videoEncoder.flush();
    videoEncoder.close();
    videoEncoder = null;
  }

  videoDone = true;
  maybeFinalize();
}

function handleCancel() {
  cancelled = true;
  try {
    if (videoEncoder && videoEncoder.state !== "closed") {
      videoEncoder.close();
    }
  } catch (_err) {
    /* ignore */
  }
  try {
    if (audioEncoder && audioEncoder.state !== "closed") {
      audioEncoder.close();
    }
  } catch (_err2) {
    /* ignore */
  }
  videoEncoder = null;
  audioEncoder = null;
  muxer = null;
  target = null;
  self.postMessage({ type: "cancelled" });
}

self.addEventListener("message", async (event) => {
  const msg = event.data;
  if (!msg || !msg.type) {
    return;
  }

  try {
    if (msg.type === "init") {
      await initEncoders(msg.config);
      return;
    }

    if (msg.type === "audio") {
      if (!includeAudio) {
        audioDone = true;
        maybeFinalize();
        return;
      }
      encodeAudioPcm(msg.pcm, msg.sampleRate, msg.channels);
      return;
    }

    if (msg.type === "frame") {
      await encodeVideoFrame(msg.bitmap, msg.frameIndex);
      return;
    }

    if (msg.type === "finalize") {
      await handleFinalize();
      return;
    }

    if (msg.type === "cancel") {
      handleCancel();
    }
  } catch (err) {
    postError(err && err.message ? err.message : String(err));
  }
});
