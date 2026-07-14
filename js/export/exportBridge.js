/**
 * WebM보내기 — 메인 스레드 오케스트레이션 (프레임 렌더 + Worker 인코딩)
 */
(function initExportBridge() {
  const EXPORT_SAMPLE_RATE = 48000;
  const EXPORT_CHANNELS = 2;
  const FFT_SIZE = 2048;
  const FRAMES_PER_YIELD = 2;
  const SPLIT_GAP_BASE = 16;
  const COMBINED_ASPECT = 240 / 800;

  const QUALITY_PRESETS = {
    fast: {
      id: "fast",
      label: "빠름 (720p 30fps)",
      width: 1280,
      fps: 30,
      videoBitrate: 2_500_000,
    },
    default: {
      id: "default",
      label: "기본 (1080p 60fps)",
      width: 1920,
      fps: 60,
      videoBitrate: 6_000_000,
    },
    high: {
      id: "high",
      label: "고품질 (1440p 60fps)",
      width: 2560,
      fps: 60,
      videoBitrate: 12_000_000,
    },
  };

  let exportBtn = null;
  let exportQuality = null;
  let exportProgress = null;
  let exportWorker = null;
  let isExporting = false;
  let cancelRequested = false;
  let exportFileName = "";

  /** @type {object | null} */
  let appContext = null;

  function sanitizeBaseName(fileName) {
    const withoutExt = fileName.replace(/\.[^.]+$/i, "");
    const cleaned = withoutExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    return cleaned || "recording";
  }

  function formatEta(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "";
    }
    const total = Math.ceil(seconds);
    const mins = Math.floor(total / 60);
    const secs = total % 60;
    if (mins > 0) {
      return `약 ${mins}분 ${secs}초 남음`;
    }
    return `약 ${secs}초 남음`;
  }

  function setProgress(text, type) {
    if (!exportProgress) {
      return;
    }
    exportProgress.textContent = text;
    exportProgress.hidden = !text;
    exportProgress.classList.remove("error", "warn", "info", "is-exporting");
    if (text && type) {
      exportProgress.classList.add(type);
    }
  }

  function setExportingUi(active) {
    isExporting = active;
    if (exportBtn) {
      exportBtn.disabled = active;
    }
    if (exportQuality) {
      exportQuality.disabled = active;
    }
    if (appContext && typeof appContext.setExportLock === "function") {
      appContext.setExportLock(active);
    }
  }

  function getQualityPreset() {
    const id = exportQuality ? exportQuality.value : "default";
    return QUALITY_PRESETS[id] || QUALITY_PRESETS.default;
  }

  function getSplitLayoutHeight(width) {
    const gap = Math.round(SPLIT_GAP_BASE * (width / 800));
    const cellW = (width - gap) / 2;
    const cellH = Math.round(cellW * (2 / 5));
    return cellH * 2 + gap;
  }

  function getExportDimensions(preset, splitMode) {
    const width = preset.width;
    const height = splitMode
      ? getSplitLayoutHeight(width)
      : Math.round(width * COMBINED_ASPECT);
    return { width, height, gap: Math.round(SPLIT_GAP_BASE * (width / 800)) };
  }

  function setupExportCanvas(canvas, cssW, cssH) {
    canvas.width = cssW;
    canvas.height = cssH;
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return ctx;
  }

  function getWaveformBytesFromBuffer(audioBuffer, currentTimeSec, byteLen) {
    if (!audioBuffer || byteLen <= 0) {
      return null;
    }
    const sr = audioBuffer.sampleRate;
    const ch0 = audioBuffer.getChannelData(0);
    const ch1 = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : ch0;
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

  function computeFrequencyBytes(timeBytes) {
    const n = timeBytes.length;
    const freqCount = n / 2;
    const out = new Uint8Array(freqCount);
    const real = new Float32Array(n);
    const imag = new Float32Array(n);

    for (let i = 0; i < n; i += 1) {
      const hann = 0.5 * (1 - Math.cos((Math.PI * 2 * i) / (n - 1)));
      const sample = ((timeBytes[i] - 128) / 128) * hann;
      real[i] = sample;
      imag[i] = 0;
    }

    bitReversePermute(real, imag, n);

    for (let size = 2; size <= n; size *= 2) {
      const halfSize = size / 2;
      const step = (Math.PI * 2) / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0; j < halfSize; j += 1) {
          const evenIdx = i + j;
          const oddIdx = i + j + halfSize;
          const angle = step * j;
          const cos = Math.cos(angle);
          const sin = Math.sin(angle);
          const tReal = real[oddIdx] * cos + imag[oddIdx] * sin;
          const tImag = imag[oddIdx] * cos - real[oddIdx] * sin;
          real[oddIdx] = real[evenIdx] - tReal;
          imag[oddIdx] = imag[evenIdx] - tImag;
          real[evenIdx] += tReal;
          imag[evenIdx] += tImag;
        }
      }
    }

    for (let i = 0; i < freqCount; i += 1) {
      const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
      const norm = Math.min(1, mag * 4);
      out[i] = Math.round(norm * 255);
    }

    return out;
  }

  function bitReversePermute(real, imag, n) {
    let j = 0;
    for (let i = 1; i < n; i += 1) {
      let bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
      if (i < j) {
        const tr = real[i];
        real[i] = real[j];
        real[j] = tr;
        const ti = imag[i];
        imag[i] = imag[j];
        imag[j] = ti;
      }
    }
  }

  function resampleAudioBuffer(sourceBuffer, targetRate, channels) {
    const duration = sourceBuffer.duration;
    const frameCount = Math.ceil(duration * targetRate);
    const pcm = new Float32Array(frameCount * channels);
    const chCount = sourceBuffer.numberOfChannels;
    const srcRate = sourceBuffer.sampleRate;
    const srcCh = [];
    for (let c = 0; c < chCount; c += 1) {
      srcCh.push(sourceBuffer.getChannelData(c));
    }

    for (let i = 0; i < frameCount; i += 1) {
      const srcIdx = (i * srcRate) / targetRate;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(srcCh[0].length - 1, idx0 + 1);
      const frac = srcIdx - idx0;
      for (let ch = 0; ch < channels; ch += 1) {
        const srcChannel = ch < chCount ? srcCh[ch] : srcCh[0];
        const s0 = srcChannel[idx0] || 0;
        const s1 = srcChannel[idx1] || 0;
        pcm[i * channels + ch] = s0 + (s1 - s0) * frac;
      }
    }

    return pcm;
  }

  async function decodeAudioFile(file) {
    const arrayBuffer = await file.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContextClass();
    try {
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
      return decoded;
    } finally {
      await ctx.close();
    }
  }

  function createAnalysisStates(instrumentList) {
    const states = {};
    instrumentList.forEach((inst) => {
      states[inst.id] = window.AudioEngine.createAnalysisState();
    });
    return states;
  }

  function analyzeInstrumentsAtTime(
    timeSec,
    mixBuffer,
    instrumentList,
    analysisStates,
    stemMode
  ) {
    const timeBytes = getWaveformBytesFromBuffer(mixBuffer, timeSec, FFT_SIZE);
    if (!timeBytes) {
      return {};
    }
    const freqBytes = computeFrequencyBytes(timeBytes);
    const perInstrument = {};

    if (stemMode && window.AudioProcessor) {
      instrumentList.forEach((inst) => {
        const stemBuf = window.AudioProcessor.getStemBuffer(inst.id);
        if (!stemBuf) {
          return;
        }
        const stemTimeBytes = getWaveformBytesFromBuffer(stemBuf, timeSec, FFT_SIZE);
        if (!stemTimeBytes) {
          return;
        }
        const data = window.AudioEngine.analyzeFromPcmBytes(
          stemTimeBytes,
          freqBytes,
          analysisStates[inst.id]
        );
        if (data) {
          perInstrument[inst.id] = data;
        }
      });
      return perInstrument;
    }

    const mixData = window.AudioEngine.analyzeFromPcmBytes(
      timeBytes,
      freqBytes,
      analysisStates[instrumentList[0].id]
    );
    if (!mixData) {
      return perInstrument;
    }
    instrumentList.forEach((inst) => {
      perInstrument[inst.id] = mixData;
    });
    return perInstrument;
  }

  function isBassInstrument(id) {
    return id === "bass";
  }

  function isDrumsInstrument(id) {
    return id === "drums";
  }

  function isOtherInstrument(id) {
    return id === "other";
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

  function drawInstrumentWaveExport(instrumentId, data, targetCanvas, options) {
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

    if (isBassInstrument(instrumentId) && options.splitMode) {
      drawParams.timeBuffer = data.waveformBuffer;
      drawParams.exportTimeSec = options.exportTimeSec;
      window.Visualizer.drawBassEchoTrailWave(drawParams);
      return;
    }

    if (isDrumsInstrument(instrumentId) && options.splitMode) {
      drawParams.timeBuffer = data.waveformBuffer;
      window.Visualizer.drawDrumsDotWave(drawParams);
      return;
    }

    if (isOtherInstrument(instrumentId) && options.splitMode) {
      drawParams.timeBuffer = data.waveformBuffer;
      drawParams.splitStretched = true;
      window.Visualizer.drawOtherGradientWave(drawParams);
      return;
    }

    if (instrumentId === "vocals" && options.splitMode) {
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

  function clearInstrumentCanvasExport(instrumentId, targetCanvas, splitMode) {
    if (!targetCanvas) {
      return;
    }
    if (isBassInstrument(instrumentId) && splitMode) {
      window.Visualizer.clearBassSlot(targetCanvas);
      return;
    }
    window.Visualizer.clearSlot(targetCanvas);
  }

  function clearExportCanvas(targetCanvas) {
    if (!targetCanvas) {
      return;
    }
    const ctx = targetCanvas.getContext("2d");
    const bg =
      window.ThemeConfig && window.ThemeConfig.getCanvasBackground
        ? window.ThemeConfig.getCanvasBackground()
        : "#ffffff";
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
  }

  function renderCombinedFrame(
    perInstrument,
    instrumentList,
    visibleIds,
    overlapStems,
    combinedCanvas,
    exportTimeSec
  ) {
    if (visibleIds.length === 0) {
      clearExportCanvas(combinedCanvas);
      return;
    }

    if (!overlapStems) {
      const firstId = visibleIds.find((id) => perInstrument[id]);
      if (!firstId) {
        clearExportCanvas(combinedCanvas);
        return;
      }
      drawInstrumentWaveExport(firstId, perInstrument[firstId], combinedCanvas, {
        live: false,
        skipClear: false,
        midYOffset: 0,
        splitMode: false,
        exportTimeSec,
      });
      return;
    }

    let first = true;
    visibleIds.forEach((id, idx) => {
      const data = perInstrument[id];
      if (!data) {
        return;
      }
      window.Visualizer.draw({
        timeBuffer: data.waveformBuffer,
        loudness: data.loudness,
        waveAlpha: data.waveAlpha,
        lineWidth: data.lineWidth,
        live: false,
        targetCanvas: combinedCanvas,
        skipClear: !first,
        midYOffset: (idx - (visibleIds.length - 1) / 2) * 4,
        instrumentId: id,
        waveColor: window.ThemeConfig
          ? window.ThemeConfig.getInstrumentColor(id)
          : undefined,
      });
      first = false;
    });
  }

  function renderSplitFrame(
    perInstrument,
    instrumentList,
    visibleIds,
    slotCanvases,
    outputCanvas,
    dims,
    exportTimeSec
  ) {
    const { width, height, gap } = dims;
    const cellW = (width - gap) / 2;
    const cellH = (height - gap) / 2;

    instrumentList.forEach((inst) => {
      const slotCanvas = slotCanvases[inst.id];
      if (!slotCanvas) {
        return;
      }
      if (!visibleIds.includes(inst.id)) {
        clearInstrumentCanvasExport(inst.id, slotCanvas, true);
        return;
      }
      const data = perInstrument[inst.id];
      if (!data) {
        clearInstrumentCanvasExport(inst.id, slotCanvas, true);
        return;
      }
      drawInstrumentWaveExport(inst.id, data, slotCanvas, {
        live: false,
        splitMode: true,
        exportTimeSec,
      });
    });

    const outCtx = outputCanvas.getContext("2d");
    const bg =
      window.ThemeConfig && window.ThemeConfig.getCanvasBackground
        ? window.ThemeConfig.getCanvasBackground()
        : "#ffffff";
    outCtx.fillStyle = bg;
    outCtx.fillRect(0, 0, width, height);

    let visibleIndex = 0;
    instrumentList.forEach((inst) => {
      if (!visibleIds.includes(inst.id)) {
        return;
      }
      const slotCanvas = slotCanvases[inst.id];
      if (!slotCanvas) {
        return;
      }
      const col = visibleIndex % 2;
      const row = Math.floor(visibleIndex / 2);
      const x = col * (cellW + gap);
      const y = row * (cellH + gap);
      outCtx.drawImage(slotCanvas, x, y, cellW, cellH);
      visibleIndex += 1;
    });
  }

  function waitForWorkerMessage(worker, type, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.removeEventListener("message", onMessage);
        reject(new Error("Worker 응답 시간이 초과되었습니다."));
      }, timeoutMs);

      function onMessage(event) {
        const msg = event.data;
        if (!msg || msg.type !== type) {
          if (msg && msg.type === "error") {
            clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            reject(new Error(msg.message || "Worker 오류"));
          }
          return;
        }
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        resolve(msg);
      }

      worker.addEventListener("message", onMessage);
    });
  }

  async function yieldToUi() {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  async function runExport(file) {
    if (typeof VideoEncoder === "undefined") {
      setProgress(
        "이 브라우저에서는 WebM보내기(WebCodecs 영상 인코딩)를 지원하지 않습니다.",
        "error"
      );
      return;
    }

    const preset = getQualityPreset();
    const splitMode = appContext && appContext.isSplitLayout();
    const dims = getExportDimensions(preset, splitMode);
    const instrumentList = appContext.getActiveInstrumentList();
    const visibleIds = instrumentList
      .map((inst) => inst.id)
      .filter((id) => appContext.isInstrumentVisible(id));
    const overlapStems = appContext.shouldDrawOverlappingStems();
    const stemMode = window.AudioProcessor && window.AudioProcessor.isStemMode();

    setExportingUi(true);
    cancelRequested = false;
    exportFileName = file.name;
    setProgress("오디오 준비 중...", "is-exporting");

    let mixBuffer = null;
    try {
      mixBuffer = await decodeAudioFile(file);
    } catch (err) {
      console.error(err);
      setProgress("오디오 파일을 디코딩하지 못했습니다.", "error");
      setExportingUi(false);
      return;
    }

    const duration = mixBuffer.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      setProgress("유효한 오디오 길이를 찾을 수 없습니다.", "error");
      setExportingUi(false);
      return;
    }

    const totalFrames = Math.max(1, Math.ceil(duration * preset.fps));
    const pcm = resampleAudioBuffer(mixBuffer, EXPORT_SAMPLE_RATE, EXPORT_CHANNELS);

    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;visibility:hidden;";
    document.body.appendChild(host);

    const outputCanvas = document.createElement("canvas");
    setupExportCanvas(outputCanvas, dims.width, dims.height);
    host.appendChild(outputCanvas);

    const slotCanvases = {};
    if (splitMode) {
      const cellW = (dims.width - dims.gap) / 2;
      const cellH = (dims.height - dims.gap) / 2;
      instrumentList.forEach((inst) => {
        const cnv = document.createElement("canvas");
        setupExportCanvas(cnv, cellW, cellH);
        host.appendChild(cnv);
        slotCanvases[inst.id] = cnv;
      });
    }

    const worker = new Worker("js/export/exportWorker.js?v=2", { type: "module" });
    exportWorker = worker;

    const analysisStates = createAnalysisStates(instrumentList);
    const renderStart = performance.now();
    let lastProgressUpdate = 0;

    function updateRenderProgress(frameIndex) {
      const now = performance.now();
      if (now - lastProgressUpdate < 80 && frameIndex < totalFrames - 1) {
        return;
      }
      lastProgressUpdate = now;

      const pct = Math.min(99, Math.round((frameIndex / totalFrames) * 100));
      const elapsedSec = (now - renderStart) / 1000;
      const framesDone = Math.max(1, frameIndex);
      const etaSec =
        frameIndex > 0
          ? (elapsedSec / framesDone) * (totalFrames - frameIndex)
          : null;
      const etaText = etaSec !== null ? ` · ${formatEta(etaSec)}` : "";
      setProgress(`영상 생성 중... ${pct}%${etaText}`, "is-exporting");
    }

    worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg) {
        return;
      }
      if (msg.type === "progress") {
        const etaText =
          msg.etaSec !== null && msg.etaSec !== undefined
            ? ` · ${formatEta(msg.etaSec)}`
            : "";
        const label =
          msg.phase === "encode-audio" ? "오디오 인코딩 중..." : "영상 인코딩 중...";
        setProgress(`${label} ${msg.percent}%${etaText}`, "is-exporting");
      }
    });

    try {
      setProgress("인코더 준비 중...", "is-exporting");

      worker.postMessage({
        type: "init",
        config: {
          width: dims.width,
          height: dims.height,
          fps: preset.fps,
          totalFrames,
          duration,
          sampleRate: EXPORT_SAMPLE_RATE,
          channels: EXPORT_CHANNELS,
          videoBitrate: preset.videoBitrate,
          audioBitrate: 192_000,
        },
      });

      const readyMsg = await waitForWorkerMessage(worker, "ready", 120_000);

      if (!readyMsg.includeAudio) {
        setProgress(
          "오디오 인코딩을 사용할 수 없어 영상만 저장합니다. 영상 생성 중...",
          "warn"
        );
        await yieldToUi();
      } else {
        worker.postMessage(
          {
            type: "audio",
            pcm,
            sampleRate: EXPORT_SAMPLE_RATE,
            channels: EXPORT_CHANNELS,
          },
          [pcm.buffer]
        );
      }

      for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
        if (cancelRequested) {
          throw new Error("보내기가 취소되었습니다.");
        }

        const timeSec = Math.min(duration, frameIndex / preset.fps);
        const perInstrument = analyzeInstrumentsAtTime(
          timeSec,
          mixBuffer,
          instrumentList,
          analysisStates,
          stemMode
        );

        if (splitMode) {
          renderSplitFrame(
            perInstrument,
            instrumentList,
            visibleIds,
            slotCanvases,
            outputCanvas,
            dims,
            timeSec
          );
        } else {
          renderCombinedFrame(
            perInstrument,
            instrumentList,
            visibleIds,
            overlapStems,
            outputCanvas,
            timeSec
          );
        }

        const bitmap = await createImageBitmap(outputCanvas);
        worker.postMessage(
          {
            type: "frame",
            frameIndex,
            bitmap,
          },
          [bitmap]
        );

        updateRenderProgress(frameIndex + 1);

        if ((frameIndex + 1) % FRAMES_PER_YIELD === 0) {
          await yieldToUi();
        }
      }

      setProgress("WebM 파일 조립 중...", "is-exporting");
      worker.postMessage({ type: "finalize" });

      const doneMsg = await waitForWorkerMessage(worker, "done", 600_000);
      const blob = new Blob([doneMsg.buffer], { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${sanitizeBaseName(file.name)}_visualization.webm`;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      setProgress("WebM 저장이 완료되었습니다.", "info");
      setTimeout(() => {
        if (!isExporting) {
          setProgress("", "");
        }
      }, 4000);
    } catch (err) {
      console.error(err);
      if (cancelRequested) {
        setProgress("보내기가 취소되었습니다.", "warn");
      } else {
        setProgress(
          err && err.message ? err.message : "WebM보내기에 실패했습니다.",
          "error"
        );
      }
    } finally {
      worker.postMessage({ type: "cancel" });
      worker.terminate();
      exportWorker = null;
      document.body.removeChild(host);
      setExportingUi(false);
      cancelRequested = false;
      exportFileName = "";
    }
  }

  function onFileChangeAttempt() {
    if (!isExporting) {
      return false;
    }
    setProgress(
      "WebM보내기 중에는 파일을 변경할 수 없습니다. 완료될 때까지 기다려 주세요.",
      "error"
    );
    return true;
  }

  function onStemSeparateAttempt() {
    if (!isExporting) {
      return false;
    }
    setProgress(
      "WebM보내기 중에는 AI 스템 분리를 실행할 수 없습니다.",
      "error"
    );
    return true;
  }

  function getExportFileName() {
    return exportFileName;
  }

  function validateBeforeExport() {
    if (!appContext) {
      return false;
    }
    const file = appContext.getSelectedFile();
    if (!file) {
      setProgress("저장하려면 먼저 MP3 파일을 선택하세요.", "error");
      return false;
    }
    if (appContext.isRecording && appContext.isRecording()) {
      setProgress("녹화 중에는 WebM보내기를 할 수 없습니다.", "error");
      return false;
    }
    if (appContext.isStemSeparating && appContext.isStemSeparating()) {
      setProgress("스템 분리 중에는 WebM보내기를 할 수 없습니다.", "error");
      return false;
    }
    if (isExporting) {
      return false;
    }
    return true;
  }

  async function handleExportClick() {
    if (!validateBeforeExport()) {
      return;
    }
    const file = appContext.getSelectedFile();
    if (!file) {
      return;
    }
    setProgress("", "");
    await runExport(file);
  }

  function cancelExport() {
    if (!isExporting) {
      return;
    }
    cancelRequested = true;
    if (exportWorker) {
      exportWorker.postMessage({ type: "cancel" });
    }
  }

  function init(context) {
    appContext = context;
    exportBtn = document.getElementById("exportBtn");
    exportQuality = document.getElementById("exportQuality");
    exportProgress = document.getElementById("exportProgress");

    if (exportBtn) {
      exportBtn.addEventListener("click", handleExportClick);
    }
  }

  window.ExportBridge = {
    init,
    isExporting: () => isExporting,
    cancelExport,
    onFileChangeAttempt,
    onStemSeparateAttempt,
    getExportFileName,
    QUALITY_PRESETS,
  };
})();
