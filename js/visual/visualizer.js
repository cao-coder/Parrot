/**
 * Canvas 파형 렌더링
 * · 기본: 시간 영역 오디오 버퍼
 * · Bass: 정석 사인파 합성 + 가로 Echo Trail (잔향 잔상)
 */
(function initVisualizer() {
  const MIN_AMPLITUDE_RATIO = 0.14;

  const DRUMS_WAVE = {
    /** 고정 점 반경(px) — 저음은 크기 대신 세로·알파·glow로 강조 */
    dotRadius: 2.5,
    /** 고정 점 중심 간격(px) — radius와 분리해 가로 흔들림 방지 */
    dotSpacing: 10,
    /** morphT=1(킥·저음)일 때 Y 진폭·알파 배율 */
    amplitudeBoostAtKick: 1.5,
    alphaBoostAtKick: 1.3,
    glowBlurAtKick: 5,
    glowAlphaAtKick: 0.38,
  };

  const BASS_WAVE = {
    /** 라이트/다크 공통 — 테마 변경 없음 */
    line: "#BF7D5B",
    backgroundLight: "#F4F7FC",
    backgroundDark: "#0c1220",
    /** RMS ≤ 0.01 또는 약 −50dBFS 이하 → 무음·정지 */
    rmsThreshold: 0.01,
    rmsDbThreshold: 0.00316,
    rmsFull: 0.11,
    rmsSmooth: 0.88,
    energySmooth: 0.9,
    cycles: 3.1,
    flowHz: 0.95,
    breatheDepth: 0.08,
    lineWidth: 4.5,
    /** 현재 파형에만 적용하는 매우 약한 glow */
    subtleGlowBlur: 2.5,
    subtleGlowAlpha: 0.1,
    /**
     * Horizontal Echo Trail — 과거 파형을 왼쪽으로 밀어 잔상 표현
     * index 0 = 0.1초 전 … index 2 = 0.3초 전
     */
    echoTrail: {
      delays: [0.1, 0.2, 0.3],
      /** 왼쪽으로 밀리는 거리(px) — 0.1초가 가장 가깝고 0.3초가 가장 멀리 */
      xOffsets: [14, 28, 44],
      opacities: [0.45, 0.22, 0.1],
      widthRatios: [0.9, 0.8, 0.7],
    },
  };

  /** Split Mode Vocals·Other 공통 — 세로 1.5배, 가로 파장 5배(넘치는 구간은 클립) */
  const SPLIT_STRETCHED_WAVE = {
    amplitudeScale: 1.5,
    horizontalStretch: 5,
  };

  const OTHER_WAVE = {
    /** RMS가 매우 낮으면 표시를 단계적으로 감쇠 */
    rmsThreshold: 0.009,
    rmsDbThreshold: 0.00316,
    rmsFull: 0.095,
    rmsSmooth: 0.88,
    /** 올라올 때는 빠르게, 내려갈 때는 천천히(곡 종료 시 자연 소멸) */
    energyAttackSmooth: 0.78,
    energyReleaseSmooth: 0.94,
    /** 이 값 미만이면 선/그라데이션 완전 비표시 */
    minVisibleEnergy: 0.0025,
  };

  let bassAnimStartMs = null;
  let bassFrozenTimeSec = 0;
  let bassSmoothedRms = 0;
  let bassSmoothedEnergy = 0;
  let otherSmoothedRms = 0;
  let otherSmoothedEnergy = 0;

  let canvas = null;
  let ctx = null;

  function isLightTheme() {
    return document.body.classList.contains("theme-light");
  }

  function getCanvasColors(instrumentId) {
    const tc = window.ThemeConfig;
    if (tc) {
      return {
        background: tc.getCanvasBackground(),
        wave: instrumentId
          ? tc.getInstrumentColor(instrumentId)
          : tc.getInstrumentColor("vocals"),
      };
    }
    if (isLightTheme()) {
      return { background: "#ffffff", wave: "#2563eb" };
    }
    return { background: "#000000", wave: "#ffffff" };
  }

  function hexToRgba(hex, alpha) {
    const n = hex.replace("#", "");
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function init(canvasElement) {
    canvas = canvasElement;
    ctx = canvas.getContext("2d");
  }

  function resetCanvasGraphicsState() {
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.setLineDash([]);
    ctx.lineDashOffset = 0;
  }

  function clearToThemeBackground() {
    if (!ctx || !canvas) {
      return;
    }

    resetCanvasGraphicsState();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    const colors = getCanvasColors();
    const effectiveDpr =
      canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    const logicalW = canvas.width / effectiveDpr;
    const logicalH = canvas.height / effectiveDpr;

    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, logicalW, logicalH);
  }

  function measureTimeBufferRms(timeBuffer) {
    if (!timeBuffer || timeBuffer.length === 0) {
      return 0;
    }
    let sumSq = 0;
    for (let i = 0; i < timeBuffer.length; i += 1) {
      const d = (timeBuffer[i] - 128) / 128;
      sumSq += d * d;
    }
    return Math.sqrt(sumSq / timeBuffer.length);
  }

  function isBassSilent(rms) {
    return (
      rms <= BASS_WAVE.rmsThreshold || rms <= BASS_WAVE.rmsDbThreshold
    );
  }

  function mapRmsToEnergy(rms) {
    if (isBassSilent(rms)) {
      return 0;
    }
    const span = BASS_WAVE.rmsFull - BASS_WAVE.rmsThreshold;
    if (span <= 0) {
      return 1;
    }
    const t = (rms - BASS_WAVE.rmsThreshold) / span;
    return Math.min(1, Math.max(0, t));
  }

  function updateBassEnergy(timeBuffer, fallbackLoudness) {
    let rms = measureTimeBufferRms(timeBuffer);
    if (!timeBuffer && typeof fallbackLoudness === "number") {
      rms = fallbackLoudness / (window.AudioEngine.LOUDNESS_SENSITIVITY || 4);
    }
    bassSmoothedRms =
      bassSmoothedRms * BASS_WAVE.rmsSmooth + rms * (1 - BASS_WAVE.rmsSmooth);

    const target = mapRmsToEnergy(bassSmoothedRms);
    bassSmoothedEnergy =
      bassSmoothedEnergy * BASS_WAVE.energySmooth +
      target * (1 - BASS_WAVE.energySmooth);

    return {
      rms: bassSmoothedRms,
      energy: bassSmoothedEnergy,
      silent: isBassSilent(bassSmoothedRms),
    };
  }

  function isOtherSilent(rms) {
    return (
      rms <= OTHER_WAVE.rmsThreshold || rms <= OTHER_WAVE.rmsDbThreshold
    );
  }

  function mapOtherRmsToEnergy(rms) {
    if (isOtherSilent(rms)) {
      return 0;
    }
    const span = OTHER_WAVE.rmsFull - OTHER_WAVE.rmsThreshold;
    if (span <= 0) {
      return 1;
    }
    const t = (rms - OTHER_WAVE.rmsThreshold) / span;
    return Math.min(1, Math.max(0, t));
  }

  function updateOtherEnergy(timeBuffer, fallbackLoudness) {
    let rms = measureTimeBufferRms(timeBuffer);
    if (!timeBuffer && typeof fallbackLoudness === "number") {
      rms = fallbackLoudness / (window.AudioEngine.LOUDNESS_SENSITIVITY || 4);
    }

    otherSmoothedRms =
      otherSmoothedRms * OTHER_WAVE.rmsSmooth +
      rms * (1 - OTHER_WAVE.rmsSmooth);

    const targetEnergy = mapOtherRmsToEnergy(otherSmoothedRms);
    const useRelease = targetEnergy < otherSmoothedEnergy;
    const smooth = useRelease
      ? OTHER_WAVE.energyReleaseSmooth
      : OTHER_WAVE.energyAttackSmooth;

    otherSmoothedEnergy =
      otherSmoothedEnergy * smooth + targetEnergy * (1 - smooth);

    return {
      rms: otherSmoothedRms,
      energy: otherSmoothedEnergy,
      silent: isOtherSilent(otherSmoothedRms),
    };
  }

  function getBassAnimTimeSec(advance) {
    if (bassAnimStartMs === null) {
      bassAnimStartMs = performance.now();
    }
    if (!advance) {
      return bassFrozenTimeSec;
    }
    const t = (performance.now() - bassAnimStartMs) / 1000;
    bassFrozenTimeSec = t;
    return t;
  }

  function getBassCanvasColors() {
    const tc = window.ThemeConfig;
    if (tc) {
      return {
        background: tc.getCanvasBackground(),
        line: tc.getInstrumentColor("bass"),
      };
    }
    if (isLightTheme()) {
      return {
        background: BASS_WAVE.backgroundLight,
        line: BASS_WAVE.line,
      };
    }
    return {
      background: BASS_WAVE.backgroundDark,
      line: BASS_WAVE.line,
    };
  }

  /** 캔버스 너비에 맞춰 Echo Trail X 간격을 미세 조정 */
  function scaleEchoXOffset(basePx, canvasWidth) {
    const scale = Math.max(0.75, Math.min(1.35, canvasWidth / 400));
    return basePx * scale;
  }

  function fillBassBackground() {
    const colors = getBassCanvasColors();
    const effectiveDpr =
      canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : 1;
    const logicalW = canvas.width / effectiveDpr;
    const logicalH = canvas.height / effectiveDpr;

    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, logicalW, logicalH);
  }

  function clearBassBackground() {
    if (!ctx || !canvas) {
      return;
    }

    resetCanvasGraphicsState();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    fillBassBackground();
  }

  /**
   * 정석 사인파 + 약한 보조파 — 둥근 곡선, 좌우 phase 흐름
   */
  function sampleBassWaveY(x, width, midY, ampScale, timeSec) {
    const tau = Math.PI * 2;
    const u = (x / width) * BASS_WAVE.cycles * tau;
    const flow = timeSec * BASS_WAVE.flowHz * tau;

    const main = Math.sin(u - flow + 0.35);
    const sub1 =
      0.14 * Math.sin(u * 2.05 - flow * 0.32 + timeSec * 0.48 + 1.1);
    const sub2 =
      0.05 * Math.sin(u * 3.6 - flow * 0.2 + timeSec * 0.68 + 2.2);
    const sub3 =
      0.025 * Math.sin(u * 5.1 - flow * 0.15 + timeSec * 0.35 + 0.7);

    const breathe =
      1 + BASS_WAVE.breatheDepth * Math.sin(timeSec * 0.28 + 0.5);

    const blended = (main + sub1 + sub2 + sub3) * breathe;
    return midY + blended * ampScale;
  }

  function traceBassFlatPath(width, midY) {
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(width, midY);
  }

  function traceBassWavePath(width, midY, ampScale, timeSec) {
    const step = Math.max(1, width / 360);
    const points = [];

    for (let x = 0; x <= width; x += step) {
      points.push({
        x,
        y: sampleBassWaveY(x, width, midY, ampScale, timeSec),
      });
    }

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);

    for (let i = 1; i < points.length - 1; i += 1) {
      const xc = (points[i].x + points[i + 1].x) / 2;
      const yc = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
    }

    const last = points[points.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  function strokeBassWaveLayer(strokeHex, alpha, lineWidth, subtleGlow) {
    ctx.save();
    ctx.strokeStyle = hexToRgba(strokeHex, alpha);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (subtleGlow && BASS_WAVE.subtleGlowBlur > 0) {
      ctx.shadowBlur = BASS_WAVE.subtleGlowBlur;
      ctx.shadowColor = hexToRgba(strokeHex, BASS_WAVE.subtleGlowAlpha);
    } else {
      ctx.shadowBlur = 0;
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Horizontal Echo Trail — 과거 파형(0.3→0.1초)을 왼쪽으로 밀어 쌓고, 현재 파형을 최상단에 그림
   */
  function strokeBassEchoTrailLayers(
    width,
    midY,
    ampScale,
    timeSec,
    lineHex,
    fadeFactor,
    lineWidth,
    flat
  ) {
    const trail = BASS_WAVE.echoTrail;
    const flatDim = flat ? 0.35 : 1;

    for (let i = trail.delays.length - 1; i >= 0; i -= 1) {
      const xOff = -scaleEchoXOffset(trail.xOffsets[i], width);
      const trailAlpha = trail.opacities[i] * fadeFactor * flatDim;
      const trailWidth =
        lineWidth * trail.widthRatios[i] * (flat ? 0.45 : 1);

      ctx.save();
      ctx.translate(xOff, 0);

      if (flat) {
        traceBassFlatPath(width, midY);
      } else {
        traceBassWavePath(width, midY, ampScale, timeSec - trail.delays[i]);
      }
      strokeBassWaveLayer(lineHex, trailAlpha, trailWidth, false);
      ctx.restore();
    }

    if (flat) {
      traceBassFlatPath(width, midY);
    } else {
      traceBassWavePath(width, midY, ampScale, timeSec);
    }

    const mainAlpha = fadeFactor * flatDim;
    const mainWidth = flat ? Math.max(1.5, lineWidth * 0.45) : lineWidth;
    strokeBassWaveLayer(lineHex, mainAlpha, mainWidth, !flat);
  }

  /**
   * @param {object} params
   * @param {HTMLCanvasElement} [params.targetCanvas]
   * @param {boolean} [params.skipClear]
   * @param {number} [params.midYOffset]
   * @param {Uint8Array} [params.timeBuffer]
   * @param {number} [params.loudness]
   * @param {number} [params.waveAlpha]
   * @param {number} [params.lineWidth]
   * @param {number} [params.exportTimeSec]
   */
  function drawBassEchoTrailWave(params) {
    if (!params) {
      return;
    }

    const targetCanvas = params.targetCanvas || canvas;
    if (!targetCanvas) {
      return;
    }

    const targetCtx = targetCanvas.getContext("2d");
    if (!targetCtx) {
      return;
    }

    const prevCanvas = canvas;
    const prevCtx = ctx;
    canvas = targetCanvas;
    ctx = targetCtx;

    try {
      const colors = getBassCanvasColors();
      const h = canvas.clientHeight;
      const w = canvas.clientWidth;
      const midY = h / 2 + (params.midYOffset || 0);

      const fallbackLoudness =
        typeof params.loudness === "number" ? params.loudness : 0;
      const bassLevel = updateBassEnergy(params.timeBuffer, fallbackLoudness);
      const silent = bassLevel.silent || bassLevel.energy < 0.002;
      const timeSec =
        typeof params.exportTimeSec === "number"
          ? params.exportTimeSec
          : getBassAnimTimeSec(!silent);

      const loudnessBlend = Math.min(1, fallbackLoudness * 1.1);
      const visualEnergy = Math.min(
        1,
        bassLevel.energy * (0.55 + 0.45 * loudnessBlend)
      );

      const ampScale = h * 0.34 * visualEnergy;
      const baseAlpha = Math.min(
        window.AudioEngine.ALPHA_MAX,
        Math.max(window.AudioEngine.ALPHA_MIN, params.waveAlpha || 0.55)
      );
      /** 무음·저볼륨 시 trail 포함 전체가 점진적으로 0으로 수렴 */
      const fadeFactor = baseAlpha * visualEnergy;
      const lineWidth =
        typeof params.lineWidth === "number"
          ? Math.max(window.AudioEngine.LINE_WIDTH_MIN, params.lineWidth)
          : BASS_WAVE.lineWidth;

      if (params.skipClear) {
        resetCanvasGraphicsState();
      } else {
        clearBassBackground();
      }

      if (fadeFactor > 0.001) {
        strokeBassEchoTrailLayers(
          w,
          midY,
          ampScale,
          timeSec,
          colors.line,
          fadeFactor,
          lineWidth,
          silent
        );
      }
    } finally {
      canvas = prevCanvas;
      ctx = prevCtx;
    }
  }

  function clearBassSlot(targetCanvas) {
    if (!targetCanvas) {
      return;
    }
    const c = targetCanvas.getContext("2d");
    const prevCanvas = canvas;
    const prevCtx = ctx;
    canvas = targetCanvas;
    ctx = c;
    clearBassBackground();
    canvas = prevCanvas;
    ctx = prevCtx;
  }

  function getSplitStretchedWaveOptions(splitStretched) {
    if (!splitStretched) {
      return { amplitudeScale: 1, horizontalStretch: 1 };
    }
    return {
      amplitudeScale: SPLIT_STRETCHED_WAVE.amplitudeScale,
      horizontalStretch: SPLIT_STRETCHED_WAVE.horizontalStretch,
    };
  }

  /**
   * @param {object} [pathOptions]
   * @param {number} [pathOptions.horizontalStretch] 가로 파장 배율(1=칸 전체, 5=한 파장이 5배 길게·넘침 클립)
   */
  function traceWaveformPath(timeBuffer, midY, amplitude, pathOptions) {
    const horizontalStretch =
      pathOptions && typeof pathOptions.horizontalStretch === "number"
        ? pathOptions.horizontalStretch
        : 1;
    const len = timeBuffer.length;
    const w = canvas.clientWidth;
    const step = len > 1 ? w / (len - 1) : w;

    ctx.beginPath();
    let started = false;
    for (let i = 0; i < len; i += 1) {
      const x = i * step * horizontalStretch;
      if (x > w) {
        break;
      }
      const v = (timeBuffer[i] - 128) / 128;
      const y = midY + v * amplitude;
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
  }

  function strokeWaveform(
    timeBuffer,
    midY,
    amplitude,
    waveHex,
    alpha,
    lineWidth,
    pathOptions
  ) {
    traceWaveformPath(timeBuffer, midY, amplitude, pathOptions);
    ctx.strokeStyle = hexToRgba(waveHex, alpha);
    ctx.lineWidth = lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  /**
   * Split Mode Other 슬롯 전용:
   * 파형 선은 유지하고, 선 아래 영역만 부드러운 세로 그라데이션으로 채움.
   *
   * @param {object} params
   * @param {Uint8Array} params.timeBuffer
   * @param {HTMLCanvasElement} [params.targetCanvas]
   * @param {boolean} [params.skipClear]
   * @param {number} [params.midYOffset]
   * @param {number} [params.loudness]
   * @param {number} [params.waveAlpha]
   * @param {number} [params.lineWidth]
   * @param {string} [params.waveColor]
   * @param {string} [params.instrumentId]
   * @param {boolean} [params.splitStretched] Split Mode Vocals·Other 가로·세로 변형
   */
  function drawOtherGradientWave(params) {
    if (!params || !params.timeBuffer) {
      return;
    }

    const targetCanvas = params.targetCanvas || canvas;
    if (!targetCanvas) {
      return;
    }

    const targetCtx = targetCanvas.getContext("2d");
    if (!targetCtx) {
      return;
    }

    const prevCanvas = canvas;
    const prevCtx = ctx;
    canvas = targetCanvas;
    ctx = targetCtx;

    try {
      const colors = getCanvasColors(params.instrumentId);
      const waveHex = params.waveColor || colors.wave;
      const h = canvas.clientHeight;
      const w = canvas.clientWidth;
      const midY = h / 2 + (params.midYOffset || 0);

      const stretchOpts = getSplitStretchedWaveOptions(params.splitStretched);
      const scale =
        MIN_AMPLITUDE_RATIO +
        (1 - MIN_AMPLITUDE_RATIO) * (typeof params.loudness === "number" ? params.loudness : 0);
      const amplitude = h * 0.46 * scale * stretchOpts.amplitudeScale;
      const otherLevel = updateOtherEnergy(params.timeBuffer, params.loudness);
      const energyFade = Math.min(1, Math.max(0, otherLevel.energy));

      const requestedAlpha =
        typeof params.waveAlpha === "number" ? params.waveAlpha : 0.55;
      const requestedWidth =
        typeof params.lineWidth === "number"
          ? params.lineWidth
          : window.AudioEngine.LINE_WIDTH_MIN;

      const clampedAlpha = Math.min(
        window.AudioEngine.ALPHA_MAX,
        Math.max(window.AudioEngine.ALPHA_MIN, requestedAlpha)
      );
      const clampedWidth = Math.min(
        window.AudioEngine.LINE_WIDTH_MAX,
        Math.max(window.AudioEngine.LINE_WIDTH_MIN, requestedWidth)
      );

      if (params.skipClear) {
        resetCanvasGraphicsState();
      } else {
        clearToThemeBackground();
      }

      if (energyFade <= OTHER_WAVE.minVisibleEnergy) {
        return;
      }

      // 1) 파형 path 생성 후 2) 하단까지 닫아 폐곡선 fill.
      traceWaveformPath(params.timeBuffer, midY, amplitude, {
        horizontalStretch: stretchOpts.horizontalStretch,
      });
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();

      const gradient = ctx.createLinearGradient(0, midY, 0, h);
      gradient.addColorStop(
        0,
        hexToRgba(waveHex, Math.min(1, clampedAlpha * 0.9 * energyFade))
      );
      gradient.addColorStop(
        0.4,
        hexToRgba(waveHex, Math.min(1, clampedAlpha * 0.45 * energyFade))
      );
      gradient.addColorStop(1, hexToRgba(waveHex, 0));

      ctx.fillStyle = gradient;
      ctx.fill();

      // stroke 선명도는 기존보다 약간 강조.
      traceWaveformPath(params.timeBuffer, midY, amplitude, {
        horizontalStretch: stretchOpts.horizontalStretch,
      });
      ctx.strokeStyle = hexToRgba(
        waveHex,
        Math.min(1, clampedAlpha * 1.05 * energyFade)
      );
      ctx.lineWidth = clampedWidth;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    } finally {
      canvas = prevCanvas;
      ctx = prevCtx;
    }
  }

  function getDrumsDotColor() {
    const tc = window.ThemeConfig;
    if (tc) {
      return tc.getInstrumentColor("drums");
    }
    return isLightTheme() ? "#000000" : "#FFFFFF";
  }

  /** bassRatio → 0(스네어·하이햇) … 1(킥) 연속 변형 계수 */
  function bassRatioToDrumsMorphT(bassRatio) {
    if (typeof bassRatio !== "number" || Number.isNaN(bassRatio)) {
      return 0.5;
    }
    const centered = (bassRatio - 0.36) * 5.2;
    return Math.min(1, Math.max(0, 0.5 + centered * 0.5));
  }

  function drumsSmoothstep(t) {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
  }

  function drumsSmoothedSample(timeBuffer, centerIndex, halfWindow) {
    const len = timeBuffer.length;
    if (len === 0) {
      return 0;
    }
    const hw = Math.max(0, Math.floor(halfWindow));
    if (hw === 0) {
      return (timeBuffer[centerIndex] - 128) / 128;
    }
    let sum = 0;
    let count = 0;
    for (let j = -hw; j <= hw; j += 1) {
      const idx = Math.min(len - 1, Math.max(0, centerIndex + j));
      sum += (timeBuffer[idx] - 128) / 128;
      count += 1;
    }
    return sum / count;
  }

  function drumsSampleAtFraction(timeBuffer, fraction, morphT) {
    const len = timeBuffer.length;
    if (len <= 1) {
      return drumsSmoothedSample(timeBuffer, 0, 0);
    }

    const fi = fraction * (len - 1);
    const i0 = Math.floor(fi);
    const i1 = Math.min(len - 1, i0 + 1);
    const frac = fi - i0;

    const smoothRadius = morphT * 7;
    const v0 = drumsSmoothedSample(timeBuffer, i0, smoothRadius);
    const v1 = drumsSmoothedSample(timeBuffer, i1, smoothRadius);

    const curvature = 0.12 + morphT * 0.78;
    const blendT = frac * (1 - curvature) + drumsSmoothstep(frac) * curvature;
    let v = v0 + (v1 - v0) * blendT;

    const sharpness = (1 - morphT) * 0.75;
    if (sharpness > 0.001 && v !== 0) {
      const sign = v < 0 ? -1 : 1;
      v = sign * Math.pow(Math.abs(v), 1 / (1 + sharpness));
    }

    return v;
  }

  /** morphT(0=하이·스네어 … 1=킥) → 세로·알파·glow 강조 계수 */
  function getDrumsKickEmphasis(morphT) {
    const t = Math.min(1, Math.max(0, morphT));
    return {
      amplitudeScale:
        1 + t * (DRUMS_WAVE.amplitudeBoostAtKick - 1),
      alphaScale: 1 + t * (DRUMS_WAVE.alphaBoostAtKick - 1),
      glowT: t,
    };
  }

  /**
   * 드럼 슬롯: 시간 영역 버퍼 → 원형 점 집합 (선 연결 없음)
   * X·간격·크기는 고정, bassRatio는 샘플 곡률 + 세로·알파·glow 강조
   */
  function fillDrumsDotWaveform(
    timeBuffer,
    midY,
    amplitude,
    dotHex,
    alpha,
    bassRatio
  ) {
    const len = timeBuffer.length;
    if (!len) {
      return;
    }

    const w = canvas.clientWidth;
    const radius = DRUMS_WAVE.dotRadius;
    const dotSpacing = DRUMS_WAVE.dotSpacing;
    const morphT = bassRatioToDrumsMorphT(bassRatio);
    const emphasis = getDrumsKickEmphasis(morphT);
    const boostedAmplitude = amplitude * emphasis.amplitudeScale;
    const dotAlpha = Math.min(
      1,
      alpha * emphasis.alphaScale
    );
    const fillStyle = hexToRgba(dotHex, dotAlpha);

    ctx.save();
    ctx.fillStyle = fillStyle;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowBlur = emphasis.glowT * DRUMS_WAVE.glowBlurAtKick;
    ctx.shadowColor = hexToRgba(
      dotHex,
      emphasis.glowT * DRUMS_WAVE.glowAlphaAtKick
    );

    for (let x = dotSpacing * 0.5; x <= w - radius; x += dotSpacing) {
      const fraction = w > 0 ? x / w : 0;
      const v = drumsSampleAtFraction(timeBuffer, fraction, morphT);
      const y = midY + v * boostedAmplitude;

      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * @param {object} params
   * @param {HTMLCanvasElement} [params.targetCanvas]
   * @param {boolean} [params.skipClear]
   * @param {number} [params.midYOffset]
   * @param {number} [params.bassRatio]
   */
  function drawDrumsDotWave(params) {
    if (!params || !params.timeBuffer) {
      return;
    }

    const targetCanvas = params.targetCanvas || canvas;
    if (!targetCanvas) {
      return;
    }

    const targetCtx = targetCanvas.getContext("2d");
    if (!targetCtx) {
      return;
    }

    const prevCanvas = canvas;
    const prevCtx = ctx;
    canvas = targetCanvas;
    ctx = targetCtx;

    try {
      const dotHex = getDrumsDotColor();
      const h = canvas.clientHeight;
      const midY = h / 2 + (params.midYOffset || 0);

      const scale =
        MIN_AMPLITUDE_RATIO +
        (1 - MIN_AMPLITUDE_RATIO) * params.loudness;
      const amplitude = h * 0.46 * scale;

      const clampedAlpha = Math.min(
        window.AudioEngine.ALPHA_MAX,
        Math.max(window.AudioEngine.ALPHA_MIN, params.waveAlpha)
      );
      if (params.skipClear) {
        resetCanvasGraphicsState();
      } else {
        clearToThemeBackground();
      }

      fillDrumsDotWaveform(
        params.timeBuffer,
        midY,
        amplitude,
        dotHex,
        clampedAlpha,
        params.bassRatio
      );
    } finally {
      canvas = prevCanvas;
      ctx = prevCtx;
    }
  }

  /**
   * @param {object} params
   * @param {HTMLCanvasElement} [params.targetCanvas]
   * @param {boolean} [params.skipClear]
   * @param {number} [params.midYOffset]
   * @param {boolean} [params.splitStretched] Split Mode Vocals·Other 가로·세로 변형
   */
  function draw(params) {
    if (!params || !params.timeBuffer) {
      return;
    }

    const targetCanvas = params.targetCanvas || canvas;
    if (!targetCanvas) {
      return;
    }

    const targetCtx = targetCanvas.getContext("2d");
    if (!targetCtx) {
      return;
    }

    const prevCanvas = canvas;
    const prevCtx = ctx;
    canvas = targetCanvas;
    ctx = targetCtx;

    try {
      const colors = getCanvasColors(params.instrumentId);
      const h = canvas.clientHeight;
      const midY = h / 2 + (params.midYOffset || 0);

      const stretchOpts = getSplitStretchedWaveOptions(params.splitStretched);
      const scale =
        MIN_AMPLITUDE_RATIO +
        (1 - MIN_AMPLITUDE_RATIO) * params.loudness;
      const amplitude = h * 0.46 * scale * stretchOpts.amplitudeScale;

      const clampedAlpha = Math.min(
        window.AudioEngine.ALPHA_MAX,
        Math.max(window.AudioEngine.ALPHA_MIN, params.waveAlpha)
      );
      const clampedWidth = Math.min(
        window.AudioEngine.LINE_WIDTH_MAX,
        Math.max(window.AudioEngine.LINE_WIDTH_MIN, params.lineWidth)
      );

      if (params.skipClear) {
        resetCanvasGraphicsState();
      } else {
        clearToThemeBackground();
      }

      strokeWaveform(
        params.timeBuffer,
        midY,
        amplitude,
        params.waveColor || colors.wave,
        clampedAlpha,
        clampedWidth,
        { horizontalStretch: stretchOpts.horizontalStretch }
      );
    } finally {
      canvas = prevCanvas;
      ctx = prevCtx;
    }
  }

  function clearSlot(targetCanvas) {
    if (!targetCanvas) {
      return;
    }
    const c = targetCanvas.getContext("2d");
    const prevCanvas = canvas;
    const prevCtx = ctx;
    canvas = targetCanvas;
    ctx = c;
    clearToThemeBackground();
    canvas = prevCanvas;
    ctx = prevCtx;
  }

  window.Visualizer = {
    init,
    clearToThemeBackground,
    clearSlot,
    clearBassSlot,
    getCanvasColors,
    draw,
    drawOtherGradientWave,
    drawDrumsDotWave,
    drawBassEchoTrailWave,
    /** @deprecated drawBassEchoTrailWave 사용 */
    drawBassGlowWave: drawBassEchoTrailWave,
  };
})();
