// EU연합 통합시스템 - Service Worker
// 같은 출처 자산은 stale-while-revalidate, HTML 은 network-first (3초 타임아웃).
// 외부 도메인 (Apps Script, jsdelivr 등) 은 통과 (캐시하지 않음).

// CACHE_NAME 은 빌드 버전(?v=N) 과 동기화 — activate 에서 옛 캐시 통째 삭제.
const CACHE_NAME = "eubaram-static-v41";

const PRECACHE = [
  "./",
  "./index.html",
  "./siege.html",
  "./admin.html",
  "./styles.css?v=41",
  "./landing.css?v=41",
  "./admin.css?v=41",
  "./shared.js?v=41",
  "./app.js?v=41",
  "./landing.js?v=41",
  "./admin.js?v=41",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-maskable.svg",
];

const HTML_TIMEOUT_MS = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // best-effort: 일부 자산이 404 라도 install 은 성공해야 함
    await Promise.allSettled(PRECACHE.map((u) => cache.add(u).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

function isHtmlRequest(req, url) {
  if (req.mode === "navigate") return true;
  if (url.pathname.endsWith(".html") || url.pathname === "/" || url.pathname.endsWith("/")) return true;
  const accept = req.headers.get("accept") || "";
  return accept.includes("text/html");
}

// 타임아웃 fetch — 느린 네트워크에서 캐시 폴백 가속
function fetchWithTimeout(req, ms) {
  return new Promise((resolve, reject) => {
    const ctrl = new AbortController();
    const tid = setTimeout(() => { ctrl.abort(); reject(new Error("timeout")); }, ms);
    fetch(req, { signal: ctrl.signal })
      .then((res) => { clearTimeout(tid); resolve(res); })
      .catch((err) => { clearTimeout(tid); reject(err); });
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // 같은 출처만 가로채기 (Apps Script, CDN, Tesseract 등 외부는 통과)
  if (url.origin !== self.location.origin) return;

  // HTML 은 network-first (콘텐츠 변경 즉시 반영) + 3초 타임아웃
  if (isHtmlRequest(req, url)) {
    e.respondWith((async () => {
      try {
        const fresh = await fetchWithTimeout(req, HTML_TIMEOUT_MS);
        if (fresh && fresh.ok) {
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, fresh.clone());
        }
        return fresh;
      } catch {
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(req);
        return cached || new Response("offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      }
    })());
    return;
  }

  // 정적 자산 (.css, .js, .svg, 이미지 등): stale-while-revalidate
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then((res) => {
      if (res && res.ok && res.type === "basic") {
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);
    return cached || (await fetchPromise) || new Response("offline", { status: 503 });
  })());
});
