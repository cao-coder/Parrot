/**
 * 음악 보관함 — 우측 슬라이드 패널 UI (MusicLibrary 연동)
 */
(function initLibraryPanel() {
  const SORT_NEWEST = "newest";
  const SORT_OLDEST = "oldest";
  const SORT_NAME = "name";

  let isOpen = false;
  let allProjects = [];
  let sortMode = SORT_NEWEST;
  let searchQuery = "";
  let pendingDeleteId = null;
  let statusTimer = null;

  let tabBtn = null;
  let panelEl = null;
  let searchInput = null;
  let sortSelect = null;
  let listEl = null;
  let countEl = null;
  let storageEl = null;
  let statusEl = null;

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) {
      return "0:00";
    }
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function formatSavedDate(iso) {
    if (!iso) {
      return "";
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
      return "";
    }
    return date.toLocaleDateString("ko-KR", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return "0 B";
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function showStatus(message, type) {
    if (!statusEl) {
      return;
    }
    statusEl.textContent = message;
    statusEl.hidden = !message;
    statusEl.classList.remove("error", "warn", "info");
    if (message && type) {
      statusEl.classList.add(type);
    }
    if (statusTimer) {
      clearTimeout(statusTimer);
      statusTimer = null;
    }
    if (message) {
      statusTimer = setTimeout(() => {
        if (statusEl) {
          statusEl.hidden = true;
          statusEl.textContent = "";
        }
        statusTimer = null;
      }, 5000);
    }
  }

  function setOpen(open) {
    isOpen = open;
    if (!panelEl || !tabBtn) {
      return;
    }
    panelEl.classList.toggle("is-open", open);
    panelEl.setAttribute("aria-hidden", open ? "false" : "true");
    tabBtn.setAttribute("aria-expanded", open ? "true" : "false");
    document.body.classList.toggle("library-panel-open", open);
    if (open) {
      refreshList();
      if (searchInput) {
        searchInput.focus();
      }
    }
  }

  function handleTogglePanel() {
    setOpen(!isOpen);
  }

  function handleKeyDown(event) {
    if (event.key === "Escape" && isOpen) {
      setOpen(false);
    }
  }

  function getFilteredProjects() {
    const query = searchQuery.trim().toLowerCase();
    let rows = allProjects.slice();

    if (query) {
      rows = rows.filter((item) => {
        return item.fileName.toLowerCase().includes(query);
      });
    }

    if (sortMode === SORT_OLDEST) {
      rows.sort((a, b) => {
        if (a.savedAt < b.savedAt) {
          return -1;
        }
        if (a.savedAt > b.savedAt) {
          return 1;
        }
        return 0;
      });
    } else if (sortMode === SORT_NAME) {
      rows.sort((a, b) => {
        return a.fileName.localeCompare(b.fileName, "ko");
      });
    } else {
      rows.sort((a, b) => {
        if (a.savedAt < b.savedAt) {
          return 1;
        }
        if (a.savedAt > b.savedAt) {
          return -1;
        }
        return 0;
      });
    }

    return rows;
  }

  function updateFooter() {
    if (!countEl || !storageEl) {
      return;
    }
    const totalBytes = allProjects.reduce((sum, item) => {
      return sum + (item.totalStorageBytes || item.fileSizeBytes || 0);
    }, 0);
    countEl.textContent = `저장 ${allProjects.length}곡`;
    storageEl.textContent = `사용량 ${formatBytes(totalBytes)}`;
  }

  function renderList() {
    if (!listEl) {
      return;
    }

    const rows = getFilteredProjects();
    listEl.innerHTML = "";

    if (rows.length === 0) {
      const empty = document.createElement("li");
      empty.className = "library-panel-empty";
      empty.textContent = searchQuery.trim()
        ? "검색 결과가 없습니다."
        : "보관함이 비어 있습니다.";
      listEl.appendChild(empty);
      return;
    }

    rows.forEach((item) => {
      const li = document.createElement("li");
      li.className = "library-panel-item";
      li.setAttribute("data-project-id", item.id);

      const main = document.createElement("div");
      main.className = "library-panel-item-main";

      const title = document.createElement("span");
      title.className = "library-panel-item-title";
      title.textContent = item.fileName;
      title.title = item.fileName;

      const meta = document.createElement("span");
      meta.className = "library-panel-item-meta";
      const modeLabel = item.splitMode ? "Split" : "Combined";
      let stemLabel = "";
      if (item.hasStemSeparation && item.stemsStored) {
        stemLabel = " · 스템 저장됨";
      } else if (item.hasStemSeparation) {
        stemLabel = " · 스템(미저장)";
      }
      const timeLabel =
        typeof item.currentTimeSec === "number" && item.currentTimeSec > 0
          ? ` · ${formatDuration(item.currentTimeSec)} 지점`
          : "";
      meta.textContent = `${formatDuration(item.durationSec)} · ${formatSavedDate(item.savedAt)} · ${modeLabel}${stemLabel}${timeLabel}`;

      main.appendChild(title);
      main.appendChild(meta);

      const actions = document.createElement("div");
      actions.className = "library-panel-item-actions";

      const openBtn = document.createElement("button");
      openBtn.type = "button";
      openBtn.className = "library-panel-btn library-panel-btn--open";
      openBtn.textContent = "열기";
      openBtn.setAttribute("aria-label", `${item.fileName} 열기`);
      openBtn.addEventListener("click", () => {
        handleOpenProject(item.id);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "library-panel-btn library-panel-btn--delete";
      const isPending = pendingDeleteId === item.id;
      deleteBtn.textContent = isPending ? "확인" : "삭제";
      deleteBtn.setAttribute(
        "aria-label",
        isPending ? `${item.fileName} 삭제 확인` : `${item.fileName} 삭제`
      );
      deleteBtn.addEventListener("click", () => {
        handleDeleteProject(item.id);
      });

      actions.appendChild(openBtn);
      actions.appendChild(deleteBtn);

      if (isPending) {
        const confirmHint = document.createElement("span");
        confirmHint.className = "library-panel-delete-hint";
        confirmHint.textContent = "다시 누르면 삭제됩니다";
        actions.appendChild(confirmHint);
      }

      li.appendChild(main);
      li.appendChild(actions);
      listEl.appendChild(li);
    });
  }

  async function refreshList() {
    if (!window.MusicLibrary || !window.MusicLibrary.isAvailable()) {
      allProjects = [];
      updateFooter();
      renderList();
      showStatus("IndexedDB를 사용할 수 없습니다.", "error");
      return;
    }

    try {
      allProjects = await window.MusicLibrary.listProjects();
      pendingDeleteId = null;
      updateFooter();
      renderList();
    } catch (err) {
      console.error(err);
      showStatus(
        err && err.message ? err.message : "목록을 불러오지 못했습니다.",
        "error"
      );
    }
  }

  async function handleOpenProject(id) {
    if (!window.MusicLibrary || !window.AppMain) {
      showStatus("보관함 엔진이 준비되지 않았습니다.", "error");
      return;
    }

    if (!window.AppMain.canLoadFromLibrary()) {
      showStatus("녹화·저장·스템 분리 중에는 열 수 없습니다.", "warn");
      return;
    }

    showStatus("불러오는 중...", "info");

    try {
      const project = await window.MusicLibrary.loadProject(id);
      await window.AppMain.loadLibraryProject(project);
      showStatus(`"${project.fileName}"을(를) 열었습니다.`, "info");

      if (project.hasStemSeparation && !project.stemsStored) {
        showStatus(
          "스템 분리 화면 설정은 복원됐지만, 스템 데이터는 없습니다. Demucs를 다시 실행하세요.",
          "warn"
        );
      }
    } catch (err) {
      console.error(err);
      showStatus(err && err.message ? err.message : "열기에 실패했습니다.", "error");
    }
  }

  async function handleDeleteProject(id) {
    if (!window.MusicLibrary) {
      return;
    }

    if (pendingDeleteId !== id) {
      pendingDeleteId = id;
      renderList();
      return;
    }

    try {
      await window.MusicLibrary.deleteProject(id);
      pendingDeleteId = null;
      showStatus("삭제했습니다.", "info");
      await refreshList();
    } catch (err) {
      console.error(err);
      showStatus(err && err.message ? err.message : "삭제에 실패했습니다.", "error");
    }
  }

  function handleSearchInput() {
    if (!searchInput) {
      return;
    }
    searchQuery = searchInput.value;
    renderList();
  }

  function handleSortChange() {
    if (!sortSelect) {
      return;
    }
    sortMode = sortSelect.value;
    renderList();
  }

  function buildDom() {
    tabBtn = document.createElement("button");
    tabBtn.type = "button";
    tabBtn.id = "libraryPanelTab";
    tabBtn.className = "library-panel-tab";
    tabBtn.setAttribute("aria-controls", "libraryPanel");
    tabBtn.setAttribute("aria-expanded", "false");
    tabBtn.setAttribute("aria-label", "음악 보관함 열기");
    tabBtn.innerHTML = '<span class="library-panel-tab-icon" aria-hidden="true">📚</span><span class="library-panel-tab-label">보관함</span>';
    tabBtn.addEventListener("click", handleTogglePanel);

    panelEl = document.createElement("aside");
    panelEl.id = "libraryPanel";
    panelEl.className = "library-panel";
    panelEl.setAttribute("aria-hidden", "true");
    panelEl.setAttribute("aria-label", "음악 보관함");

    const header = document.createElement("header");
    header.className = "library-panel-header";

    const title = document.createElement("h2");
    title.className = "library-panel-title";
    title.textContent = "음악 보관함";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "library-panel-close";
    closeBtn.setAttribute("aria-label", "보관함 닫기");
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => {
      setOpen(false);
    });

    header.appendChild(title);
    header.appendChild(closeBtn);

    const toolbar = document.createElement("div");
    toolbar.className = "library-panel-toolbar";

    searchInput = document.createElement("input");
    searchInput.type = "search";
    searchInput.className = "library-panel-search";
    searchInput.placeholder = "곡 이름 검색";
    searchInput.setAttribute("aria-label", "곡 이름 검색");
    searchInput.addEventListener("input", handleSearchInput);

    sortSelect = document.createElement("select");
    sortSelect.className = "library-panel-sort";
    sortSelect.setAttribute("aria-label", "정렬");
    [
      { value: SORT_NEWEST, label: "최신순" },
      { value: SORT_OLDEST, label: "오래된순" },
      { value: SORT_NAME, label: "파일명순" },
    ].forEach((opt) => {
      const option = document.createElement("option");
      option.value = opt.value;
      option.textContent = opt.label;
      sortSelect.appendChild(option);
    });
    sortSelect.addEventListener("change", handleSortChange);

    toolbar.appendChild(searchInput);
    toolbar.appendChild(sortSelect);

    listEl = document.createElement("ul");
    listEl.className = "library-panel-list";
    listEl.setAttribute("role", "list");

    statusEl = document.createElement("p");
    statusEl.className = "library-panel-status";
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    statusEl.hidden = true;

    const footer = document.createElement("footer");
    footer.className = "library-panel-footer";

    countEl = document.createElement("span");
    countEl.className = "library-panel-count";

    storageEl = document.createElement("span");
    storageEl.className = "library-panel-storage";

    footer.appendChild(countEl);
    footer.appendChild(storageEl);

    panelEl.appendChild(header);
    panelEl.appendChild(toolbar);
    panelEl.appendChild(listEl);
    panelEl.appendChild(statusEl);
    panelEl.appendChild(footer);

    document.body.appendChild(panelEl);
    document.body.appendChild(tabBtn);

    document.addEventListener("keydown", handleKeyDown);
  }

  function init() {
    if (!window.MusicLibrary) {
      console.warn("[LibraryPanel] MusicLibrary가 없어 패널을 만들지 않습니다.");
      return;
    }
    buildDom();
    updateFooter();
    renderList();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.LibraryPanel = {
    open() {
      setOpen(true);
    },
    close() {
      setOpen(false);
    },
    toggle() {
      handleTogglePanel();
    },
    refresh: refreshList,
  };
})();
