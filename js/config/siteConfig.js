/**
 * 사이트 공통 설정 — 배포 도메인·브랜딩
 * 배포 URL이 바뀌면 SITE_ORIGIN 만 수정하면 됩니다.
 */
(function initSiteConfig() {
  const SITE_ORIGIN = "https://soundcanvas.co.kr";
  const SITE_NAME = "사운드 캔버스";
  const SITE_TAGLINE = "MP3 웨이브폼 시각화 · AI 스템 분리";
  const SITE_DESCRIPTION =
    "MP3를 업로드해 실시간 웨이브폼으로 감상하고, Demucs AI로 vocals·bass·drums·other 스템을 분리해 보세요.";

  window.SiteConfig = {
    origin: SITE_ORIGIN,
    name: SITE_NAME,
    tagline: SITE_TAGLINE,
    description: SITE_DESCRIPTION,
    canonicalUrl: SITE_ORIGIN + "/",
    isProductionHost() {
      const host = window.location.hostname;
      return host === "soundcanvas.co.kr" || host === "www.soundcanvas.co.kr";
    },
  };
})();
