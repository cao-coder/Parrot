/**
 * IndexedDB 기반 음악 보관함 엔진
 * — localStorage 미사용, 대용량 Blob은 별도 스토어에 저장
 */
(function initMusicLibrary() {
  const DB_NAME = "sound-canvas-library";
  const DB_VERSION = 1;
  const META_STORE = "projectMeta";
  const FILES_STORE = "projectFiles";

  /** @type {Promise<IDBDatabase> | null} */
  let dbPromise = null;

  function createId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return `proj-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function isIndexedDbAvailable() {
    return typeof indexedDB !== "undefined";
  }

  function openDatabase() {
    if (!isIndexedDbAvailable()) {
      return Promise.reject(
        new Error("이 환경에서는 IndexedDB를 사용할 수 없습니다.")
      );
    }

    if (dbPromise) {
      return dbPromise;
    }

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains(META_STORE)) {
          const metaStore = db.createObjectStore(META_STORE, { keyPath: "id" });
          metaStore.createIndex("savedAt", "savedAt", { unique: false });
          metaStore.createIndex("fileName", "fileName", { unique: false });
        }

        if (!db.objectStoreNames.contains(FILES_STORE)) {
          db.createObjectStore(FILES_STORE, { keyPath: "id" });
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error("IndexedDB를 열지 못했습니다."));
      };

      request.onblocked = () => {
        console.warn(
          "[MusicLibrary] DB 업그레이드가 다른 탭에 막혀 있습니다. 다른 탭을 닫아 주세요."
        );
      };
    });

    return dbPromise;
  }

  function runTransaction(storeNames, mode, handler) {
    return openDatabase().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeNames, mode);
          let result;

          try {
            result = handler(tx);
          } catch (err) {
            reject(err);
            return;
          }

          tx.oncomplete = () => {
            resolve(result);
          };

          tx.onerror = () => {
            reject(tx.error || new Error("IndexedDB 트랜잭션 오류"));
          };

          tx.onabort = () => {
            reject(tx.error || new Error("IndexedDB 트랜잭션이 취소되었습니다."));
          };
        })
    );
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error || new Error("IndexedDB 요청 오류"));
      };
    });
  }

  function normalizeVisibility(visibility) {
    if (!visibility || typeof visibility !== "object") {
      return {};
    }
    const out = {};
    Object.keys(visibility).forEach((key) => {
      out[key] = visibility[key] !== false;
    });
    return out;
  }

  function isAudioBuffer(value) {
    return (
      value &&
      typeof value === "object" &&
      typeof value.getChannelData === "function" &&
      typeof value.sampleRate === "number"
    );
  }

  function isBlobLike(value) {
    return (
      value instanceof Blob ||
      (value && typeof value.size === "number" && typeof value.arrayBuffer === "function")
    );
  }

  /**
   * AudioBuffer → WAV Blob (스템 보관용, 16bit PCM)
   * @param {AudioBuffer} audioBuffer
   */
  function audioBufferToWavBlob(audioBuffer) {
    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const numFrames = audioBuffer.length;
    const bytesPerSample = 2;
    const blockAlign = numChannels * bytesPerSample;
    const dataSize = numFrames * blockAlign;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    function writeString(offset, text) {
      for (let i = 0; i < text.length; i += 1) {
        view.setUint8(offset + i, text.charCodeAt(i));
      }
    }

    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);

    const channels = [];
    for (let ch = 0; ch < numChannels; ch += 1) {
      channels.push(audioBuffer.getChannelData(ch));
    }

    let offset = 44;
    for (let i = 0; i < numFrames; i += 1) {
      for (let ch = 0; ch < numChannels; ch += 1) {
        const sample = Math.max(-1, Math.min(1, channels[ch][i] || 0));
        const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
        view.setInt16(offset, int16, true);
        offset += 2;
      }
    }

    return new Blob([buffer], { type: "audio/wav" });
  }

  /**
   * @param {Record<string, Blob|AudioBuffer>} stemsInput
   * @returns {Promise<Record<string, Blob>>}
   */
  async function normalizeStemBlobs(stemsInput) {
    if (!stemsInput || typeof stemsInput !== "object") {
      return {};
    }

    const out = {};
    const ids = Object.keys(stemsInput);

    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const value = stemsInput[id];
      if (!value) {
        continue;
      }
      if (isAudioBuffer(value)) {
        out[id] = audioBufferToWavBlob(value);
        continue;
      }
      if (isBlobLike(value)) {
        out[id] = value instanceof Blob ? value : new Blob([value]);
        continue;
      }
      throw new Error(`스템 "${id}" 형식이 올바르지 않습니다. (Blob 또는 AudioBuffer)`);
    }

    return out;
  }

  async function decodeWavBlobToAudioBuffer(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
      throw new Error("AudioContext를 사용할 수 없어 스템을 복원하지 못했습니다.");
    }
    const ctx = new AudioContextClass();
    try {
      return await ctx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      await ctx.close();
    }
  }

  /**
   * @param {Record<string, Blob>} stemBlobs
   * @returns {Promise<Record<string, AudioBuffer>>}
   */
  async function decodeStemBlobs(stemBlobs) {
    if (!stemBlobs) {
      return {};
    }
    const out = {};
    const ids = Object.keys(stemBlobs);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const blob = stemBlobs[id];
      if (!blob) {
        continue;
      }
      out[id] = await decodeWavBlobToAudioBuffer(blob);
    }
    return out;
  }

  function validateSaveInput(input) {
    if (!input || typeof input !== "object") {
      throw new Error("saveProject()에는 프로젝트 객체가 필요합니다.");
    }
    if (!isBlobLike(input.audioBlob)) {
      throw new Error("audioBlob(MP3 Blob 또는 File)이 필요합니다.");
    }
    if (!input.fileName || typeof input.fileName !== "string") {
      throw new Error("fileName(문자열)이 필요합니다.");
    }
    if (!Number.isFinite(input.durationSec) || input.durationSec < 0) {
      throw new Error("durationSec(초 단위 숫자)이 필요합니다.");
    }
    if (typeof input.hasStemSeparation !== "boolean") {
      throw new Error("hasStemSeparation(boolean)이 필요합니다.");
    }
    if (typeof input.splitMode !== "boolean") {
      throw new Error("splitMode(boolean)이 필요합니다.");
    }
    if (!input.instrumentVisibility || typeof input.instrumentVisibility !== "object") {
      throw new Error("instrumentVisibility(객체)가 필요합니다.");
    }
  }

  /**
   * 스템 포함 저장 시 예상 용량(바이트)
   * @returns {Promise<number>}
   */
  async function estimateStemBytes(stemsInput) {
    if (!stemsInput || typeof stemsInput !== "object") {
      return 0;
    }
    const blobs = await normalizeStemBlobs(stemsInput);
    return Object.keys(blobs).reduce((sum, key) => {
      const blob = blobs[key];
      return sum + (blob && blob.size ? blob.size : 0);
    }, 0);
  }

  /**
   * 프로젝트 저장
   * @param {object} input
   * @param {Blob|File} input.audioBlob
   * @param {string} input.fileName
   * @param {number} input.durationSec
   * @param {boolean} input.hasStemSeparation
   * @param {boolean} input.splitMode
   * @param {Record<string, boolean>} input.instrumentVisibility
   * @param {Record<string, Blob|AudioBuffer>} [input.stems]
   * @param {boolean} [input.includeStems]
   * @param {number} [input.currentTimeSec]
   * @param {boolean} [input.wasPlaying]
   * @param {string} [input.themeId]
   * @param {'light'|'dark'} [input.colorMode]
   * @returns {Promise<{ id: string }>}
   */
  async function saveProject(input) {
    validateSaveInput(input);

    const id = createId();
    const audioBlob =
      input.audioBlob instanceof Blob
        ? input.audioBlob
        : new Blob([input.audioBlob], { type: "audio/mpeg" });

    const shouldStoreStems =
      input.includeStems === true &&
      input.hasStemSeparation &&
      input.stems &&
      Object.keys(input.stems).length > 0;

    const stemBlobs = shouldStoreStems
      ? await normalizeStemBlobs(input.stems)
      : {};

    let totalStorageBytes = audioBlob.size;
    Object.keys(stemBlobs).forEach((key) => {
      const blob = stemBlobs[key];
      if (blob && blob.size) {
        totalStorageBytes += blob.size;
      }
    });

    const currentTimeSec =
      typeof input.currentTimeSec === "number" && input.currentTimeSec >= 0
        ? input.currentTimeSec
        : 0;

    const meta = {
      id,
      fileName: input.fileName,
      savedAt: new Date().toISOString(),
      durationSec: input.durationSec,
      fileSizeBytes: audioBlob.size,
      totalStorageBytes,
      hasStemSeparation: input.hasStemSeparation,
      stemsStored: shouldStoreStems && Object.keys(stemBlobs).length > 0,
      splitMode: input.splitMode,
      instrumentVisibility: normalizeVisibility(input.instrumentVisibility),
      currentTimeSec,
      wasPlaying: input.wasPlaying === true,
      themeId:
        typeof input.themeId === "string" ? input.themeId : "arcade-pop",
      colorMode: input.colorMode === "dark" ? "dark" : "light",
    };

    const files = {
      id,
      audioBlob,
      stemBlobs: meta.stemsStored ? stemBlobs : null,
    };

    await runTransaction([META_STORE, FILES_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).put(meta);
      tx.objectStore(FILES_STORE).put(files);
    });

    return { id };
  }

  /**
   * 메타데이터 목록 (Blob 제외 — 대용량 목록 조회용)
   * @returns {Promise<Array<object>>}
   */
  async function listProjects() {
    const rows = await runTransaction(META_STORE, "readonly", (tx) => {
      return requestToPromise(tx.objectStore(META_STORE).getAll());
    });

    if (!Array.isArray(rows)) {
      return [];
    }

    return rows
      .map((row) => ({
        id: row.id,
        fileName: row.fileName,
        savedAt: row.savedAt,
        durationSec: row.durationSec,
        fileSizeBytes: row.fileSizeBytes,
        totalStorageBytes: row.totalStorageBytes || row.fileSizeBytes,
        hasStemSeparation: row.hasStemSeparation,
        stemsStored: row.stemsStored === true,
        splitMode: row.splitMode,
        instrumentVisibility: { ...row.instrumentVisibility },
        currentTimeSec:
          typeof row.currentTimeSec === "number" ? row.currentTimeSec : 0,
        themeId: row.themeId || "arcade-pop",
        colorMode: row.colorMode === "dark" ? "dark" : "light",
      }))
      .sort((a, b) => {
        if (a.savedAt < b.savedAt) {
          return 1;
        }
        if (a.savedAt > b.savedAt) {
          return -1;
        }
        return 0;
      });
  }

  /**
   * 프로젝트 불러오기
   * @param {string} id
   * @param {{ decodeStems?: boolean }} [options]
   * @returns {Promise<object>}
   */
  async function loadProject(id, options) {
    if (!id || typeof id !== "string") {
      throw new Error("loadProject(id)에 프로젝트 id가 필요합니다.");
    }

    const decodeStems = !options || options.decodeStems !== false;

    const meta = await runTransaction(META_STORE, "readonly", (tx) => {
      return requestToPromise(tx.objectStore(META_STORE).get(id));
    });

    if (!meta) {
      throw new Error(`id "${id}" 프로젝트를 찾을 수 없습니다.`);
    }

    const files = await runTransaction(FILES_STORE, "readonly", (tx) => {
      return requestToPromise(tx.objectStore(FILES_STORE).get(id));
    });

    if (!files || !files.audioBlob) {
      throw new Error(`id "${id}" 오디오 데이터를 찾을 수 없습니다.`);
    }

    const audioBlob = files.audioBlob;
    const audioFile = new File([audioBlob], meta.fileName, {
      type: audioBlob.type || "audio/mpeg",
    });

    const result = {
      id: meta.id,
      fileName: meta.fileName,
      savedAt: meta.savedAt,
      durationSec: meta.durationSec,
      fileSizeBytes: meta.fileSizeBytes,
      hasStemSeparation: meta.hasStemSeparation,
      stemsStored: meta.stemsStored === true,
      splitMode: meta.splitMode,
      instrumentVisibility: { ...meta.instrumentVisibility },
      currentTimeSec:
        typeof meta.currentTimeSec === "number" ? meta.currentTimeSec : 0,
      wasPlaying: meta.wasPlaying === true,
      themeId: meta.themeId || "arcade-pop",
      colorMode: meta.colorMode === "dark" ? "dark" : "light",
      audioBlob,
      audioFile,
      stemBlobs: files.stemBlobs ? { ...files.stemBlobs } : null,
      stemBuffers: null,
    };

    if (
      decodeStems &&
      meta.stemsStored &&
      meta.hasStemSeparation &&
      files.stemBlobs
    ) {
      result.stemBuffers = await decodeStemBlobs(files.stemBlobs);
    }

    return result;
  }

  /**
   * 프로젝트 삭제
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function deleteProject(id) {
    if (!id || typeof id !== "string") {
      throw new Error("deleteProject(id)에 프로젝트 id가 필요합니다.");
    }

    const meta = await runTransaction(META_STORE, "readonly", (tx) => {
      return requestToPromise(tx.objectStore(META_STORE).get(id));
    });

    if (!meta) {
      throw new Error(`id "${id}" 프로젝트를 찾을 수 없습니다.`);
    }

    await runTransaction([META_STORE, FILES_STORE], "readwrite", (tx) => {
      tx.objectStore(META_STORE).delete(id);
      tx.objectStore(FILES_STORE).delete(id);
    });
  }

  /**
   * 현재 앱 상태를 모아 saveProject 입력 객체로 만듦 (편의 함수)
   * @param {Blob|File} audioBlob
   * @param {object} [extra]
   * @param {boolean} [extra.includeStems]
   * @param {number} [extra.currentTimeSec]
   * @param {boolean} [extra.wasPlaying]
   * @param {string} [extra.themeId]
   * @param {'light'|'dark'} [extra.colorMode]
   */
  function buildSavePayload(audioBlob, extra) {
    const opts = extra || {};
    let instrumentVisibility = opts.instrumentVisibility || {};

    if (
      !opts.instrumentVisibility &&
      window.AppUI &&
      typeof window.AppUI.getInstrumentVisibilityMap === "function"
    ) {
      instrumentVisibility = window.AppUI.getInstrumentVisibilityMap();
    } else if (!opts.instrumentVisibility && window.AppUI) {
      const list = window.STEM_INSTRUMENT_LIST || window.INSTRUMENT_LIST || [];
      list.forEach((inst) => {
        instrumentVisibility[inst.id] = window.AppUI.isInstrumentVisible(inst.id);
      });
    }

    const stems = {};
    if (window.AudioProcessor && window.AudioProcessor.isStemMode()) {
      const list = window.STEM_INSTRUMENT_LIST || [];
      list.forEach((inst) => {
        const buf = window.AudioProcessor.getStemBuffer(inst.id);
        if (buf) {
          stems[inst.id] = buf;
        }
      });
    }

    const audio = window.AudioEngine && window.AudioEngine.audio;
    const appearance =
      window.ThemeConfig && window.ThemeConfig.getAppearanceState
        ? window.ThemeConfig.getAppearanceState()
        : { themeId: "arcade-pop", colorMode: "light" };

    const hasStemSeparation =
      typeof opts.hasStemSeparation === "boolean"
        ? opts.hasStemSeparation
        : Boolean(window.AudioProcessor && window.AudioProcessor.isStemMode());

    const stemMap =
      Object.keys(stems).length > 0 ? stems : opts.stems || null;

    return {
      audioBlob,
      fileName: opts.fileName || (audioBlob && audioBlob.name) || "unknown.mp3",
      durationSec:
        typeof opts.durationSec === "number"
          ? opts.durationSec
          : audio && Number.isFinite(audio.duration)
            ? audio.duration
            : 0,
      hasStemSeparation,
      includeStems: opts.includeStems === true,
      splitMode:
        typeof opts.splitMode === "boolean"
          ? opts.splitMode
          : Boolean(window.AppUI && window.AppUI.isSplitMode()),
      instrumentVisibility,
      stems: stemMap,
      currentTimeSec:
        typeof opts.currentTimeSec === "number"
          ? opts.currentTimeSec
          : audio && Number.isFinite(audio.currentTime)
            ? audio.currentTime
            : 0,
      wasPlaying:
        typeof opts.wasPlaying === "boolean"
          ? opts.wasPlaying
          : Boolean(audio && !audio.paused && !audio.ended),
      themeId: opts.themeId || appearance.themeId,
      colorMode: opts.colorMode || appearance.colorMode,
    };
  }

  window.MusicLibrary = {
    isAvailable: isIndexedDbAvailable,
    saveProject,
    loadProject,
    deleteProject,
    listProjects,
    buildSavePayload,
    estimateStemBytes,
    audioBufferToWavBlob,
  };
})();
