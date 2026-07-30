/* Cache-first shell so the board opens instantly and works offline.
 * Versioned URLs (?v=N) do the real invalidation — this cache is keyed on the
 * same version so bumping APP_VERSION retires the whole old cache. */
var VERSION = new URL(self.location).searchParams.get('v') || '1';
var CACHE = 'questlog-v' + VERSION;
var SHELL = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './css/styles.css?v=' + VERSION,
  './js/rules.js?v=' + VERSION,
  './js/parse.js?v=' + VERSION,
  './js/loot.js?v=' + VERSION,
  './js/reduce.js?v=' + VERSION,
  './js/store.js?v=' + VERSION,
  './js/sync.js?v=' + VERSION,
  './js/app.js?v=' + VERSION
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // never cache sync

  /* index.html is the ONE unversioned file, and it is what carries
   * APP_VERSION — serving it cache-first would mean a version bump could
   * never reach the browser. Network-first, falling back to cache offline. */
  var isShell = e.request.mode === 'navigate' ||
                url.pathname === '/' || /\/index\.html$/.test(url.pathname);

  if (isShell) {
    e.respondWith(
      fetch(e.request).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  /* Everything else is fetched with ?v=N, so cache-first is safe. */
  e.respondWith(caches.match(e.request).then(function (hit) {
    return hit || fetch(e.request);
  }));
});
