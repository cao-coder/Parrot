/**
 * 악기(스템) 단위 오디오 처리
 *
 * · 분리 전: 같은 믹스에 Analyser 병렬 (구조 데모)
 * · Demucs 완료 후: 스템별 AudioBuffer에서 재생 위치 기준 파형 바이트 생성 (FFT로 악기 이름 붙이지 않음)
 */
(function initAudioProcessor() {
  /** @type {Record<string, { analyser: AnalyserNode, state: object }>} */
  const instrumentChains = {};

  /** @type {Record<string, AudioBuffer>} */
  let stemBuffers = {};

  /** @type {Record<string, object>} */
  let stemAnalysisStates = {};

  let stemMode = false;
  let isWired = false;

  function disconnectAll() {
    Object.keys(instrumentChains).forEach((id) => {
      delete instrumentChains[id];
    });
    isWired = false;
  }

  function onGraphBuilt(audioContext, audioElement, mediaSource, masterAnalyser) {
    if (isWired) {
      return;
    }

    if (!window.INSTRUMENT_LIST || !window.AudioEngine.createAnalysisState) {
      return;
    }

    window.INSTRUMENT_LIST.forEach((inst) => {
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;

      const silent = audioContext.createGain();
      silent.gain.value = 0;

      mediaSource.connect(analyser);
      analyser.connect(silent);
      silent.connect(audioContext.destination);

      instrumentChains[inst.id] = {
        analyser,
        state: window.AudioEngine.createAnalysisState(),
      };
    });

    isWired = true;
  }

  function analyzeInstrument(instrumentId) {
    if (stemMode) {
      return null;
    }
    const chain = instrumentChains[instrumentId];
    if (!chain || typeof window.AudioEngine.analyzeAnalyser !== "function") {
      return null;
    }
    return window.AudioEngine.analyzeAnalyser(chain.analyser, chain.state);
  }

  function resetInstrumentStates() {
    if (stemMode) {
      Object.keys(stemAnalysisStates).forEach((id) => {
        stemAnalysisStates[id] = window.AudioEngine.createAnalysisState();
      });
      return;
    }
    if (!window.INSTRUMENT_LIST || !window.AudioEngine.createAnalysisState) {
      return;
    }
    window.INSTRUMENT_LIST.forEach((inst) => {
      const chain = instrumentChains[inst.id];
      if (chain) {
        chain.state = window.AudioEngine.createAnalysisState();
      }
    });
  }

  /**
   * 스템 버퍼의 재생 시점 주변을 Analyser와 같은 형식(0~255) 시간 도메인으로 변환
   */
  function getStemWaveformBytes(stemId, currentTimeSec, byteLen) {
    const buf = stemBuffers[stemId];
    if (!buf || byteLen <= 0) {
      return null;
    }
    const sr = buf.sampleRate;
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const center = Math.floor(currentTimeSec * sr);
    const half = Math.floor(byteLen / 2);
    const out = new Uint8Array(byteLen);
    for (let i = 0; i < byteLen; i += 1) {
      const idx = center - half + i;
      let sample = 0;
      if (idx >= 0 && idx < ch0.length) {
        sample = 0.5 * (ch0[idx] + ch1[idx]);
      }
      sample = Math.max(-1, Math.min(1, sample));
      out[i] = 128 + Math.round(sample * 127);
    }
    return out;
  }

  function analyzeStemAtPlayback(stemId, currentTimeSec, masterFreqBytes) {
    if (!stemMode || !masterFreqBytes) {
      return null;
    }
    const wfLen = 2048;
    const timeBytes = getStemWaveformBytes(stemId, currentTimeSec, wfLen);
    if (!timeBytes) {
      return null;
    }
    if (!stemAnalysisStates[stemId]) {
      stemAnalysisStates[stemId] = window.AudioEngine.createAnalysisState();
    }
    return window.AudioEngine.analyzeFromPcmBytes(
      timeBytes,
      masterFreqBytes,
      stemAnalysisStates[stemId]
    );
  }

  function applyStemBuffers(buffersById) {
    stemBuffers = buffersById || {};
    stemMode = true;
    stemAnalysisStates = {};
    if (window.STEM_INSTRUMENT_LIST) {
      window.STEM_INSTRUMENT_LIST.forEach((inst) => {
        stemAnalysisStates[inst.id] = window.AudioEngine.createAnalysisState();
      });
    }
  }

  function clearStemBuffers() {
    stemBuffers = {};
    stemAnalysisStates = {};
    stemMode = false;
  }

  function isStemMode() {
    return stemMode;
  }

  function attachRealStemsPlaceholder() {
    console.info(
      "[AudioProcessor] 서버/파일 스템은 applyStemBuffers()로 연결하세요."
    );
  }

  function getStemBuffer(stemId) {
    return stemBuffers[stemId] || null;
  }

  function getStemWaveformBytesForExport(stemId, currentTimeSec, byteLen) {
    return getStemWaveformBytes(stemId, currentTimeSec, byteLen);
  }

  window.AudioProcessor = {
    onGraphBuilt,
    analyzeInstrument,
    analyzeStemAtPlayback,
    getStemWaveformBytes,
    getStemWaveformBytesForExport,
    getStemBuffer,
    resetInstrumentStates,
    applyStemBuffers,
    clearStemBuffers,
    isStemMode,
    attachRealStemsPlaceholder,
    disconnectAll,
  };
})();
