/* PIGEON EYE service worker: precache app shell + libraries + detector so the HUD works with no signal.
 * Other same-origin files (COCO-SSD fallback, YAMNet if enabled, PeerJS) are cached on first use. Nothing is sent anywhere. */
var V = 'pe-v1.0.2', RT = 'pe-runtime-v1';
var PRE = ['./', 'index.html', 'manifest.webmanifest', 'css/app.css', 'js/core.js', 'js/track.js', 'js/geo.js', 'js/squad.js', 'js/detectors.js', 'js/app.js', 'js/audio.js', 'js/audiologic.js',
  'vendor/jsQR.js', 'vendor/qrcode.js', 'vendor/tf.min.js', 'vendor/mp/vision_bundle.mjs', 'vendor/mp/wasm/vision_wasm_internal.js', 'vendor/mp/wasm/vision_wasm_internal.wasm',
  'models/effdet/efficientdet_lite0_float16.tflite', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'media/nosleep.mp4'];
self.addEventListener('install', function (e) { e.waitUntil(caches.open(V).then(function (c) { return c.addAll(PRE); }).then(function () { return self.skipWaiting(); })); });
self.addEventListener('activate', function (e) { e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== V && k !== RT; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); })); });
self.addEventListener('fetch', function (e) {
  var u = new URL(e.request.url); if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (e.request.headers.get('range')) return; // video range requests: let the network/HTTP cache handle
  // app shell/code: network-first (so a new deploy is picked up), cache fallback offline; big assets: cache-first
  if (e.request.mode === 'navigate' || /\/(js|css)\/|sw\.js|manifest/.test(u.pathname)) { e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(function (r) { if (r.ok) { var cp = r.clone(); caches.open(V).then(function (c) { c.put(e.request, cp); }); } return r; }).catch(function () { return caches.match(e.request, { ignoreSearch: true }).then(function (h) { return h || caches.match('index.html'); }); })); return; }
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
    if (hit) return hit;
    return fetch(e.request).then(function (r) { if (r.ok && r.status === 200) { var cp = r.clone(); caches.open(RT).then(function (c) { c.put(e.request, cp); }); } return r; })
      .catch(function () { return e.request.mode === 'navigate' ? caches.match('index.html') : Response.error(); });
  }));
});
self.addEventListener('message', function (e) {
  if (e.data !== 'status') return;
  caches.open(V).then(function (c) { return c.keys(); }).then(function (ks) { e.source.postMessage({ type: 'status', cached: ks.length, total: PRE.length, ready: ks.length >= PRE.length }); });
});
