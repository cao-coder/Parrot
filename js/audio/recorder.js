/**
 * WebM 실시간 녹화 — canvas.captureStream() + MediaRecorder
 */
(function initRecorder() {
  const RECORD_FPS = 30;
  const COMPOSITE_WIDTH = 800;
  const COMPOSITE_HEIGHT = 528;
  const COMPOSITE_GAP = 16;

  let isRecording = false;
  let mediaRecorder = null;
  let recordedChunks = [];
  let videoStream = null;
  let compositeCanvas = null;
  let compositeCtx = null;
  let compositeRafId = null;
  let recordingFileName = "";

  let recordBtn = null;
  let recordStatus = null;
  let fileInputEl = null;
  let stemBtnEl = null;

  /** @type {{ getSelectedFile: () => File | null, isPlaying: () => boolean, isStemSeparating: () => boolean } | null} */
  let appContext = null;

  function showMessage(text, type) {
    if (!recordStatus) {
      return;
    }
    recordStatus.textContent = text;
    recordStatus.hidden = !text;
    recordStatus.classList.remove("error", "warn", "info", "is-recording-status");
    if (!text) {
      return;
    }
    if (type) {
      recordStatus.classList.add(type);
    }
  }

  function showRecordingStatus() {
    if (!recordStatus) {
      return;
    }
    recordStatus.textContent = "녹화 중...";
    recordStatus.hidden = false;
    recordStatus.classList.remove("error", "warn", "info");
    recordStatus.classList.add("is-recording-status");
  }

  function clearMessage() {
    showMessage("", "");
  }

  function sanitizeBaseName(fileName) {
    const withoutExt = fileName.replace(/\.[^.]+$/i, "");
    const cleaned = withoutExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim();
    return cleaned || "recording";
  }

  function isSplitLayout() {
    return window.AppUI && window.AppUI.isSplitMode();
  }

  function getCombinedCanvas() {
    return document.getElementById("waveCanvas");
  }

  function getCanvasBackgroundColor() {
    if (window.ThemeConfig && typeof window.ThemeConfig.getCanvasBackground === "function") {
      return window.ThemeConfig.getCanvasBackground();
    }
    return "#ffffff";
  }

  function ensureCompositeCanvas() {
    if (compositeCanvas && compositeCtx) {
      return compositeCanvas;
    }

    compositeCanvas = document.createElement("canvas");
    compositeCanvas.width = COMPOSITE_WIDTH;
    compositeCanvas.height = COMPOSITE_HEIGHT;
    compositeCtx = compositeCanvas.getContext("2d");
    return compositeCanvas;
  }

  function drawCompositeFrame() {
    if (!compositeCtx || !compositeCanvas) {
      return;
    }

    const cellW = (COMPOSITE_WIDTH - COMPOSITE_GAP) / 2;
    const cellH = (COMPOSITE_HEIGHT - COMPOSITE_GAP) / 2;

    compositeCtx.fillStyle = getCanvasBackgroundColor();
    compositeCtx.fillRect(0, 0, COMPOSITE_WIDTH, COMPOSITE_HEIGHT);

    const slots = document.querySelectorAll("#splitGridInner .inst-slot");
    let visibleIndex = 0;

    slots.forEach((slot) => {
      if (slot.hidden) {
        return;
      }

      const cnv = slot.querySelector("canvas");
      if (!cnv) {
        return;
      }

      const col = visibleIndex % 2;
      const row = Math.floor(visibleIndex / 2);
      const x = col * (cellW + COMPOSITE_GAP);
      const y = row * (cellH + COMPOSITE_GAP);

      compositeCtx.drawImage(cnv, x, y, cellW, cellH);
      visibleIndex += 1;
    });
  }

  function startCompositeLoop() {
    function frame() {
      if (!isRecording) {
        return;
      }
      drawCompositeFrame();
      compositeRafId = requestAnimationFrame(frame);
    }

    drawCompositeFrame();
    compositeRafId = requestAnimationFrame(frame);
  }

  function stopCompositeLoop() {
    if (compositeRafId === null) {
      return;
    }
    cancelAnimationFrame(compositeRafId);
    compositeRafId = null;
  }

  function getRecordingCanvas() {
    if (isSplitLayout()) {
      ensureCompositeCanvas();
      return compositeCanvas;
    }
    return getCombinedCanvas();
  }

  function pickMimeType(hasAudio) {
    const candidates = hasAudio
      ? [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm;codecs=vp8",
          "video/webm",
        ]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

    for (let i = 0; i < candidates.length; i += 1) {
      const mime = candidates[i];
      if (MediaRecorder.isTypeSupported(mime)) {
        return mime;
      }
    }
    return "";
  }

  function tryGetAudioStream() {
    if (!window.AudioEngine || typeof window.AudioEngine.getRecordingAudioStream !== "function") {
      return null;
    }

    try {
      window.AudioEngine.buildGraphOnce();
      return window.AudioEngine.getRecordingAudioStream();
    } catch (err) {
      console.warn("[Recorder] 오디오 스트림 캡처 실패:", err);
      return null;
    }
  }

  function stopStreamTracks(stream) {
    if (!stream) {
      return;
    }
    stream.getTracks().forEach((track) => {
      track.stop();
    });
  }

  function cleanupStreams() {
    if (window.AudioEngine && typeof window.AudioEngine.disconnectRecordingAudioStream === "function") {
      window.AudioEngine.disconnectRecordingAudioStream();
    }
    stopStreamTracks(videoStream);
    videoStream = null;
  }

  function setRecordingControlsDisabled(disabled) {
    if (fileInputEl) {
      fileInputEl.disabled = disabled;
    }
    if (stemBtnEl) {
      stemBtnEl.disabled = disabled;
    }
  }

  function updateRecordButtonUi() {
    if (!recordBtn) {
      return;
    }

    recordBtn.classList.toggle("is-recording", isRecording);

    if (isRecording) {
      recordBtn.innerHTML =
        '<span class="record-dot" aria-hidden="true"></span> ■ 녹화 중지';
      recordBtn.setAttribute("aria-label", "녹화 중지");
      return;
    }

    recordBtn.innerHTML =
      '<span class="record-dot record-dot--idle" aria-hidden="true">●</span> 녹화 시작';
    recordBtn.setAttribute("aria-label", "녹화 시작");
  }

  function downloadRecordingBlob() {
    if (recordedChunks.length === 0) {
      return;
    }

    const mimeType = recordedChunks[0].type || "video/webm";
    const blob = new Blob(recordedChunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const baseName = sanitizeBaseName(recordingFileName || "recording");

    link.href = url;
    link.download = `${baseName}_visualization.webm`;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  function finishRecordingUi() {
    stopCompositeLoop();
    cleanupStreams();
    setRecordingControlsDisabled(false);
    mediaRecorder = null;
    recordedChunks = [];
    isRecording = false;
    recordingFileName = "";
    updateRecordButtonUi();
    clearMessage();
  }

  function handleRecorderStop() {
    downloadRecordingBlob();
    finishRecordingUi();
  }

  function createMediaRecorder(canvas, includeAudio) {
    let audioStream = null;
    let tracks = [];

    try {
      videoStream = canvas.captureStream(RECORD_FPS);
    } catch (err) {
      console.error("[Recorder] captureStream 실패:", err);
      return null;
    }

    tracks = videoStream.getVideoTracks().slice();

    if (includeAudio) {
      audioStream = tryGetAudioStream();
      if (audioStream) {
        const audioTracks = audioStream.getAudioTracks();
        if (audioTracks.length > 0) {
          tracks = tracks.concat(audioTracks);
        }
      }
    }

    const hasAudioTrack = tracks.some((track) => track.kind === "audio");
    const combinedStream = new MediaStream(tracks);
    const mimeType = pickMimeType(hasAudioTrack);
    const options = mimeType ? { mimeType } : {};

    try {
      return new MediaRecorder(combinedStream, options);
    } catch (err) {
      console.warn("[Recorder] MediaRecorder 생성 실패, 영상만 재시도:", err);
    }

    stopStreamTracks(videoStream);
    videoStream = null;

    if (window.AudioEngine && typeof window.AudioEngine.disconnectRecordingAudioStream === "function") {
      window.AudioEngine.disconnectRecordingAudioStream();
    }

    try {
      videoStream = canvas.captureStream(RECORD_FPS);
      const videoOnlyStream = new MediaStream(videoStream.getVideoTracks());
      const videoMime = pickMimeType(false);
      const videoOptions = videoMime ? { mimeType: videoMime } : {};
      return new MediaRecorder(videoOnlyStream, videoOptions);
    } catch (err2) {
      console.error("[Recorder] 영상 전용 MediaRecorder도 실패:", err2);
      stopStreamTracks(videoStream);
      videoStream = null;
      return null;
    }
  }

  function validateBeforeStart() {
    if (!appContext) {
      return false;
    }

    const file = appContext.getSelectedFile();
    if (!file) {
      showMessage("녹화하려면 먼저 MP3 파일을 선택하세요.", "error");
      return false;
    }

    if (!appContext.isPlaying()) {
      showMessage("녹화하려면 음악을 재생 중이어야 합니다.", "error");
      return false;
    }

    if (appContext.isStemSeparating()) {
      showMessage("스템 분리 중에는 녹화를 시작할 수 없습니다.", "error");
      return false;
    }

    if (appContext.isExporting && appContext.isExporting()) {
      showMessage("WebM보내기 중에는 녹화를 시작할 수 없습니다.", "error");
      return false;
    }

    return true;
  }

  function handleStartRecording() {
    if (isRecording) {
      return;
    }

    if (!validateBeforeStart()) {
      return;
    }

    const file = appContext.getSelectedFile();
    if (!file) {
      return;
    }

    clearMessage();

    const canvas = getRecordingCanvas();
    if (!canvas) {
      showMessage("시각화 캔버스를 찾을 수 없습니다.", "error");
      return;
    }

    if (typeof MediaRecorder === "undefined") {
      showMessage("이 브라우저에서는 WebM 녹화를 지원하지 않습니다.", "error");
      return;
    }

    recordingFileName = file.name;
    mediaRecorder = createMediaRecorder(canvas, true);

    if (!mediaRecorder) {
      showMessage("녹화를 시작할 수 없습니다. 브라우저 설정을 확인하세요.", "error");
      cleanupStreams();
      return;
    }

    recordedChunks = [];

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (!event.data || event.data.size <= 0) {
        return;
      }
      recordedChunks.push(event.data);
    });

    mediaRecorder.addEventListener("stop", handleRecorderStop);

    mediaRecorder.addEventListener("error", (event) => {
      console.error("[Recorder] MediaRecorder 오류:", event);
      showMessage("녹화 중 오류가 발생했습니다.", "error");
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
          mediaRecorder.stop();
        } catch (stopErr) {
          finishRecordingUi();
        }
        return;
      }
      finishRecordingUi();
    });

    try {
      mediaRecorder.start(1000);
    } catch (err) {
      console.error("[Recorder] start 실패:", err);
      showMessage("녹화를 시작할 수 없습니다.", "error");
      cleanupStreams();
      mediaRecorder = null;
      return;
    }

    isRecording = true;
    setRecordingControlsDisabled(true);
    updateRecordButtonUi();
    showRecordingStatus();

    if (isSplitLayout()) {
      startCompositeLoop();
    }

    const ac = window.AudioEngine && window.AudioEngine.getAudioContext();
    if (ac && ac.state === "suspended") {
      ac.resume();
    }
  }

  /**
   * @param {{ pausePlayback?: boolean }} [options]
   */
  function handleStopRecording(options) {
    if (!isRecording || !mediaRecorder) {
      return;
    }

    if (options && options.pausePlayback && appContext && typeof appContext.pausePlayback === "function") {
      appContext.pausePlayback();
    }

    if (mediaRecorder.state === "inactive") {
      finishRecordingUi();
      return;
    }

    try {
      mediaRecorder.stop();
    } catch (err) {
      console.error("[Recorder] stop 실패:", err);
      finishRecordingUi();
    }
  }

  function handleRecordClick() {
    if (isRecording) {
      handleStopRecording({ pausePlayback: true });
      return;
    }
    handleStartRecording();
  }

  function onFileChangeAttempt() {
    if (!isRecording) {
      return false;
    }
    showMessage(
      "녹화 중에는 파일을 변경할 수 없습니다. 먼저 녹화를 중지하세요.",
      "error"
    );
    return true;
  }

  function onStemSeparateAttempt() {
    if (!isRecording) {
      return false;
    }
    showMessage(
      "녹화 중에는 AI 스템 분리를 실행할 수 없습니다. 먼저 녹화를 중지하세요.",
      "error"
    );
    return true;
  }

  function getRecordingFileName() {
    return recordingFileName;
  }

  /**
   * @param {object} context
   * @param {() => File | null} context.getSelectedFile
   * @param {() => boolean} context.isPlaying
   * @param {() => boolean} context.isStemSeparating
   * @param {() => void} [context.pausePlayback]
   */
  function init(context) {
    appContext = context;
    recordBtn = document.getElementById("recordBtn");
    recordStatus = document.getElementById("recordStatus");
    fileInputEl = document.getElementById("fileInput");
    stemBtnEl = document.getElementById("stemSeparateBtn");

    if (!recordBtn) {
      return;
    }

    recordBtn.addEventListener("click", handleRecordClick);
    updateRecordButtonUi();
  }

  window.Recorder = {
    init,
    isRecording: () => isRecording,
    stopRecording: handleStopRecording,
    onFileChangeAttempt,
    onStemSeparateAttempt,
    getRecordingFileName,
  };
})();
