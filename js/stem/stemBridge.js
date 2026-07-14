/**
 * Demucs(ONNX) 분리 — 메인 스레드 어댑터
 *
 *  · 메인 스레드: 환경 점검, 파일 디코딩, 44.1kHz 리샘플링, 워커 통신, 결과 → AudioBuffer 묶기
 *  · stemWorker.js: ONNX 모델 다운로드/캐시/추론 (무거운 일은 워커가 담당)
 *
 * 첫 실행 시 모델(~170MB) 다운로드 · WASM(CPU) 추론 · HTTPS 또는 localhost 권장.
 * 분리 품질 우선(속도·WebGPU 가속은 포기). 워커는 UI 멈춤 방지용만 유지.
 * file:// 로 페이지를 열면 워커/Cache Storage가 막혀요.
 */

const MAX_DURATION_SEC = 360;
const WARN_DURATION_SEC = 240;
const SAMPLE_RATE = 44100;

function setProgress(progressEl, message, type) {
  if (!progressEl) {
    return;
  }
  progressEl.hidden = false;
  progressEl.textContent = message;
  progressEl.classList.remove("error", "warn", "info");
  if (type) {
    progressEl.classList.add(type);
  }
}

function detectEnvironmentIssues() {
  const issues = [];

  if (location.protocol === "file:") {
    issues.push({
      severity: "fatal",
      message:
        "file:// 로 페이지를 열고 있어요. 워커와 Cache Storage가 막혀요. 로컬 서버로 여세요. (예: VS Code Live Server 또는 python -m http.server)",
    });
  }

  if (
    typeof window.crossOriginIsolated !== "undefined" &&
    window.crossOriginIsolated === false
  ) {
    issues.push({
      severity: "warn",
      message:
        "멀티스레드 WASM 비활성 (COOP/COEP 없음). 품질은 동일하지만 대기가 길어질 수 있어요. python serve.py 로 여세요.",
    });
  }

  return issues;
}

function estimatePeakMemoryMb(durationSec) {
  const bytes = 5 * 2 * 4 * durationSec * SAMPLE_RATE;
  return Math.round(bytes / (1024 * 1024));
}

async function resampleStereoTo44100(decoded) {
  if (Math.abs(decoded.sampleRate - SAMPLE_RATE) < 0.5) {
    return {
      left: new Float32Array(decoded.getChannelData(0)),
      right: new Float32Array(
        decoded.numberOfChannels > 1
          ? decoded.getChannelData(1)
          : decoded.getChannelData(0)
      ),
    };
  }
  const ratio = SAMPLE_RATE / decoded.sampleRate;
  const newLen = Math.max(1, Math.ceil(decoded.length * ratio));
  const offline = new OfflineAudioContext(2, newLen, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return {
    left: new Float32Array(rendered.getChannelData(0)),
    right: new Float32Array(rendered.getChannelData(1)),
  };
}

function floatStereoToAudioBuffer(audioContext, left, right, sampleRate) {
  const len = left.length;
  const buf = audioContext.createBuffer(2, len, sampleRate);
  buf.copyToChannel(left, 0);
  buf.copyToChannel(right, 1);
  return buf;
}

function runDemucsInWorker(left, right, progressEl) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      // ?v= 는 캐시 무효화용. 워커 코드가 바뀌면 이 숫자를 올리세요.
      worker = new Worker("js/stem/stemWorker.js?v=5", { type: "module" });
    } catch (err) {
      reject(
        new Error(
          "워커를 시작하지 못했어요. 로컬 서버(예: VS Code Live Server)로 페이지를 여세요. (" +
            (err && err.message ? err.message : String(err)) +
            ")"
        )
      );
      return;
    }

    function cleanup() {
      worker.terminate();
    }

    worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg) {
        return;
      }
      if (msg.type === "progress") {
        setProgress(progressEl, msg.message, "info");
        return;
      }
      if (msg.type === "log") {
        console.log("[Demucs Worker]", msg.message);
        return;
      }
      if (msg.type === "done") {
        cleanup();
        resolve(msg.result);
        return;
      }
      if (msg.type === "error") {
        cleanup();
        reject(new Error(msg.message));
      }
    });

    worker.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(event.message || "워커에서 오류가 발생했어요."));
    });

    worker.postMessage(
      { type: "separate", left, right },
      [left.buffer, right.buffer]
    );
  });
}

function checkDurationGuard(durationSec, progressEl) {
  if (durationSec > MAX_DURATION_SEC) {
    const estMb = estimatePeakMemoryMb(durationSec);
    const ok = window.confirm(
      `곡 길이가 ${durationSec.toFixed(0)}초 입니다 (권장 ${MAX_DURATION_SEC}초 이하).\n` +
        `예상 추가 메모리 약 ${estMb}MB. 메모리 부족으로 탭이 멈출 수 있어요.\n계속할까요?`
    );
    if (!ok) {
      setProgress(progressEl, "사용자가 취소했어요.", "warn");
      return false;
    }
  } else if (durationSec > WARN_DURATION_SEC) {
    const estMb = estimatePeakMemoryMb(durationSec);
    setProgress(
      progressEl,
      `긴 곡 (${durationSec.toFixed(0)}초). 예상 추가 메모리 약 ${estMb}MB. 시간이 오래 걸릴 수 있어요.`,
      "warn"
    );
  }
  return true;
}

window.runDemucsSeparation = async function runDemucsSeparation(
  file,
  progressEl
) {
  if (!file) {
    return;
  }

  const issues = detectEnvironmentIssues();
  const fatal = issues.find((i) => i.severity === "fatal");
  if (fatal) {
    setProgress(progressEl, fatal.message, "error");
    return;
  }
  const warn = issues.find((i) => i.severity === "warn");
  if (warn) {
    setProgress(progressEl, warn.message, "warn");
  } else {
    setProgress(progressEl, "오디오 디코딩…", "info");
  }
  issues
    .filter((i) => i.severity === "info")
    .forEach((i) => console.info("[stemBridge]", i.message));

  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const raw = await file.arrayBuffer();
    const decoded = await ctx.decodeAudioData(raw.slice(0));

    if (!checkDurationGuard(decoded.duration, progressEl)) {
      return;
    }

    setProgress(progressEl, "44100 Hz로 맞추는 중…", "info");
    const { left, right } = await resampleStereoTo44100(decoded);

    setProgress(progressEl, "워커 시작…", "info");
    const result = await runDemucsInWorker(left, right, progressEl);

    const buffers = {
      drums: floatStereoToAudioBuffer(
        ctx,
        result.drums.left,
        result.drums.right,
        SAMPLE_RATE
      ),
      bass: floatStereoToAudioBuffer(
        ctx,
        result.bass.left,
        result.bass.right,
        SAMPLE_RATE
      ),
      other: floatStereoToAudioBuffer(
        ctx,
        result.other.left,
        result.other.right,
        SAMPLE_RATE
      ),
      vocals: floatStereoToAudioBuffer(
        ctx,
        result.vocals.left,
        result.vocals.right,
        SAMPLE_RATE
      ),
    };

    if (window.AudioProcessor && window.AudioProcessor.applyStemBuffers) {
      window.AudioProcessor.applyStemBuffers(buffers);
    }

    setProgress(
      progressEl,
      "완료. 분할 모드에서 스템별 파형을 확인하세요.",
      "info"
    );

    window.dispatchEvent(new CustomEvent("stems-ready"));
  } catch (err) {
    console.error(err);
    const detail = err && err.message ? err.message : String(err);
    setProgress(
      progressEl,
      "분리에 실패했어요: " + detail + " (콘솔에서 자세한 로그를 확인하세요)",
      "error"
    );
  }
};
