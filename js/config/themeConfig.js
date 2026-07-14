/**
 * 테마별 컬러 팔레트 (라이트/다크 세트) + UI 적용
 */
(function initThemeConfig() {
  const STORAGE_KEY = "colorThemeId";

  const THEMES = [
    {
      id: "arcade-pop",
      name: "아케이드 팝",
      light: {
        background: "#F9F8F6",
        buttonPrimary: "#9A75F0",
        buttonSecondary: "#46CDA5",
        vocals: "#FF7675",
        bass: "#0984E3",
        drums: "#FDCB6E",
        other: "#00CEC9",
      },
      dark: {
        background: "#1E272E",
        buttonPrimary: "#A55EEA",
        buttonSecondary: "#0BEABC",
        vocals: "#FF6B6B",
        bass: "#74B9FF",
        drums: "#FFEAA7",
        other: "#81ECEC",
      },
    },
    {
      id: "cozy-lofi",
      name: "코지 로파이",
      light: {
        background: "#FDFBF7",
        buttonPrimary: "#A29BFE",
        buttonSecondary: "#FAB1A0",
        vocals: "#E84393",
        bass: "#6C5CE7",
        drums: "#E17055",
        other: "#55EFC4",
      },
      dark: {
        background: "#2D3436",
        buttonPrimary: "#817CFF",
        buttonSecondary: "#FF8A75",
        vocals: "#FD79A8",
        bass: "#9B8FFF",
        drums: "#FF9F43",
        other: "#00FFD1",
      },
    },
    {
      id: "rhythm-express",
      name: "리듬 익스프레스",
      light: {
        background: "#F0F4F8",
        buttonPrimary: "#00A8FF",
        buttonSecondary: "#FFDD57",
        vocals: "#FF4757",
        bass: "#574B90",
        drums: "#FFA502",
        other: "#70A1FF",
      },
      dark: {
        background: "#121212",
        buttonPrimary: "#00D2D3",
        buttonSecondary: "#FF007F",
        vocals: "#FF4757",
        bass: "#A55EEA",
        drums: "#FFB142",
        other: "#2ED573",
      },
    },
  ];

  let currentThemeId = THEMES[0].id;

  function isLightMode() {
    return document.body.classList.contains("theme-light");
  }

  function findTheme(id) {
    return THEMES.find((theme) => theme.id === id) || THEMES[0];
  }

  function clampChannel(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
  }

  /** 테두리·그림자용 — factor < 1 이면 어둡게 */
  function shadeHex(hex, factor) {
    const n = hex.replace("#", "");
    const r = clampChannel(parseInt(n.slice(0, 2), 16) * factor);
    const g = clampChannel(parseInt(n.slice(2, 4), 16) * factor);
    const b = clampChannel(parseInt(n.slice(4, 6), 16) * factor);
    return `#${r.toString(16).padStart(2, "0")}${g
      .toString(16)
      .padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
  }

  function getCurrentPalette() {
    const theme = findTheme(currentThemeId);
    return isLightMode() ? theme.light : theme.dark;
  }

  function getInstrumentColorFromPalette(palette, instrumentId) {
    if (!palette) {
      return "#2563eb";
    }
    const map = {
      vocals: palette.vocals,
      bass: palette.bass,
      drums: palette.drums,
      other: palette.other,
    };
    return map[instrumentId] || palette.vocals;
  }

  function applyCssVariables() {
    const palette = getCurrentPalette();
    const root = document.documentElement;
    const light = isLightMode();

    root.style.setProperty("--color-bg", palette.background);
    root.style.setProperty(
      "--color-mode-flood",
      findTheme(currentThemeId).dark.background
    );
    root.style.setProperty("--color-text", light ? "#2d3436" : "#f1f2f6");
    root.style.setProperty("--color-text-muted", light ? "#636e72" : "#b2bec3");
    root.style.setProperty("--color-surface", light ? "#ffffff" : "#2f3640");
    root.style.setProperty("--color-surface-border", light ? "#dfe6e9" : "#4a5568");
    root.style.setProperty("--color-canvas-bg", light ? "#ffffff" : "#0a0a0a");

    root.style.setProperty("--color-btn-primary", palette.buttonPrimary);
    root.style.setProperty(
      "--color-btn-primary-border",
      shadeHex(palette.buttonPrimary, 0.72)
    );
    root.style.setProperty(
      "--color-btn-primary-shadow",
      shadeHex(palette.buttonPrimary, 0.52)
    );
    root.style.setProperty("--color-btn-primary-text", light ? "#ffffff" : "#1a1a2e");

    root.style.setProperty("--color-btn-secondary", palette.buttonSecondary);
    root.style.setProperty(
      "--color-btn-secondary-border",
      shadeHex(palette.buttonSecondary, 0.72)
    );
    root.style.setProperty(
      "--color-btn-secondary-shadow",
      shadeHex(palette.buttonSecondary, 0.52)
    );
    root.style.setProperty("--color-btn-secondary-text", light ? "#2d3436" : "#1a1a2e");

    root.style.setProperty("--color-vocals", palette.vocals);
    root.style.setProperty("--color-bass", palette.bass);
    root.style.setProperty("--color-drums", palette.drums);
    root.style.setProperty("--color-other", palette.other);
    root.style.setProperty("--color-player-accent", palette.buttonPrimary);

    document.body.dataset.colorTheme = currentThemeId;
  }

  function updatePickerLabel() {
    const nameEl = document.querySelector(".theme-picker-name");
    if (!nameEl) {
      return;
    }
    nameEl.textContent = findTheme(currentThemeId).name;
  }

  function syncPickerOptions() {
    const menu = document.getElementById("themePickerMenu");
    if (!menu) {
      return;
    }
    menu.querySelectorAll("[data-theme-id]").forEach((item) => {
      const selected = item.getAttribute("data-theme-id") === currentThemeId;
      item.setAttribute("aria-selected", selected ? "true" : "false");
      item.classList.toggle("is-selected", selected);
    });
  }

  function closeThemePicker() {
    const picker = document.getElementById("themePicker");
    const trigger = document.getElementById("themePickerTrigger");
    const menu = document.getElementById("themePickerMenu");
    if (!picker || !trigger || !menu) {
      return;
    }
    picker.classList.remove("is-open");
    trigger.setAttribute("aria-expanded", "false");
    menu.setAttribute("aria-hidden", "true");
  }

  function openThemePicker() {
    const picker = document.getElementById("themePicker");
    const trigger = document.getElementById("themePickerTrigger");
    const menu = document.getElementById("themePickerMenu");
    if (!picker || !trigger || !menu) {
      return;
    }
    syncPickerOptions();
    picker.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    menu.setAttribute("aria-hidden", "false");
  }

  function toggleThemePicker() {
    const picker = document.getElementById("themePicker");
    if (!picker) {
      return;
    }
    if (picker.classList.contains("is-open")) {
      closeThemePicker();
      return;
    }
    openThemePicker();
  }

  function applyTheme(themeId) {
    if (!findTheme(themeId)) {
      return;
    }
    currentThemeId = themeId;
    try {
      localStorage.setItem(STORAGE_KEY, themeId);
    } catch (_err) {
      /* private browsing 등 */
    }
    applyCssVariables();
    updatePickerLabel();
    syncPickerOptions();
    window.dispatchEvent(new CustomEvent("theme-changed"));
  }

  function refreshForModeChange() {
    applyCssVariables();
    updatePickerLabel();
    window.dispatchEvent(new CustomEvent("theme-changed"));
  }

  function initThemePicker() {
    const picker = document.getElementById("themePicker");
    const trigger = document.getElementById("themePickerTrigger");
    const menu = document.getElementById("themePickerMenu");
    if (!picker || !trigger || !menu) {
      return;
    }

    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleThemePicker();
    });

    menu.addEventListener("click", (event) => {
      const item = event.target.closest("[data-theme-id]");
      if (!item) {
        return;
      }
      applyTheme(item.getAttribute("data-theme-id"));
      closeThemePicker();
    });

    document.addEventListener("click", (event) => {
      if (!picker.contains(event.target)) {
        closeThemePicker();
      }
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeThemePicker();
      }
    });
  }

  function loadSavedTheme() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && findTheme(saved)) {
        currentThemeId = saved;
      }
    } catch (_err) {
      /* ignore */
    }
  }

  loadSavedTheme();
  applyCssVariables();
  updatePickerLabel();
  initThemePicker();

  window.ThemeConfig = {
    THEMES,
    getCurrentThemeId() {
      return currentThemeId;
    },
    getCurrentThemeName() {
      return findTheme(currentThemeId).name;
    },
    getCanvasBackground() {
      return isLightMode() ? "#ffffff" : "#000000";
    },
    getInstrumentColor(instrumentId) {
      return getInstrumentColorFromPalette(getCurrentPalette(), instrumentId);
    },
    applyTheme,
    refreshForModeChange,
    getAppearanceState() {
      return {
        themeId: currentThemeId,
        colorMode: isLightMode() ? "light" : "dark",
      };
    },
    applyAppearanceState(state) {
      if (!state || typeof state !== "object") {
        return;
      }
      if (state.themeId && findTheme(state.themeId)) {
        currentThemeId = state.themeId;
      }
      if (state.colorMode === "dark") {
        document.body.classList.remove("theme-light");
        document.body.classList.add("theme-dark");
      } else if (state.colorMode === "light") {
        document.body.classList.remove("theme-dark");
        document.body.classList.add("theme-light");
      }
      applyCssVariables();
      updatePickerLabel();
      syncPickerOptions();
      window.dispatchEvent(new CustomEvent("theme-changed"));
    },
  };
})();
