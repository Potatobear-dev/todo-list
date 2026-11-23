/* 오프라인 셸 캐시 (네트워크 우선, 실패 시 캐시). Supabase API는 캐시하지 않음 */
const CACHE = 'todo-v7';
const SHELL = ['./', './index.html', './core.js', './app.js', './manifest.webmanifest', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.hostname.endsWith('supabase.co')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok && (u.origin === location.origin || u.hostname === 'cdn.jsdelivr.net')) {
        const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request))
  );
});
