/**
 * Web Audio API: AnalyserNode, 버퍼, 볼륨/주파수 분석
 * createAnalysisState / analyzeAnalyser — 악기별 병렬 Analyser(audioProcessor)에서 재사용
 */
(function initAudioEngine() {
  const audio = new Audio();
  audio.preload = "auto";

  let audioContext = null;
  let analyser = null;
  let mediaSourceNode = null;
  let recordingDestination = null;
  let isGraphReady = false;

  /** 마스터(재생·기존 로직) 분석 상태 */
  let analysisState = null;

  const LOUDNESS_SMOOTH = 0.88;
  const LOUDNESS_SENSITIVITY = 4;
  const ALPHA_MIN = 0.2;
  const ALPHA_MAX = 1;
  const LINE_WIDTH_MIN = 1;
  const LINE_WIDTH_MAX = 6;
  const LOW_BAND_FRACTION = 0.25;
  const VISUAL_SMOOTH = 0.82;

  function measureBassRatio(freqBytes) {
    const n = freqBytes.length;
    const lowCount = Math.max(1, Math.floor(n * LOW_BAND_FRACTION));
    let lowSum = 0;
    for (let i = 0; i < lowCount; i += 1) {
      lowSum += freqBytes[i];
    }
    const lowAvg = lowSum / lowCount;
    const highCount = n - lowCount;
    let highSum = 0;
    for (let i = lowCount; i < n; i += 1) {
      highSum += freqBytes[i];
    }
    const highAvg = highCount > 0 ? highSum / highCount : 0;
    const lowN = lowAvg / 255;
    const highN = highAvg / 255;
    const sum = lowN + highN + 0.0001;
    return lowN / sum;
  }

  function measureLoudnessFromTimeDomain(buffer) {
    let sumSq = 0;
    const len = buffer.length;
    if (len === 0) {
      return 0;
    }
    for (let i = 0; i < len; i += 1) {
      const d = (buffer[i] - 128) / 128;
      sumSq += d * d;
    }
    const rms = Math.sqrt(sumSq / len);
    return Math.min(1, rms * LOUDNESS_SENSITIVITY);
  }

  function mapBassRatioToThicknessT(bassRatio, freqBaseline) {
    if (!freqBaseline.ready) {
      return 0.5;
    }
    const base = Math.max(0.06, freqBaseline.bassRatio);
    const relative = bassRatio / base;
    const centered = 0.5 + (relative - 1) * 0.85;
    return Math.min(1, Math.max(0, centered));
  }

  function ensureBuffers(state, analyserNode) {
    if (
      !state.waveformBuffer ||
      state.waveformBuffer.length !== analyserNode.fftSize
    ) {
      state.waveformBuffer = new Uint8Array(analyserNode.fftSize);
      state.frequencyBuffer = new Uint8Array(analyserNode.frequencyBinCount);
    }
  }

  /**
   * 악기별 Analyser마다 독립 상태로 분석 (동일 믹스를 읽어도 상태는 분리)
   */
  function createAnalysisState() {
    return {
      smoothedLoudness: 0,
      smoothedWaveAlpha: 0.35,
      smoothedLineWidth: (LINE_WIDTH_MIN + LINE_WIDTH_MAX) / 2,
      freqBaseline: { ready: false, bassRatio: 0.5 },
      waveformBuffer: null,
      frequencyBuffer: null,
    };
  }

  function analyzeAnalyser(analyserNode, state) {
    if (!analyserNode || !state) {
      return null;
    }

    ensureBuffers(state, analyserNode);

    analyserNode.getByteTimeDomainData(state.waveformBuffer);

    const instant = measureLoudnessFromTimeDomain(state.waveformBuffer);
    state.smoothedLoudness =
      state.smoothedLoudness * LOUDNESS_SMOOTH +
      instant * (1 - LOUDNESS_SMOOTH);

    const targetAlpha =
      ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * state.smoothedLoudness;
    state.smoothedWaveAlpha =
      state.smoothedWaveAlpha * VISUAL_SMOOTH +
      targetAlpha * (1 - VISUAL_SMOOTH);

    analyserNode.getByteFrequencyData(state.frequencyBuffer);
    const bassRatio = measureBassRatio(state.frequencyBuffer);

    if (!state.freqBaseline.ready) {
      state.freqBaseline.bassRatio = Math.max(0.05, bassRatio);
      state.freqBaseline.ready = true;
    }

    const thicknessT = mapBassRatioToThicknessT(bassRatio, state.freqBaseline);
    const targetLineWidth =
      LINE_WIDTH_MIN + thicknessT * (LINE_WIDTH_MAX - LINE_WIDTH_MIN);
    state.smoothedLineWidth =
      state.smoothedLineWidth * VISUAL_SMOOTH +
      targetLineWidth * (1 - VISUAL_SMOOTH);

    return {
      waveformBuffer: state.waveformBuffer,
      frequencyBuffer: state.frequencyBuffer,
      loudness: state.smoothedLoudness,
      waveAlpha: state.smoothedWaveAlpha,
      lineWidth: state.smoothedLineWidth,
      bassRatio,
    };
  }

  /**
   * Demucs 스템처럼 이미 채워진 시간/주파수 바이트로 동일 스무딩 적용
   * (주파수는 믹스 마스터 Analyser에서 가져와 선 두께만 공유해도 됨)
   */
  function analyzeFromPcmBytes(timeUint8, freqUint8, state) {
    if (!state || !timeUint8 || !freqUint8) {
      return null;
    }
    if (
      !state.waveformBuffer ||
      state.waveformBuffer.length !== timeUint8.length
    ) {
      state.waveformBuffer = new Uint8Array(timeUint8.length);
      state.frequencyBuffer = new Uint8Array(freqUint8.length);
    }
    state.waveformBuffer.set(timeUint8);
    state.frequencyBuffer.set(freqUint8);

    const instant = measureLoudnessFromTimeDomain(state.waveformBuffer);
    state.smoothedLoudness =
      state.smoothedLoudness * LOUDNESS_SMOOTH +
      instant * (1 - LOUDNESS_SMOOTH);

    const targetAlpha =
      ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * state.smoothedLoudness;
    state.smoothedWaveAlpha =
      state.smoothedWaveAlpha * VISUAL_SMOOTH +
      targetAlpha * (1 - VISUAL_SMOOTH);

    const bassRatio = measureBassRatio(state.frequencyBuffer);

    if (!state.freqBaseline.ready) {
      state.freqBaseline.bassRatio = Math.max(0.05, bassRatio);
      state.freqBaseline.ready = true;
    }

    const thicknessT = mapBassRatioToThicknessT(bassRatio, state.freqBaseline);
    const targetLineWidth =
      LINE_WIDTH_MIN + thicknessT * (LINE_WIDTH_MAX - LINE_WIDTH_MIN);
    state.smoothedLineWidth =
      state.smoothedLineWidth * VISUAL_SMOOTH +
      targetLineWidth * (1 - VISUAL_SMOOTH);

    return {
      waveformBuffer: state.waveformBuffer,
      frequencyBuffer: state.frequencyBuffer,
      loudness: state.smoothedLoudness,
      waveAlpha: state.smoothedWaveAlpha,
      lineWidth: state.smoothedLineWidth,
      bassRatio,
    };
  }

  function buildGraphOnce() {
    if (isGraphReady) {
      return;
    }

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioContext = new AudioContextClass();

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    mediaSourceNode = audioContext.createMediaElementSource(audio);
    mediaSourceNode.connect(analyser);
    analyser.connect(audioContext.destination);

    analysisState = createAnalysisState();
    ensureBuffers(analysisState, analyser);

    isGraphReady = true;

    if (
      window.AudioProcessor &&
      typeof window.AudioProcessor.onGraphBuilt === "function"
    ) {
      window.AudioProcessor.onGraphBuilt(
        audioContext,
        audio,
        mediaSourceNode,
        analyser
      );
    }
  }

  function resetAnalysisState() {
    if (analysisState) {
      analysisState.smoothedLoudness = 0;
      analysisState.smoothedWaveAlpha = ALPHA_MIN;
      analysisState.smoothedLineWidth =
        (LINE_WIDTH_MIN + LINE_WIDTH_MAX) / 2;
      analysisState.freqBaseline.ready = false;
      analysisState.freqBaseline.bassRatio = 0.5;
    }
    if (
      window.AudioProcessor &&
      typeof window.AudioProcessor.resetInstrumentStates === "function"
    ) {
      window.AudioProcessor.resetInstrumentStates();
    }
  }

  function getAudioContext() {
    return audioContext;
  }

  /** 녹화용 MediaStream — mediaSourceNode에 병렬 연결 */
  function getRecordingAudioStream() {
    buildGraphOnce();
    if (!audioContext || !mediaSourceNode) {
      return null;
    }
    if (!recordingDestination) {
      recordingDestination = audioContext.createMediaStreamDestination();
      mediaSourceNode.connect(recordingDestination);
    }
    return recordingDestination.stream;
  }

  function disconnectRecordingAudioStream() {
    if (!recordingDestination || !mediaSourceNode) {
      recordingDestination = null;
      return;
    }
    try {
      mediaSourceNode.disconnect(recordingDestination);
    } catch (err) {
      console.warn("[AudioEngine] 녹화 오디오 연결 해제 실패:", err);
    }
    recordingDestination = null;
  }

  function getAnalyser() {
    return analyser;
  }

  function isReady() {
    return isGraphReady && analyser && analysisState;
  }

  function analyzeFrame() {
    if (!isReady()) {
      return null;
    }
    return analyzeAnalyser(analyser, analysisState);
  }

  window.AudioEngine = {
    audio,
    buildGraphOnce,
    resetAnalysisState,
    getAudioContext,
    getRecordingAudioStream,
    disconnectRecordingAudioStream,
    getAnalyser,
    isReady,
    analyzeFrame,
    createAnalysisState,
    analyzeAnalyser,
    analyzeFromPcmBytes,
    LINE_WIDTH_MIN,
    LINE_WIDTH_MAX,
    ALPHA_MIN,
    ALPHA_MAX,
  };
})();
