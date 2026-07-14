/**
 * 사용법 가이드 — 클릭 시 전체 딤 + 호버 스포트라이트 + 설명 카드
 */
(function initUsageGuide() {
  /** @type {{ selector: string, title: string, text: string }[]} */
  const GUIDE_ITEMS = [
    {
      selector: ".usage-help",
      title: "사용법 가이드",
      text: "다른 기능 위에 마우스를 올려 설명을 확인하세요. 여기를 클릭하면 가이드를 닫습니다.",
    },
    {
      selector: ".file-label",
      title: "MP3 파일 선택",
      text: "로컬 MP3를 불러옵니다. 선택한 파일 이름이 옆에 표시되고, 재생·시각화·스템 분리의 시작점이 됩니다.",
    },
    {
      selector: "#playerBar",
      title: "재생 컨트롤",
      text: "재생·일시정지 버튼과 슬라이더로 원하는 구간으로 이동할 수 있습니다. MP3를 선택하면 활성화됩니다.",
    },
    {
      selector: "#modeToggle",
      title: "Combined / Split Mode",
      text: "Combined Mode는 한 캔버스에 파형을 겹쳐 보고, Split Mode는 Vocals·Bass·Drums·Other 네 슬롯으로 나눠 봅니다.",
    },
    {
      selector: "#themeToggle",
      title: "다크 · 라이트 모드",
      text: "화면 밝기를 전환합니다. 파형·버튼·배경 색이 함께 바뀝니다.",
    },
    {
      selector: "#themePicker",
      title: "컬러 테마",
      text: "아케이드 팝, 코지 로파이, 리듬 익스프레스 중 파형·UI 색 조합을 고릅니다.",
    },
    {
      selector: "#stemSeparateBtn",
      title: "AI 스템 분리 (Demucs)",
      text: "선택한 MP3를 vocals·bass·drums·other 네 스템으로 분리합니다. 첫 실행은 모델 로딩으로 시간이 걸릴 수 있습니다. HTTPS에서 사용하세요.",
    },
    {
      selector: "#recordBtn",
      title: "화면 녹화",
      text: "재생 중인 화면을 실시간으로 WebM에 담습니다. MP3를 선택하고 음악을 재생 중일 때 시작할 수 있습니다. 중지하면 파일이 저장되고 재생도 멈춥니다.",
    },
    {
      selector: ".export-quality-label",
      title: "WebM 품질",
      text: "빠름(720p 30fps), 기본(1080p 60fps), 고품질(1440p 60fps) 중 내보내기 해상도·프레임을 고릅니다.",
    },
    {
      selector: "#exportBtn",
      title: "WebM 저장",
      text: "곡 전체 길이의 시각화 영상을 자동으로 만들어 다운로드합니다. 현재 모드·테마·악기 표시·스템 분리 결과가 반영됩니다.",
    },
    {
      selector: ".library-save-mode-label",
      title: "보관함 저장 방식",
      text: "원본만 저장하거나, 스템 분리 결과까지 함께 저장할지 고릅니다.",
    },
    {
      selector: "#librarySaveBtn",
      title: "보관함에 저장",
      text: "현재 MP3·재생 위치·모드·악기 표시·테마·스템 상태를 IndexedDB에 저장합니다.",
    },
    {
      selector: "#combinedWrap",
      title: "Combined 캔버스",
      text: "한 화면에 선택한 악기 파형이 겹쳐 표시됩니다. 스템 분리 전에는 믹스 전체 파형을 봅니다.",
    },
    {
      selector: "#instrumentToggles",
      title: "악기 표시 토글",
      text: "Split Mode에서 표시할 악기를 체크박스로 고릅니다. 최소 1개는 켜 두어야 합니다.",
    },
    {
      selector: "#splitGridInner",
      title: "Split 악기 슬롯",
      text: "Vocals·Bass·Drums·Other 슬롯마다 해당 스템 파형이 표시됩니다. 스템 분리 후 각 악기를 따로 볼 수 있습니다.",
    },
    {
      selector: "#libraryPanelTab",
      title: "음악 보관함",
      text: "저장한 곡 목록을 엽니다. 열기로 이전 화면을 복원할 수 있고, 스템 포함 저장 시 Demucs 재실행 없이 파형이 돌아옵니다.",
    },
  ];

  const Z_INDEX_OVERLAY = 9000;
  const Z_INDEX_TARGET = 9001;
  const Z_INDEX_SPOTLIGHT = 9002;
  const Z_INDEX_CARD = 9003;
  const Z_INDEX_CHROME = 9010;

  let triggerBtn = null;
  let overlayEl = null;
  let cardEl = null;
  let cardTitleEl = null;
  let cardTextEl = null;
  let isOpen = false;
  /** @type {HTMLElement | null} */
  let activeTarget = null;
  /** @type {HTMLElement[]} */
  let boundTargets = [];
  /** @type {Map<HTMLElement, { title: string, text: string }>} */
  let targetGuideMap = new Map();

  function getOverlay() {
    if (overlayEl) {
      return overlayEl;
    }

    overlayEl = document.createElement("div");
    overlayEl.id = "usageGuideOverlay";
    overlayEl.className = "usage-guide-overlay";
    overlayEl.hidden = true;
    overlayEl.setAttribute("aria-hidden", "true");

    const banner = document.createElement("p");
    banner.className = "usage-guide-banner";
    banner.textContent = "궁금한 버튼이나 캔버스에 마우스를 올려 보세요.";

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "usage-guide-close";
    closeBtn.setAttribute("aria-label", "사용법 가이드 닫기");
    closeBtn.textContent = "닫기";
    closeBtn.addEventListener("click", handleCloseClick);

    overlayEl.appendChild(banner);
    overlayEl.appendChild(closeBtn);

    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function getCard() {
    if (cardEl) {
      return cardEl;
    }

    cardEl = document.createElement("aside");
    cardEl.id = "usageGuideCard";
    cardEl.className = "usage-guide-card";
    cardEl.hidden = true;
    cardEl.setAttribute("role", "status");
    cardEl.setAttribute("aria-live", "polite");

    cardTitleEl = document.createElement("h2");
    cardTitleEl.className = "usage-guide-card-title";

    cardTextEl = document.createElement("p");
    cardTextEl.className = "usage-guide-card-text";

    cardEl.appendChild(cardTitleEl);
    cardEl.appendChild(cardTextEl);
    document.body.appendChild(cardEl);
    return cardEl;
  }

  function collectTargets() {
    const found = [];

    GUIDE_ITEMS.forEach((item) => {
      const el = document.querySelector(item.selector);
      if (!el || !(el instanceof HTMLElement)) {
        return;
      }
      if (found.includes(el)) {
        return;
      }
      found.push(el);
    });

    return found;
  }

  function clearSpotlight() {
    if (activeTarget) {
      activeTarget.classList.remove("usage-guide-spotlight");
      activeTarget = null;
    }

    const card = getCard();
    card.hidden = true;
  }

  function positionGuideCard(targetEl) {
    const card = getCard();
    card.hidden = false;
    card.style.visibility = "hidden";
    card.style.top = "0px";
    card.style.left = "0px";

    const rect = targetEl.getBoundingClientRect();
    const cardWidth = card.offsetWidth;
    const cardHeight = card.offsetHeight;
    const margin = 12;
    const edge = 16;

    let top = rect.bottom + margin;
    if (top + cardHeight > window.innerHeight - edge) {
      top = rect.top - cardHeight - margin;
    }
    if (top < edge) {
      top = Math.min(rect.bottom + margin, window.innerHeight - cardHeight - edge);
    }

    let left = rect.left + rect.width / 2 - cardWidth / 2;
    if (left + cardWidth > window.innerWidth - edge) {
      left = window.innerWidth - cardWidth - edge;
    }
    if (left < edge) {
      left = edge;
    }

    card.style.top = `${Math.round(top)}px`;
    card.style.left = `${Math.round(left)}px`;
    card.style.visibility = "visible";
  }

  function showGuideForTarget(targetEl) {
    const item = targetGuideMap.get(targetEl);
    if (!item) {
      return;
    }

    if (activeTarget && activeTarget !== targetEl) {
      activeTarget.classList.remove("usage-guide-spotlight");
    }

    activeTarget = targetEl;
    targetEl.classList.add("usage-guide-spotlight");

    const card = getCard();
    cardTitleEl.textContent = item.title;
    cardTextEl.textContent = item.text;
    positionGuideCard(targetEl);
  }

  function handleTargetEnter(event) {
    if (!isOpen) {
      return;
    }

    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    showGuideForTarget(target);
  }

  function handleTargetLeave(event) {
    if (!isOpen) {
      return;
    }

    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (activeTarget !== target) {
      return;
    }

    const related = event.relatedTarget;
    if (related instanceof Node && target.contains(related)) {
      return;
    }

    clearSpotlight();
  }

  function handleTargetClick(event) {
    if (!isOpen) {
      return;
    }

    const target = event.currentTarget;
    if (!(target instanceof HTMLElement)) {
      return;
    }

    if (target.classList.contains("usage-help") || target.closest(".usage-help")) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  function bindTargets() {
    unbindTargets();
    targetGuideMap.clear();
    boundTargets = collectTargets();

    GUIDE_ITEMS.forEach((item) => {
      const el = document.querySelector(item.selector);
      if (!el || !(el instanceof HTMLElement)) {
        return;
      }
      targetGuideMap.set(el, { title: item.title, text: item.text });
    });

    boundTargets.forEach((el) => {
      el.classList.add("usage-guide-target");
      el.addEventListener("mouseenter", handleTargetEnter);
      el.addEventListener("mouseleave", handleTargetLeave);
      el.addEventListener("focusin", handleTargetEnter);
      el.addEventListener("focusout", handleTargetLeave);
      el.addEventListener("click", handleTargetClick, true);
    });
  }

  function unbindTargets() {
    targetGuideMap.clear();
    boundTargets.forEach((el) => {
      el.classList.remove("usage-guide-target");
      el.classList.remove("usage-guide-spotlight");
      el.removeEventListener("mouseenter", handleTargetEnter);
      el.removeEventListener("mouseleave", handleTargetLeave);
      el.removeEventListener("focusin", handleTargetEnter);
      el.removeEventListener("focusout", handleTargetLeave);
      el.removeEventListener("click", handleTargetClick, true);
    });
    boundTargets = [];
  }

  function setTriggerExpanded(expanded) {
    if (!triggerBtn) {
      return;
    }
    triggerBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    triggerBtn.classList.toggle("is-active", expanded);
  }

  function openGuide() {
    if (isOpen) {
      return;
    }

    isOpen = true;
    bindTargets();

    const overlay = getOverlay();
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");

    document.body.classList.add("usage-guide-active");
    setTriggerExpanded(true);
    document.addEventListener("click", handleDocumentClick, true);
  }

  function closeGuide() {
    if (!isOpen) {
      return;
    }

    isOpen = false;
    clearSpotlight();
    unbindTargets();

    const overlay = getOverlay();
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");

    document.body.classList.remove("usage-guide-active");
    setTriggerExpanded(false);
    document.removeEventListener("click", handleDocumentClick, true);
  }

  function handleTriggerClick() {
    if (isOpen) {
      closeGuide();
      return;
    }
    openGuide();
  }

  function handleCloseClick(event) {
    event.stopPropagation();
    closeGuide();
  }

  function handleDocumentClick(event) {
    if (!isOpen) {
      return;
    }

    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }

    if (target.closest(".usage-guide-close")) {
      return;
    }
    if (target.closest(".usage-help")) {
      return;
    }
    if (target.closest(".usage-guide-target")) {
      return;
    }

    closeGuide();
  }

  function handleKeyDown(event) {
    if (!isOpen) {
      return;
    }
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    closeGuide();
  }

  function handleResize() {
    if (!isOpen || !activeTarget) {
      return;
    }
    positionGuideCard(activeTarget);
  }

  function init() {
    triggerBtn = document.querySelector(".usage-help-trigger");
    if (!triggerBtn) {
      return;
    }

    getOverlay();
    getCard();

    triggerBtn.setAttribute("aria-controls", "usageGuideOverlay");
    triggerBtn.addEventListener("click", handleTriggerClick);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.UsageGuide = {
    open: openGuide,
    close: closeGuide,
    isOpen: () => isOpen,
    Z_INDEX_OVERLAY,
    Z_INDEX_TARGET,
    Z_INDEX_SPOTLIGHT,
    Z_INDEX_CARD,
    Z_INDEX_CHROME,
  };
})();
