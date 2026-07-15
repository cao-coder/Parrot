/**
 * Demucs(ONNX) 분리 — 모듈 워커 (품질 우선 설정)
 *
 * 메인 → 워커:
 *   { type: "separate", left: Float32Array, right: Float32Array }
 * 워커 → 메인:
 *   { type: "progress", message }
 *   { type: "log", message }
 *   { type: "done", result }
 *   { type: "error", message }
 *
 * 속도 최적화(WebGPU 우선, graphOptimization "all" 등)는 품질 이득 없이
 * 체감만 바뀌는 경우가 많아, demucs-web 기본에 가깝게 WASM + basic 으로 맞춥니다.
 * UI 멈춤 방지용 워커·모델 캐시·same-origin ORT 는 유지합니다.
 */

const MODEL_CACHE_NAME = "demucs-models-v1";

/** demucs-web / ONNX Runtime 권장에 맞춘 세션 옵션 (품질 우선) */
const DEMUCS_SESSION_OPTIONS = {
  executionProviders: ["wasm"],
  graphOptimizationLevel: "basic",
  enableCpuMemArena: true,
  enableMemPattern: true,
};

let ortModule = null;
let demucsModule = null;

/** same-origin ORT — GitHub Pages 서브경로(/Parrot/)·루트 도메인 모두 동작 */
const ORT_VENDOR_BASE = new URL("../../../vendor/ort/", import.meta.url);

function detectThreadCount() {
  if (typeof self.crossOriginIsolated === "undefined" || !self.crossOriginIsolated) {
    return { count: 1, isolated: false };
  }
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return { count: Math.min(Math.max(2, cores), 8), isolated: true };
}

function reportInferenceEnvironment(threads) {
  if (threads.isolated) {
    postLog(
      `품질 모드: WASM(CPU) 추론 · 멀티스레드 ${threads.count}개 · graphOptimization=basic`
    );
  } else {
    postLog(
      "품질 모드: WASM(CPU) 추론 · 단일 스레드 (crossOriginIsolated=false). " +
        "serve.py 로 열면 멀티스레드가 켜져 품질은 동일하고 대기만 줄어듭니다."
    );
  }
}

async function loadLibrariesOnce() {
  if (ortModule && demucsModule) {
    return;
  }

  // 🔥 [수정] 깃허브 페이지 경로(/Parrot/)가 깨지지 않도록 현재 워커 위치 기준으로 경로를 재계산합니다.
  const correctedBase = new URL("../../vendor/ort/", self.location.href);

  // WASM 전용 번들 — WebGPU 시도 없이 CPU 경로만 사용 (ORT_VENDOR_BASE 대신 correctedBase 사용)
  ortModule = await import(new URL("ort.bundle.min.mjs", correctedBase).href);
  ortModule.env.wasm.wasmPaths = correctedBase.href; // .wasm 파일 경로도 함께 수정됩니다.

  const threads = detectThreadCount();
  ortModule.env.wasm.numThreads = threads.count;
  ortModule.env.wasm.simd = true;

  reportInferenceEnvironment(threads);

  demucsModule = await import(
    "https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/+esm"
  );
}

function postProgress(message) {
  self.postMessage({ type: "progress", message });
}

function postLog(message) {
  self.postMessage({ type: "log", message });
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

async function getCachedModelResponse(url) {
  if (typeof caches === "undefined") {
    return null;
  }
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    return await cache.match(url);
  } catch (err) {
    postLog(
      "캐시 조회 실패 (무시하고 다운로드 진행): " +
        (err && err.message ? err.message : String(err))
    );
    return null;
  }
}

async function putCachedModel(url, arrayBuffer) {
  if (typeof caches === "undefined") {
    return;
  }
  try {
    const cache = await caches.open(MODEL_CACHE_NAME);
    const responseForCache = new Response(arrayBuffer.slice(0), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(arrayBuffer.byteLength),
      },
    });
    await cache.put(url, responseForCache);
    postLog("모델을 캐시에 저장했어요. 다음 실행부터 다운로드를 건너뜁니다.");
  } catch (err) {
    postLog(
      "캐시 저장 실패 (이번 세션은 정상 동작): " +
        (err && err.message ? err.message : String(err))
    );
  }
}

async function downloadModelWithProgress(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("모델 다운로드 실패: HTTP " + response.status);
  }

  const totalStr = response.headers.get("Content-Length");
  const total = totalStr ? parseInt(totalStr, 10) : 0;

  if (!response.body || !total) {
    postProgress("모델 다운로드 중… (진행률 표시 불가)");
    return await response.arrayBuffer();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value);
    received += value.length;

    const pct = ((received / total) * 100).toFixed(0);
    postProgress(
      `모델 다운로드 ${formatMb(received)}MB / ${formatMb(total)}MB (${pct}%)`
    );
  }

  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged.buffer;
}

async function getModelArrayBuffer(url) {
  postProgress("모델 캐시 확인 중…");
  const cached = await getCachedModelResponse(url);
  if (cached) {
    postProgress("모델 캐시에서 불러오는 중…");
    const buffer = await cached.arrayBuffer();
    postLog(`캐시 적중: ${formatMb(buffer.byteLength)}MB (htdemucs_embedded.onnx)`);
    return buffer;
  }

  postProgress("모델 다운로드 시작 (첫 실행만, 약 170MB)…");
  const buffer = await downloadModelWithProgress(url);

  postProgress("모델을 캐시에 저장하는 중…");
  await putCachedModel(url, buffer);
  return buffer;
}

async function handleSeparate(left, right) {
  postProgress("라이브러리 로드 중…");
  await loadLibrariesOnce();

  const { DemucsProcessor, CONSTANTS } = demucsModule;

  const modelBuffer = await getModelArrayBuffer(CONSTANTS.DEFAULT_MODEL_URL);

  const processor = new DemucsProcessor({
    ort: ortModule,
    sessionOptions: DEMUCS_SESSION_OPTIONS,
    onProgress: (p) => {
      const pct = (p.progress * 100).toFixed(0);
      postProgress(
        `Demucs 분리 ${pct}% (${p.currentSegment}/${p.totalSegments})`
      );
    },
    onLog: (_phase, msg) => {
      postLog(msg);
    },
  });

  postProgress("ONNX 세션 생성 중… (WASM · 품질 우선)");
  const sessionStart = performance.now();
  await processor.loadModel(modelBuffer);
  const sessionMs = ((performance.now() - sessionStart) / 1000).toFixed(1);
  postLog(`ONNX 세션 준비 완료 (${sessionMs}s). 백엔드: WASM(CPU).`);

  postProgress("추론 시작…");
  const inferStart = performance.now();
  const result = await processor.separate(left, right);
  const inferMs = ((performance.now() - inferStart) / 1000).toFixed(1);
  postLog(`추론 완료. 분리 소요: ${inferMs}s (길이·CPU에 따라 수 분~십 분대 가능)`);

  const transferList = [
    result.drums.left.buffer,
    result.drums.right.buffer,
    result.bass.left.buffer,
    result.bass.right.buffer,
    result.other.left.buffer,
    result.other.right.buffer,
    result.vocals.left.buffer,
    result.vocals.right.buffer,
  ];

  self.postMessage(
    {
      type: "done",
      result: {
        drums: { left: result.drums.left, right: result.drums.right },
        bass: { left: result.bass.left, right: result.bass.right },
        other: { left: result.other.left, right: result.other.right },
        vocals: { left: result.vocals.left, right: result.vocals.right },
      },
    },
    transferList
  );
}

self.addEventListener("message", async (event) => {
  const data = event.data;
  if (!data || data.type !== "separate") {
    return;
  }
  try {
    await handleSeparate(data.left, data.right);
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err && err.message ? err.message : String(err),
    });
  }
});
