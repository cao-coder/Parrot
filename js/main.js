/**
 * 앱 진입: 오디오 + 멀티 악기 슬롯 시각화 + Demucs 스템 모드
 */
(function initMain() {
  const fileInput = document.getElementById("fileInput");
  const playButton = document.getElementById("playButton");
  const seekSlider = document.getElementById("seekSlider");
  const timeCurrent = document.getElementById("timeCurrent");
  const timeDuration = document.getElementById("timeDuration");
  const themeToggle = document.getElementById("themeToggle");
  const combinedCanvas = document.getElementById("waveCanvas");
  const stemBtn = document.getElementById("stemSeparateBtn");
  const stemProgress = document.getElementById("stemProgress");
  const selectedFileName = document.getElementById("selectedFileName");
  const librarySaveBtn = document.getElementById("librarySaveBtn");
  const librarySaveMode = document.getElementById("librarySaveMode");
  const librarySaveStatus = document.getElementById("librarySaveStatus");

  const splitGridInner = document.getElementById("splitGridInner");

  const audio = window.AudioEngine.audio;

  let animationId = null;
  /** @type {Record<string, { waveformBuffer: Uint8Array, frequencyBuffer: Uint8Array, loudness: number, waveAlpha: number, lineWidth: number, bassRatio?: number }>} */
  let lastInstrumentSnapshots = {};
  let hasWaveformSnapshot = false;

  let currentObjectUrl = null;
  let isSeeking = false;
  let stemSeparating = false;
  let librarySaving = false;

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0:00";
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function setPlayerControlsEnabled(enabled) {
    if (playButton) {
      playButton.disabled = !enabled;
    }
    if (seekSlider) {
      seekSlider.disabled = !enabled;
    }
  }

  function resetPlayerTimeDisplay() {
    if (timeCurrent) {
      timeCurrent.textContent = "0:00";
    }
    if (timeDuration) {
      timeDuration.textContent = "0:00";
    }
    if (seekSlider) {
      seekSlider.value = "0";
      seekSlider.setAttribute("aria-valuenow", "0");
    }
  }

  function updateSeekUi() {
    if (!seekSlider || isSeeking) {
      return;
    }

    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const pct = (audio.currentTime / duration) * 100;
    seekSlider.value = String(pct);
    seekSlider.setAttribute("aria-valuenow", String(Math.round(pct)));

    if (timeCurrent) {
      timeCurrent.textContent = formatTime(audio.currentTime);
    }
    if (timeDuration) {
      timeDuration.textContent = formatTime(duration);
    }
  }

  function handleSeekInput() {
    if (!seekSlider) {
      return;
    }

    const duration = audio.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      return;
    }

    const pct = Number(seekSlider.value);
    audio.currentTime = (pct / 100) * duration;
    seekSlider.setAttribute("aria-valuenow", String(Math.round(pct)));

    if (timeCurrent) {
      timeCurrent.textContent = formatTime(audio.currentTime);
    }
  }

  function handleSeekStart() {
    isSeeking = true;
  }

  function handleSeekEnd() {
    isSeeking = false;
    handleSeekInput();
    if (animationId !== null) {
      return;
    }
    if (audio.paused) {
      drawFromSnapshot();
      return;
    }
    drawWaveformFrame();
  }

  function getActiveInstrumentList() {
    if (window.AudioProcessor && window.AudioProcessor.isStemMode()) {
      return window.STEM_INSTRUMENT_LIST || window.INSTRUMENT_LIST;
    }
    return window.INSTRUMENT_LIST;
  }

  function isSplitLayout() {
    return window.AppUI && window.AppUI.isSplitMode();
  }

  function isInstrumentVisibleSafe(id) {
    if (!window.AppUI) {
      return true;
    }
    return window.AppUI.isInstrumentVisible(id);
  }

  /** AI 스템 분리 완료 후에만 통합 캔버스에 여러 파형을 겹쳐 그림 */
  function shouldDrawOverlappingStemsOnCombinedCanvas() {
    return window.AudioProcessor && window.AudioProcessor.isStemMode();
  }

  function isBassInstrument(instrumentId) {
    return instrumentId === "bass";
  }

  function isDrumsInstrument(instrumentId) {
    return instrumentId === "drums";
  }

  function isOtherInstrument(instrumentId) {
    return instrumentId === "other";
  }

  function getInstrumentLineWidth(instrumentId, baseLineWidth) {
    if (typeof baseLineWidth !== "number") {
      return baseLineWidth;
    }
    if (isBassInstrument(instrumentId)) {
      return baseLineWidth * 1.5;
    }
    return baseLineWidth;
  }

  function drawInstrumentWave(instrumentId, data, targetCanvas, options) {
    if (!data || !targetCanvas) {
      return;
    }

    const drawParams = {
      loudness: data.loudness,
      waveAlpha: data.waveAlpha,
      lineWidth: getInstrumentLineWidth(instrumentId, data.lineWidth),
      bassRatio: data.bassRatio,
      instrumentId,
      targetCanvas,
      ...options,
    };

    if (window.ThemeConfig) {
      drawParams.waveColor = window.ThemeConfig.getInstrumentColor(instrumentId);
    }

    if (isBassInstrument(instrumentId) && isSplitLayout()) {
      drawParams.timeBuffer = data.waveformBuffer;
      window.Visualizer.drawBassEchoTrailWave(drawParams);
      return;
    }

    if (isDrumsInstrument(instrumentId) && isSplitLayout()) {
      drawParams.timeBuffer = data.waveformBuffer;
      window.Visualizer.drawDrumsDotWave(drawParams);
      return;
    }

    if (isOtherInstrument(instrumentId) && isSplitLayout()) {
      drawParams.timeBuffer = data.waveformBuffer;
      drawParams.splitStretched = true;
      window.Visualizer.drawOtherGradientWave(drawParams);
      return;
    }

    if (instrumentId === "vocals" && isSplitLayout()) {
      drawParams.timeBuffer = data.waveformBuffer;
      drawParams.splitStretched = true;
      window.Visualizer.draw(drawParams);
      return;
    }

    window.Visualizer.draw({
      timeBuffer: data.waveformBuffer,
      instrumentId,
      waveColor: drawParams.waveColor,
      ...drawParams,
    });
  }

  function clearInstrumentCanvas(instrumentId, targetCanvas) {
    if (!targetCanvas) {
      return;
    }
    if (isBassInstrument(instrumentId) && isSplitLayout()) {
      window.Visualizer.clearBassSlot(targetCanvas);
      return;
    }
    window.Visualizer.clearSlot(targetCanvas);
  }

  window.Visualizer.init(combinedCanvas);

  function stopAnimationLoop() {
    if (animationId === null) {
      return;
    }
    cancelAnimationFrame(animationId);
    animationId = null;
  }

  function captureInstrumentSnapshot(instrumentId, data) {
    if (!data) {
      return;
    }
    let slot = lastInstrumentSnapshots[instrumentId];
    if (!slot) {
      slot = {};
      lastInstrumentSnapshots[instrumentId] = slot;
    }
    if (
      !slot.waveformBuffer ||
      slot.waveformBuffer.length !== data.waveformBuffer.length
    ) {
      slot.waveformBuffer = new Uint8Array(data.waveformBuffer.length);
      slot.frequencyBuffer = new Uint8Array(data.frequencyBuffer.length);
    }
    slot.waveformBuffer.set(data.waveformBuffer);
    slot.frequencyBuffer.set(data.frequencyBuffer);
    slot.loudness = data.loudness;
    slot.waveAlpha = data.waveAlpha;
    slot.lineWidth = data.lineWidth;
    slot.bassRatio = data.bassRatio;
  }

  function updateSnapshotFlag() {
    const list = getActiveInstrumentList();
    hasWaveformSnapshot = list.some(
      (inst) =>
        lastInstrumentSnapshots[inst.id] &&
        lastInstrumentSnapshots[inst.id].waveformBuffer
    );
  }

  function drawFromSnapshot() {
    const list = getActiveInstrumentList();
    if (!hasWaveformSnapshot || !list.length) {
      window.Visualizer.clearToThemeBackground();
      return;
    }

    const split = isSplitLayout();

    if (!split) {
      const visible = list.filter((inst) => isInstrumentVisibleSafe(inst.id));
      if (visible.length === 0) {
        window.Visualizer.clearToThemeBackground();
        return;
      }

      if (!shouldDrawOverlappingStemsOnCombinedCanvas()) {
        const firstInst = visible.find((inst) => {
          const s = lastInstrumentSnapshots[inst.id];
          return s && s.waveformBuffer;
        });
        if (!firstInst) {
          window.Visualizer.clearToThemeBackground();
          return;
        }
        const s = lastInstrumentSnapshots[firstInst.id];
        drawInstrumentWave(firstInst.id, s, combinedCanvas, {
          live: false,
          skipClear: false,
          midYOffset: 0,
        });
        return;
      }

      let first = true;
      visible.forEach((inst, idx) => {
        const s = lastInstrumentSnapshots[inst.id];
        if (!s || !s.waveformBuffer) {
          return;
        }
        drawInstrumentWave(inst.id, s, combinedCanvas, {
          live: false,
          skipClear: !first,
          midYOffset: (idx - (visible.length - 1) / 2) * 4,
        });
        first = false;
      });
      return;
    }

    list.forEach((inst) => {
      const cnv = document.querySelector(
        `canvas[data-instrument="${inst.id}"]`
      );
      if (!cnv) {
        return;
      }
      if (!isInstrumentVisibleSafe(inst.id)) {
        clearInstrumentCanvas(inst.id, cnv);
        return;
      }
      const s = lastInstrumentSnapshots[inst.id];
      if (!s || !s.waveformBuffer) {
        clearInstrumentCanvas(inst.id, cnv);
        return;
      }
      drawInstrumentWave(inst.id, s, cnv, { live: false });
    });
  }

  function redrawAfterLayoutChange() {
    if (animationId !== null) {
      return;
    }
    drawFromSnapshot();
  }

  function resizeCanvasElement(el, cssHeightPx) {
    if (!el) {
      return;
    }
    const ctx2 = el.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const parentW = el.parentElement
      ? el.parentElement.clientWidth
      : el.clientWidth;
    const cssW = el.clientWidth || parentW || 800;
    el.width = Math.floor(cssW * dpr);
    el.height = Math.floor(cssHeightPx * dpr);
    ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function resizeAllCanvases() {
    resizeCanvasElement(combinedCanvas, 240);
    document.querySelectorAll(".inst-slot canvas").forEach((cnv) => {
      const cssH = Math.max(cnv.clientHeight, 168);
      resizeCanvasElement(cnv, cssH);
    });
  }

  function resizeCanvasForDisplay() {
    const wasAnimating = animationId !== null;
    if (wasAnimating) {
      stopAnimationLoop();
    }

    resizeAllCanvases();

    if (
      wasAnimating &&
      window.AudioEngine.isReady() &&
      hasWaveformSnapshot
    ) {
      renderLiveWaveformStep(false);
      animationId = requestAnimationFrame(drawWaveformFrame);
      return;
    }

    redrawAfterLayoutChange();
  }

  window.addEventListener("resize", resizeCanvasForDisplay);
  resizeCanvasForDisplay();

  function buildSplitGrid() {
    if (!splitGridInner || !window.INSTRUMENT_LIST) {
      return;
    }
    splitGridInner.innerHTML = "";
    window.INSTRUMENT_LIST.forEach((inst) => {
      const slot = document.createElement("div");
      slot.className = "inst-slot";
      slot.setAttribute("data-instrument-id", inst.id);
      slot.id = `inst-slot-${inst.id}`;
      const lab = document.createElement("span");
      lab.className = "inst-label";
      lab.textContent = inst.label;
      const cnv = document.createElement("canvas");
      cnv.dataset.instrument = inst.id;
      cnv.setAttribute("aria-label", `${inst.label} 파형`);
      slot.appendChild(lab);
      slot.appendChild(cnv);
      splitGridInner.appendChild(slot);
    });
    if (window.AppUI && window.AppUI.syncInstrumentSlots) {
      window.AppUI.syncInstrumentSlots();
    }
  }

  function renderLiveWaveformStep(scheduleNextFrame) {
    if (!window.AudioEngine.isReady() || !window.AudioProcessor) {
      return;
    }

    const master = window.AudioEngine.analyzeFrame();
    if (!master) {
      if (scheduleNextFrame) {
        animationId = requestAnimationFrame(drawWaveformFrame);
      }
      return;
    }

    const list = getActiveInstrumentList();
    const perInstrument = {};

    if (window.AudioProcessor.isStemMode()) {
      list.forEach((inst) => {
        const d = window.AudioProcessor.analyzeStemAtPlayback(
          inst.id,
          audio.currentTime,
          master.frequencyBuffer
        );
        if (d) {
          perInstrument[inst.id] = d;
          captureInstrumentSnapshot(inst.id, d);
        }
      });
    } else {
      list.forEach((inst) => {
        const d = window.AudioProcessor.analyzeInstrument(inst.id);
        if (d) {
          perInstrument[inst.id] = d;
          captureInstrumentSnapshot(inst.id, d);
        }
      });
    }

    updateSnapshotFlag();

    const split = isSplitLayout();

    if (!split) {
      const visible = list.filter((inst) => isInstrumentVisibleSafe(inst.id));
      if (visible.length === 0) {
        window.Visualizer.clearToThemeBackground();
        if (scheduleNextFrame) {
          animationId = requestAnimationFrame(drawWaveformFrame);
        }
        return;
      }

      if (!shouldDrawOverlappingStemsOnCombinedCanvas()) {
        const firstInst = visible.find((inst) => perInstrument[inst.id]);
        if (!firstInst) {
          window.Visualizer.clearToThemeBackground();
          if (scheduleNextFrame) {
            animationId = requestAnimationFrame(drawWaveformFrame);
          }
          return;
        }
        const d = perInstrument[firstInst.id];
        drawInstrumentWave(firstInst.id, d, combinedCanvas, {
          live: true,
          skipClear: false,
          midYOffset: 0,
        });
      } else {
        let first = true;
        visible.forEach((inst, idx) => {
          const d = perInstrument[inst.id];
          if (!d) {
            return;
          }
          window.Visualizer.draw({
            timeBuffer: d.waveformBuffer,
            loudness: d.loudness,
            waveAlpha: d.waveAlpha,
            lineWidth: d.lineWidth,
            live: true,
            targetCanvas: combinedCanvas,
            skipClear: !first,
            midYOffset: (idx - (visible.length - 1) / 2) * 4,
          });
          first = false;
        });
      }
    } else {
      list.forEach((inst) => {
        const cnv = document.querySelector(
          `canvas[data-instrument="${inst.id}"]`
        );
        if (!cnv) {
          return;
        }
        if (!isInstrumentVisibleSafe(inst.id)) {
          clearInstrumentCanvas(inst.id, cnv);
          return;
        }
        const d = perInstrument[inst.id];
        if (!d) {
          return;
        }
        drawInstrumentWave(inst.id, d, cnv, { live: true });
      });
    }

    if (scheduleNextFrame) {
      animationId = requestAnimationFrame(drawWaveformFrame);
    }
  }

  function drawWaveformFrame() {
    renderLiveWaveformStep(true);
  }

  function updatePlayButtonLabel() {
    if (!playButton) {
      return;
    }

    const isPlaying = !audio.paused && !audio.ended;
    playButton.classList.toggle("is-playing", isPlaying);
    playButton.setAttribute("aria-label", isPlaying ? "일시정지" : "재생");
  }

  function resetWaveformState() {
    window.AudioEngine.resetAnalysisState();
    lastInstrumentSnapshots = {};
    hasWaveformSnapshot = false;
    if (window.AudioProcessor && window.AudioProcessor.clearStemBuffers) {
      window.AudioProcessor.clearStemBuffers();
    }
    buildSplitGrid();
    if (window.AppUI && window.AppUI.rebuildForInstrumentList) {
      window.AppUI.rebuildForInstrumentList(window.INSTRUMENT_LIST);
    }
  }

  function handleFileChange() {
    if (window.Recorder && window.Recorder.onFileChangeAttempt()) {
      if (selectedFileName && window.Recorder.getRecordingFileName) {
        selectedFileName.textContent = window.Recorder.getRecordingFileName();
        selectedFileName.title = window.Recorder.getRecordingFileName();
      }
      return;
    }

    if (window.ExportBridge && window.ExportBridge.onFileChangeAttempt()) {
      const file = fileInput.files && fileInput.files[0];
      if (selectedFileName && file) {
        const prev = window.ExportBridge.getExportFileName
          ? window.ExportBridge.getExportFileName()
          : "";
        if (prev) {
          selectedFileName.textContent = prev;
          selectedFileName.title = prev;
        }
      }
      return;
    }

    const file = fileInput.files && fileInput.files[0];
    if (selectedFileName) {
      selectedFileName.textContent = file ? file.name : "";
      selectedFileName.title = file ? file.name : "";
    }
    if (!file) {
      return;
    }

    stopAnimationLoop();
    audio.pause();
    audio.src = "";

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }

    currentObjectUrl = URL.createObjectURL(file);
    audio.src = currentObjectUrl;

    resetWaveformState();
    setPlayerControlsEnabled(false);
    resetPlayerTimeDisplay();
    updatePlayButtonLabel();
    window.Visualizer.clearToThemeBackground();
    document.querySelectorAll(".inst-slot canvas").forEach((cnv) => {
      window.Visualizer.clearSlot(cnv);
    });
    if (stemProgress) {
      stemProgress.textContent = "";
      stemProgress.hidden = true;
    }
    resizeCanvasForDisplay();
  }

  async function handlePlayClick() {
    if (!audio.src) {
      return;
    }

    window.AudioEngine.buildGraphOnce();

    const ac = window.AudioEngine.getAudioContext();
    if (ac && ac.state === "suspended") {
      await ac.resume();
    }

    if (audio.paused) {
      try {
        await audio.play();
      } catch (err) {
        console.error(err);
        return;
      }
      stopAnimationLoop();
      drawWaveformFrame();
    } else {
      audio.pause();
      stopAnimationLoop();
    }

    updatePlayButtonLabel();
  }

  const LIQUID_FILL_MS = 1700;
  const LIQUID_BASE_AMP = 5.9;
  const LIQUID_BASE_Y_FREQ = 0.855;
  const LIQUID_WAVE_LAYERS = [
    { ampRatio: 1.0, yFreqRatio: 1.0, timeSpeed: 1.0, timePhase: 0.0 },
    { ampRatio: 0.6, yFreqRatio: 0.5, timeSpeed: 1.3, timePhase: 1.45 },
    { ampRatio: 0.35, yFreqRatio: 0.25, timeSpeed: 1.7, timePhase: 2.85 },
    { ampRatio: 0.2, yFreqRatio: 0.125, timeSpeed: 2.1, timePhase: 0.92 },
    { ampRatio: 0.12, yFreqRatio: 0.0625, timeSpeed: 2.5, timePhase: 3.75 },
  ];
  let liquidProgress = 0;
  let liquidAnimFrame = null;
  let liquidPathEl = null;

  function easeInOutCubic(t) {
    if (t < 0.5) {
      return 4 * t * t * t;
    }
    return 1 - ((-2 * t + 2) ** 3) / 2;
  }

  function computeLiquidWaveOffset(normalizedY, phase) {
    let sum = 0;
    for (let i = 0; i < LIQUID_WAVE_LAYERS.length; i += 1) {
      const wave = LIQUID_WAVE_LAYERS[i];
      const spatial =
        normalizedY *
        Math.PI *
        LIQUID_BASE_Y_FREQ *
        wave.yFreqRatio *
        2;
      sum +=
        LIQUID_BASE_AMP *
        wave.ampRatio *
        Math.sin(spatial + phase * wave.timeSpeed + wave.timePhase);
    }
    const edgeSoft = 0.74 + 0.26 * Math.sin(normalizedY * Math.PI);
    return sum * edgeSoft;
  }

  function smoothLiquidOffsets(values, passes) {
    let result = values.slice();
    for (let pass = 0; pass < passes; pass += 1) {
      const next = result.slice();
      for (let i = 1; i < result.length - 1; i += 1) {
        next[i] =
          result[i - 1] * 0.2 + result[i] * 0.6 + result[i + 1] * 0.2;
      }
      result = next;
    }
    return result;
  }

  function clampLiquidEdgeSteps(edge) {
    const maxStep = 5.4;
    for (let i = 1; i < edge.length; i += 1) {
      const dx = edge[i].x - edge[i - 1].x;
      if (Math.abs(dx) <= maxStep) {
        continue;
      }
      edge[i].x = edge[i - 1].x + Math.sign(dx) * maxStep;
    }
    return edge;
  }

  function traceCatmullRomEdge(edge) {
    if (edge.length < 2) {
      return "";
    }

    const extended = [edge[0], ...edge, edge[edge.length - 1]];
    let path = "";

    for (let i = 1; i < extended.length - 2; i += 1) {
      const p0 = extended[i - 1];
      const p1 = extended[i];
      const p2 = extended[i + 1];
      const p3 = extended[i + 2];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      path += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }

    return path;
  }

  function buildLiquidPath(progress, phase) {
    const width = 100;
    const height = 100;
    const sampleCount = 48;

    if (progress <= 0) {
      return `M 0 0 L 0 0 L 0 ${height} Z`;
    }

    if (progress >= 1) {
      return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z`;
    }

    const front = progress * width;
    const rawOffsets = [];

    for (let i = 0; i <= sampleCount; i += 1) {
      const normalizedY = i / sampleCount;
      rawOffsets.push(computeLiquidWaveOffset(normalizedY, phase));
    }

    const smoothedOffsets = smoothLiquidOffsets(rawOffsets, 5);
    const edge = [];

    for (let i = 0; i <= sampleCount; i += 1) {
      const normalizedY = i / sampleCount;
      const y = normalizedY * height;
      const edgeDamp = Math.sin(normalizedY * Math.PI);
      const dampedOffset =
        smoothedOffsets[i] * (0.1 + 0.9 * edgeDamp * edgeDamp);
      edge.push({ x: front + dampedOffset, y });
    }

    clampLiquidEdgeSteps(edge);

    let path = `M 0 0 L ${edge[0].x} ${edge[0].y}`;
    path += traceCatmullRomEdge(edge);
    path += ` L 0 ${height} Z`;
    return path;
  }

  function updateLiquidVisual(phase) {
    if (!liquidPathEl) {
      return;
    }
    liquidPathEl.setAttribute("d", buildLiquidPath(liquidProgress, phase));
  }

  function updateLiquidFullState() {
    if (!themeToggle) {
      return;
    }
    themeToggle.classList.toggle("is-liquid-full", liquidProgress >= 0.998);
  }

  function stopLiquidAnimation() {
    if (liquidAnimFrame !== null) {
      cancelAnimationFrame(liquidAnimFrame);
      liquidAnimFrame = null;
    }
  }

  function animateLiquidTo(targetProgress) {
    if (!liquidPathEl) {
      return;
    }

    stopLiquidAnimation();

    const startProgress = liquidProgress;
    const startTime = performance.now();
    const phase0 = startTime * 0.0042;

    function frame(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / LIQUID_FILL_MS);
      const eased = easeInOutCubic(t);
      liquidProgress = startProgress + (targetProgress - startProgress) * eased;

      const phase = phase0 + now * 0.0044;
      updateLiquidVisual(phase);
      updateLiquidFullState();

      if (t < 1) {
        liquidAnimFrame = requestAnimationFrame(frame);
        return;
      }

      liquidAnimFrame = null;
      liquidProgress = targetProgress;
      updateLiquidVisual(phase);
      updateLiquidFullState();
    }

    liquidAnimFrame = requestAnimationFrame(frame);
  }

  function resetThemeToggleLiquid() {
    stopLiquidAnimation();
    liquidProgress = 0;
    updateLiquidVisual(0);
    if (themeToggle) {
      themeToggle.classList.remove("is-liquid-full");
    }
  }

  function handleThemeToggleLiquidEnter() {
    if (!themeToggle || !themeToggle.classList.contains("mode-toggle--to-dark")) {
      return;
    }
    animateLiquidTo(1);
  }

  function handleThemeToggleLiquidLeave() {
    if (!themeToggle || !themeToggle.classList.contains("mode-toggle--to-dark")) {
      return;
    }
    animateLiquidTo(0);
  }

  function setupThemeToggleLiquid() {
    if (!themeToggle) {
      return;
    }

    liquidPathEl = themeToggle.querySelector(".mode-toggle__liquid-shape");
    if (!liquidPathEl) {
      return;
    }

    resetThemeToggleLiquid();
    themeToggle.addEventListener("mouseenter", handleThemeToggleLiquidEnter);
    themeToggle.addEventListener("mouseleave", handleThemeToggleLiquidLeave);
  }

  function updateThemeToggleLabel() {
    if (!themeToggle) {
      return;
    }
    const isLight = document.body.classList.contains("theme-light");
    const labelEl = themeToggle.querySelector(".mode-toggle__label");
    const text = isLight ? "다크 모드" : "라이트 모드";

    if (labelEl) {
      labelEl.textContent = text;
    } else {
      themeToggle.textContent = text;
    }

    themeToggle.classList.toggle("mode-toggle--to-dark", isLight);
    themeToggle.classList.toggle("mode-toggle--to-light", !isLight);
    resetThemeToggleLiquid();
    themeToggle.setAttribute(
      "aria-label",
      isLight ? "다크 모드로 전환" : "라이트 모드로 전환"
    );
  }

  function handleThemeToggle() {
    if (document.body.classList.contains("theme-dark")) {
      document.body.classList.remove("theme-dark");
      document.body.classList.add("theme-light");
    } else {
      document.body.classList.remove("theme-light");
      document.body.classList.add("theme-dark");
    }

    updateThemeToggleLabel();

    if (window.ThemeConfig && window.ThemeConfig.refreshForModeChange) {
      window.ThemeConfig.refreshForModeChange();
      return;
    }

    if (animationId !== null) {
      return;
    }
    drawFromSnapshot();
  }

  function handleThemeChanged() {
    if (animationId !== null) {
      return;
    }
    drawFromSnapshot();
  }

  async function handleStemSeparateClick() {
    if (window.Recorder && window.Recorder.onStemSeparateAttempt()) {
      return;
    }

    if (window.ExportBridge && window.ExportBridge.onStemSeparateAttempt()) {
      return;
    }

    const file = fileInput.files && fileInput.files[0];
    if (!file) {
      window.alert("먼저 MP3 파일을 선택하세요.");
      return;
    }
    if (typeof window.runDemucsSeparation !== "function") {
      window.alert(
        "stemBridge.js가 로드되지 않았습니다. index.html에 stemBridge.js 스크립트가 있는지 확인하세요."
      );
      return;
    }
    if (stemBtn) {
      stemBtn.disabled = true;
    }
    stemSeparating = true;
    try {
      await window.runDemucsSeparation(file, stemProgress);
    } finally {
      stemSeparating = false;
      if (stemBtn && !(window.ExportBridge && window.ExportBridge.isExporting())) {
        stemBtn.disabled = false;
      }
    }
  }

  window.addEventListener("stems-ready", () => {
    buildSplitGrid();
    if (window.AppUI && window.AppUI.rebuildForInstrumentList) {
      window.AppUI.rebuildForInstrumentList(window.INSTRUMENT_LIST);
    }
    lastInstrumentSnapshots = {};
    hasWaveformSnapshot = false;
    resizeCanvasForDisplay();
    if (animationId === null && window.AudioEngine.isReady()) {
      renderLiveWaveformStep(false);
    }
  });

  window.addEventListener("theme-changed", handleThemeChanged);

  window.addEventListener("viz-needs-redraw", () => {
    if (animationId !== null) {
      return;
    }
    drawFromSnapshot();
  });

  audio.addEventListener("loadedmetadata", () => {
    setPlayerControlsEnabled(Boolean(audio.src));
    updateSeekUi();
  });

  audio.addEventListener("timeupdate", updateSeekUi);

  audio.addEventListener("ended", () => {
    stopAnimationLoop();
    updatePlayButtonLabel();
    updateSeekUi();
    if (window.Recorder && window.Recorder.isRecording()) {
      window.Recorder.stopRecording();
    }
  });

  fileInput.addEventListener("change", handleFileChange);
  if (playButton) {
    playButton.addEventListener("click", handlePlayClick);
  }
  if (seekSlider) {
    seekSlider.addEventListener("input", handleSeekInput);
    seekSlider.addEventListener("change", handleSeekEnd);
    seekSlider.addEventListener("pointerdown", handleSeekStart);
    seekSlider.addEventListener("pointerup", handleSeekEnd);
    seekSlider.addEventListener("pointercancel", handleSeekEnd);
  }
  updateThemeToggleLabel();
  setupThemeToggleLiquid();
  themeToggle.addEventListener("click", handleThemeToggle);
  if (stemBtn) {
    stemBtn.addEventListener("click", handleStemSeparateClick);
  }
  if (librarySaveBtn) {
    librarySaveBtn.addEventListener("click", saveCurrentToLibrary);
  }
  syncLibrarySaveModeUi();
  window.addEventListener("stems-ready", syncLibrarySaveModeUi);

  function setExportLock(active) {
    if (fileInput) {
      fileInput.disabled = active;
    }
    if (stemBtn) {
      stemBtn.disabled = active || stemSeparating;
    }
    if (librarySaveBtn) {
      librarySaveBtn.disabled = active || librarySaving;
    }
    if (librarySaveMode) {
      librarySaveMode.disabled = active || librarySaving;
    }
    const recordBtnEl = document.getElementById("recordBtn");
    if (recordBtnEl) {
      recordBtnEl.disabled = active;
    }
    setPlayerControlsEnabled(!active && Boolean(audio.src));
  }

  function canLoadFromLibrary() {
    if (window.Recorder && window.Recorder.isRecording()) {
      return false;
    }
    if (window.ExportBridge && window.ExportBridge.isExporting()) {
      return false;
    }
    if (stemSeparating) {
      return false;
    }
    if (librarySaving) {
      return false;
    }
    return true;
  }

  function setLibrarySaveStatus(text, type) {
    if (!librarySaveStatus) {
      return;
    }
    librarySaveStatus.textContent = text;
    librarySaveStatus.hidden = !text;
    librarySaveStatus.classList.remove("error", "warn", "info");
    if (text && type) {
      librarySaveStatus.classList.add(type);
    }
  }

  function syncLibrarySaveModeUi() {
    if (!librarySaveMode) {
      return;
    }
    const stemActive =
      window.AudioProcessor && window.AudioProcessor.isStemMode();
    const withStemsOption = librarySaveMode.querySelector(
      'option[value="with-stems"]'
    );
    if (withStemsOption) {
      withStemsOption.disabled = !stemActive;
      if (!stemActive && librarySaveMode.value === "with-stems") {
        librarySaveMode.value = "original";
      }
    }
  }

  async function getAudioBlobForLibrarySave() {
    const file = fileInput.files && fileInput.files[0];
    if (file) {
      return file;
    }
    if (!audio.src) {
      return null;
    }
    const response = await fetch(audio.src);
    if (!response.ok) {
      throw new Error("현재 곡 데이터를 읽지 못했습니다.");
    }
    const blob = await response.blob();
    const name =
      selectedFileName && selectedFileName.textContent
        ? selectedFileName.textContent
        : "saved.mp3";
    return new File([blob], name, { type: blob.type || "audio/mpeg" });
  }

  async function saveCurrentToLibrary() {
    if (!window.MusicLibrary || !window.MusicLibrary.isAvailable()) {
      setLibrarySaveStatus("IndexedDB를 사용할 수 없습니다.", "error");
      return;
    }
    if (!audio.src) {
      setLibrarySaveStatus("저장하려면 먼저 MP3를 선택하거나 불러오세요.", "error");
      return;
    }
    if (window.Recorder && window.Recorder.isRecording()) {
      setLibrarySaveStatus("녹화 중에는 저장할 수 없습니다.", "error");
      return;
    }
    if (window.ExportBridge && window.ExportBridge.isExporting()) {
      setLibrarySaveStatus("WebM 저장 중에는 보관함에 저장할 수 없습니다.", "error");
      return;
    }
    if (stemSeparating) {
      setLibrarySaveStatus("스템 분리 중에는 저장할 수 없습니다.", "error");
      return;
    }

    librarySaving = true;
    if (librarySaveBtn) {
      librarySaveBtn.disabled = true;
    }
    setLibrarySaveStatus("저장 중...", "info");

    try {
      const audioBlob = await getAudioBlobForLibrarySave();
      if (!audioBlob) {
        setLibrarySaveStatus("저장할 MP3를 찾을 수 없습니다.", "error");
        return;
      }

      const includeStems =
        librarySaveMode && librarySaveMode.value === "with-stems";

      const payload = window.MusicLibrary.buildSavePayload(audioBlob, {
        includeStems,
        fileName: audioBlob.name,
      });

      if (
        includeStems &&
        payload.hasStemSeparation &&
        (!payload.stems || Object.keys(payload.stems).length === 0)
      ) {
        setLibrarySaveStatus(
          "스템 데이터가 없습니다. 원본만 저장합니다.",
          "warn"
        );
        payload.includeStems = false;
      }

      const { id } = await window.MusicLibrary.saveProject(payload);
      setLibrarySaveStatus("보관함에 저장했습니다.", "info");

      if (window.LibraryPanel && window.LibraryPanel.refresh) {
        window.LibraryPanel.refresh();
      }

      console.info("[MusicLibrary] saved:", id);
    } catch (err) {
      console.error(err);
      setLibrarySaveStatus(
        err && err.message ? err.message : "보관함 저장에 실패했습니다.",
        "error"
      );
    } finally {
      librarySaving = false;
      if (librarySaveBtn) {
        librarySaveBtn.disabled = false;
      }
    }
  }

  async function loadLibraryProject(project) {
    if (!project || !project.audioFile) {
      throw new Error("불러올 프로젝트 데이터가 없습니다.");
    }
    if (!canLoadFromLibrary()) {
      throw new Error("녹화·저장·스템 분리 중에는 보관함 곡을 열 수 없습니다.");
    }

    const wasPlaying = project.wasPlaying === true;
    const restoreTimeSec =
      typeof project.currentTimeSec === "number" && project.currentTimeSec >= 0
        ? project.currentTimeSec
        : 0;

    if (window.ThemeConfig && window.ThemeConfig.applyAppearanceState) {
      window.ThemeConfig.applyAppearanceState({
        themeId: project.themeId,
        colorMode: project.colorMode,
      });
      updateThemeToggleLabel();
    }

    stopAnimationLoop();
    audio.pause();

    if (currentObjectUrl) {
      URL.revokeObjectURL(currentObjectUrl);
      currentObjectUrl = null;
    }

    currentObjectUrl = URL.createObjectURL(project.audioFile);
    audio.src = currentObjectUrl;

    if (selectedFileName) {
      selectedFileName.textContent = project.fileName;
      selectedFileName.title = project.fileName;
    }

    resetWaveformState();

    const canRestoreStems =
      project.hasStemSeparation &&
      project.stemsStored &&
      project.stemBuffers &&
      Object.keys(project.stemBuffers).length > 0;

    if (canRestoreStems) {
      window.AudioProcessor.applyStemBuffers(project.stemBuffers);
      buildSplitGrid();
      if (window.AppUI && window.AppUI.rebuildForInstrumentList) {
        window.AppUI.rebuildForInstrumentList(window.STEM_INSTRUMENT_LIST);
      }
    } else {
      if (window.AudioProcessor && window.AudioProcessor.clearStemBuffers) {
        window.AudioProcessor.clearStemBuffers();
      }
      buildSplitGrid();
      if (window.AppUI && window.AppUI.rebuildForInstrumentList) {
        window.AppUI.rebuildForInstrumentList(window.INSTRUMENT_LIST);
      }
    }

    if (window.AppUI && window.AppUI.setProjectViewState) {
      window.AppUI.setProjectViewState({
        splitMode: project.splitMode,
        instrumentVisibility: project.instrumentVisibility,
      });
    }

    setPlayerControlsEnabled(false);
    resetPlayerTimeDisplay();
    updatePlayButtonLabel();
    window.Visualizer.clearToThemeBackground();
    document.querySelectorAll(".inst-slot canvas").forEach((cnv) => {
      window.Visualizer.clearSlot(cnv);
    });
    if (stemProgress) {
      stemProgress.textContent = "";
      stemProgress.hidden = true;
    }
    resizeCanvasForDisplay();

    await new Promise((resolve, reject) => {
      function onMeta() {
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onErr);
        resolve();
      }
      function onErr() {
        audio.removeEventListener("loadedmetadata", onMeta);
        audio.removeEventListener("error", onErr);
        reject(new Error("보관함 곡을 재생할 수 없습니다."));
      }
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        resolve();
        return;
      }
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("error", onErr);
    });

    setPlayerControlsEnabled(true);

    const duration = audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      audio.currentTime = Math.min(restoreTimeSec, Math.max(0, duration - 0.05));
    } else if (restoreTimeSec > 0) {
      audio.currentTime = restoreTimeSec;
    }
    updateSeekUi();

    if (canRestoreStems) {
      window.dispatchEvent(new CustomEvent("stems-ready"));
    }

    if (project.hasStemSeparation && !project.stemsStored && stemProgress) {
      stemProgress.textContent =
        "스템 분리 결과가 저장되지 않았습니다. AI 스템 분리를 다시 실행하세요.";
      stemProgress.hidden = false;
      stemProgress.classList.remove("error", "warn");
    }

    if (wasPlaying) {
      window.AudioEngine.buildGraphOnce();
      const ac = window.AudioEngine.getAudioContext();
      if (ac && ac.state === "suspended") {
        await ac.resume();
      }
      try {
        await audio.play();
      } catch (err) {
        console.error(err);
        renderLiveWaveformStep(false);
        return;
      }
      drawWaveformFrame();
      return;
    }

    window.AudioEngine.buildGraphOnce();
    renderLiveWaveformStep(false);
  }

  window.AppMain = {
    canLoadFromLibrary,
    loadLibraryProject,
    saveCurrentToLibrary,
    syncLibrarySaveModeUi,
    getSelectedFile() {
      return fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    },
  };

  if (window.Recorder) {
    window.Recorder.init({
      getSelectedFile() {
        return fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      },
      isPlaying() {
        return Boolean(audio.src) && !audio.paused && !audio.ended;
      },
      isStemSeparating() {
        return stemSeparating;
      },
      isExporting() {
        return window.ExportBridge && window.ExportBridge.isExporting();
      },
      pausePlayback() {
        audio.pause();
        stopAnimationLoop();
        updatePlayButtonLabel();
      },
    });
  }

  if (window.ExportBridge) {
    window.ExportBridge.init({
      getSelectedFile() {
        return fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      },
      isSplitLayout() {
        return isSplitLayout();
      },
      isInstrumentVisible(id) {
        return isInstrumentVisibleSafe(id);
      },
      getActiveInstrumentList() {
        return getActiveInstrumentList();
      },
      shouldDrawOverlappingStems() {
        return shouldDrawOverlappingStemsOnCombinedCanvas();
      },
      isRecording() {
        return window.Recorder && window.Recorder.isRecording();
      },
      isStemSeparating() {
        return stemSeparating;
      },
      setExportLock,
    });
  }
})();
