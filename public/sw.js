/* 摸鱼计时排行榜 Service Worker — 网络优先，离线兜底
 * 重要：每次改前端代码（app.js/style.css/index.html）后，
 * 一定要把 CACHE 升一版（v1→v2），否则老用户浏览器里还是旧 sw.js 在代理 fetch，
 * install 阶段一次性 addAll 进去的 v1 缓存会一直兜底，导致新代码永远到不了。 */
const CACHE = 'moyu-v2';
const CORE = ['/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 跨域请求不拦截（如外部 API）
  // 网络优先：保证部署后拿到最新代码；断网时回退缓存
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
