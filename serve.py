#!/usr/bin/env python3
"""
정적 파일 서버 + COOP/COEP 헤더 + ONNX Runtime 로컬 벤더링

- SharedArrayBuffer + 멀티스레드 WASM을 쓰려면 crossOriginIsolated === true 가 필요합니다.
- 거기에 추가로, ORT 는 WASM 스레드를 굴리려고 "ort.bundle.min.mjs" 를 Worker 로 띄웁니다.
- 그런데 Worker 생성자는 cross-origin URL 을 절대 받지 않아요. (COEP 와 무관한 별도 규칙)
- 그래서 ORT 파일들은 반드시 same-origin 으로 서빙해야 합니다.
- 이 스크립트는 처음 실행될 때 jsdelivr 에서 ORT 파일을 받아 vendor/ort/ 에 저장합니다.

사용법 (프로젝트 폴더에서):
  python serve.py

브라우저에서 http://127.0.0.1:5500/ 로 열고, DevTools 콘솔에
  crossOriginIsolated
를 입력하면 true 가 나와야 합니다.
"""

from __future__ import annotations

import http.server
import os
import socketserver
import sys
import urllib.request

PORT = int(os.environ.get("PORT", "5500"))
DIRECTORY = os.path.dirname(os.path.abspath(__file__))

ORT_VERSION = "1.20.1"
ORT_CDN_BASE = f"https://cdn.jsdelivr.net/npm/onnxruntime-web@{ORT_VERSION}/dist/"
ORT_VENDOR_DIR = os.path.join(DIRECTORY, "vendor", "ort")
ORT_FILES = [
    # WASM 전용 번들 (Demucs 품질 우선 — WebGPU 시도 없음)
    "ort.bundle.min.mjs",
    # 멀티스레드 WASM 글루 + 바이너리
    "ort-wasm-simd-threaded.jsep.mjs",
    "ort-wasm-simd-threaded.jsep.wasm",
    "ort-wasm-simd-threaded.mjs",
    "ort-wasm-simd-threaded.wasm",
]


def ensure_ort_local() -> None:
    """ORT 파일이 없으면 CDN 에서 받아 vendor/ort/ 에 저장합니다."""
    os.makedirs(ORT_VENDOR_DIR, exist_ok=True)
    missing = [
        f for f in ORT_FILES
        if not (os.path.exists(os.path.join(ORT_VENDOR_DIR, f))
                and os.path.getsize(os.path.join(ORT_VENDOR_DIR, f)) > 0)
    ]
    if not missing:
        print(f"[serve.py] ORT 벤더 파일 OK: {ORT_VENDOR_DIR}")
        return

    print(f"[serve.py] ORT {ORT_VERSION} 파일을 받습니다 → {ORT_VENDOR_DIR}")
    for fname in missing:
        url = ORT_CDN_BASE + fname
        local = os.path.join(ORT_VENDOR_DIR, fname)
        try:
            print(f"[serve.py]   ↓ {fname} ...", end="", flush=True)
            with urllib.request.urlopen(url, timeout=120) as resp:
                data = resp.read()
            with open(local, "wb") as out:
                out.write(data)
            mb = len(data) / (1024 * 1024)
            print(f" {mb:.1f} MB OK")
        except Exception as exc:
            print(f" FAILED: {exc}")
            print(f"[serve.py]   수동으로 받아 두 파일 위치에 넣어도 됩니다.")
            print(f"[serve.py]   from: {url}")
            print(f"[serve.py]   to:   {local}")


class ReusableTCPServer(socketserver.TCPServer):
    allow_reuse_address = True


class CoopCoepHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "credentialless")
        super().end_headers()


def main() -> None:
    ensure_ort_local()

    try:
        httpd = ReusableTCPServer(("", PORT), CoopCoepHandler)
    except OSError as exc:
        if getattr(exc, "winerror", None) == 10048 or exc.errno == 98:
            print(
                f"포트 {PORT} 은(는) 이미 다른 프로그램이 사용 중입니다.\n"
                "· 다른 터미널에서 돌아가는 python serve.py 를 Ctrl+C 로 끄거나,\n"
                "· 다른 포트로 실행: PowerShell 에서 $env:PORT=5501; python serve.py",
                file=sys.stderr,
            )
        raise SystemExit(1) from exc

    with httpd:
        print(f"Serving {DIRECTORY}")
        print(f"Open: http://127.0.0.1:{PORT}/")
        print("Headers: COOP=same-origin, COEP=credentialless (멀티스레드 WASM 활성화용)")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
