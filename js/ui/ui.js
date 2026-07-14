/**
 * 레이아웃 모드(한 캔버스 / 분할) + 악기별 표시 토글
 */
(function initAppUI() {
  const modeToggle = document.getElementById("modeToggle");
  const combinedWrap = document.getElementById("combinedWrap");
  const splitWrap = document.getElementById("splitWrap");
  const togglesHost = document.getElementById("instrumentToggles");

  let splitMode = false;
  const visibility = {};
  const MIN_VISIBLE_HINT_MS = 10000;
  let minVisibleHintTimer = null;

  function clearVisibility() {
    Object.keys(visibility).forEach((k) => {
      delete visibility[k];
    });
  }

  function seedVisibility(list) {
    clearVisibility();
    if (!list) {
      return;
    }
    list.forEach((inst) => {
      visibility[inst.id] = true;
    });
  }

  function emitRedraw() {
    window.dispatchEvent(new CustomEvent("viz-needs-redraw"));
  }

  function countVisibleInstruments() {
    return Object.keys(visibility).filter((id) => visibility[id] !== false).length;
  }

  function clearMinVisibleHintTimer() {
    if (minVisibleHintTimer === null) {
      return;
    }
    clearTimeout(minVisibleHintTimer);
    minVisibleHintTimer = null;
  }

  function hideMinVisibleHint() {
    const hint = document.getElementById("instToggleMinHint");
    if (!hint) {
      return;
    }
    hint.hidden = true;
    hint.classList.remove("is-visible");
  }

  /** Other 체크박스 오른쪽에 최소 1개 표시 안내 (10초) */
  function showMinVisibleHint() {
    if (!togglesHost) {
      return;
    }

    let hint = document.getElementById("instToggleMinHint");
    if (!hint) {
      hint = document.createElement("span");
      hint.id = "instToggleMinHint";
      hint.className = "inst-toggle-hint";
      hint.setAttribute("role", "status");
      hint.setAttribute("aria-live", "polite");
      hint.textContent = "최소 1개의 악기가 표시되어야 합니다";
      hint.hidden = true;

      const otherToggle = togglesHost.querySelector(
        '.inst-toggle[data-instrument-id="other"]'
      );
      if (otherToggle) {
        otherToggle.insertAdjacentElement("afterend", hint);
      } else {
        togglesHost.appendChild(hint);
      }
    }

    hint.hidden = false;
    hint.classList.add("is-visible");

    clearMinVisibleHintTimer();
    minVisibleHintTimer = setTimeout(() => {
      hideMinVisibleHint();
      minVisibleHintTimer = null;
    }, MIN_VISIBLE_HINT_MS);
  }

  /** 체크박스 상태에 맞춰 분할 모드 네모 슬롯 표시/숨김 */
  function syncInstrumentSlots() {
    const slots = document.querySelectorAll(
      "#splitGridInner .inst-slot[data-instrument-id]"
    );
    slots.forEach((slot) => {
      const id = slot.getAttribute("data-instrument-id");
      if (!id) {
        return;
      }
      const isVisible = visibility[id] !== false;
      slot.hidden = !isVisible;
      slot.style.display = isVisible ? "" : "none";
    });
    window.dispatchEvent(new Event("resize"));
  }

  function buildInstrumentTogglesFromList(list) {
    if (!togglesHost || !list) {
      return;
    }
    clearMinVisibleHintTimer();
    togglesHost.innerHTML = "";
    list.forEach((inst) => {
      const slotId = `inst-slot-${inst.id}`;
      const label = document.createElement("label");
      label.className = "inst-toggle";
      label.setAttribute("data-instrument-id", inst.id);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = visibility[inst.id] !== false;
      cb.setAttribute("data-instrument-id", inst.id);
      cb.setAttribute("aria-controls", slotId);
      cb.addEventListener("change", () => {
        if (!cb.checked) {
          const visibleCount = countVisibleInstruments();
          if (visibleCount === 1 && visibility[inst.id] !== false) {
            cb.checked = true;
            showMinVisibleHint();
            return;
          }
        }

        visibility[inst.id] = cb.checked;
        syncInstrumentSlots();
        emitRedraw();
      });
      label.appendChild(cb);
      label.appendChild(document.createTextNode(` ${inst.label}`));
      togglesHost.appendChild(label);
    });

    const hint = document.createElement("span");
    hint.id = "instToggleMinHint";
    hint.className = "inst-toggle-hint";
    hint.setAttribute("role", "status");
    hint.setAttribute("aria-live", "polite");
    hint.textContent = "최소 1개의 악기가 표시되어야 합니다";
    hint.hidden = true;

    const otherToggle = togglesHost.querySelector(
      '.inst-toggle[data-instrument-id="other"]'
    );
    if (otherToggle) {
      otherToggle.insertAdjacentElement("afterend", hint);
    } else {
      togglesHost.appendChild(hint);
    }
  }

  function syncModeUi() {
    if (modeToggle) {
      modeToggle.textContent = splitMode
        ? "Split Mode (분할 보기)"
        : "Combined Mode (한 캔버스)";
      modeToggle.setAttribute("aria-pressed", splitMode ? "true" : "false");
    }
    if (combinedWrap) {
      combinedWrap.hidden = splitMode;
    }
    if (splitWrap) {
      splitWrap.hidden = !splitMode;
    }
  }

  if (modeToggle) {
    modeToggle.addEventListener("click", () => {
      splitMode = !splitMode;
      syncModeUi();
      window.dispatchEvent(new Event("resize"));
      emitRedraw();
    });
  }

  seedVisibility(window.INSTRUMENT_LIST);
  buildInstrumentTogglesFromList(window.INSTRUMENT_LIST);
  syncInstrumentSlots();
  syncModeUi();

  window.AppUI = {
    isSplitMode() {
      return splitMode;
    },
    isInstrumentVisible(id) {
      return visibility[id] !== false;
    },
    rebuildForInstrumentList(list) {
      seedVisibility(list);
      buildInstrumentTogglesFromList(list);
      syncInstrumentSlots();
      emitRedraw();
    },
    syncInstrumentSlots,
    getInstrumentVisibilityMap() {
      const out = {};
      Object.keys(visibility).forEach((id) => {
        out[id] = visibility[id] !== false;
      });
      return out;
    },
    /**
     * 보관함 불러오기 후 Combined/Split·악기 표시 복원
     * @param {{ splitMode?: boolean, instrumentVisibility?: Record<string, boolean> }} state
     */
    setProjectViewState(state) {
      if (!state) {
        return;
      }
      if (typeof state.splitMode === "boolean" && state.splitMode !== splitMode) {
        splitMode = state.splitMode;
        syncModeUi();
      }
      if (state.instrumentVisibility) {
        Object.keys(state.instrumentVisibility).forEach((id) => {
          visibility[id] = state.instrumentVisibility[id] !== false;
        });
        if (togglesHost) {
          togglesHost.querySelectorAll("input[data-instrument-id]").forEach((cb) => {
            const id = cb.getAttribute("data-instrument-id");
            if (!id || !(id in state.instrumentVisibility)) {
              return;
            }
            cb.checked = state.instrumentVisibility[id] !== false;
          });
        }
      }
      syncInstrumentSlots();
      emitRedraw();
    },
  };
})();
