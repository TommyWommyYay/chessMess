// Service worker: lets chessMess be installed as an app and played offline.
// The game's own files are fetched fresh whenever there is a connection (so an update shows up on
// the next launch) and kept in a cache for when there is not. Libraries from cdnjs (Stockfish, the
// MQTT client) have their version in their address, so once fetched their saved copy is used.
'use strict';

const CACHE = 'chessmess-v1';
const APP_FILES = [
  './', 'index.html', 'style.css', 'engine.js', 'fx.js', 'chaos.js', 'grandmasters.js', 'review.js',
  'online.js', 'pwa.js', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];
const LIBRARY_ORIGIN = 'https://cdnjs.cloudflare.com';
// On a slow connection, wait this long for the network before falling back to the saved copy.
const NETWORK_WAIT_MS = 3000;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(APP_FILES.map((file) => new Request(file, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) event.respondWith(networkFirst(request));
  else if (url.origin === LIBRARY_ORIGIN) event.respondWith(cacheFirst(request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  // An invite link (index.html?join=...) is the same page as index.html.
  const saved = () => cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  // "no-cache" checks with the server rather than trusting the browser's own short-term cache, so
  // a new version is picked up straight away. (A page navigation cannot be re-sent with options, so
  // it is fetched again by its address.)
  const fresh = fetch(request.mode === 'navigate' ? request.url : request, { cache: 'no-cache' }).then((response) => {
    if (response.ok) cache.put(request, response.clone());
    return response;
  });
  fresh.catch(() => {});    // (a failure is dealt with below; this just keeps it from being reported twice)
  const slow = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS)).then(saved);
  try {
    // Whichever comes first: the network, or (after a while) a saved copy; the network still
    // refreshes the cache in the background either way.
    return (await Promise.race([fresh, slow.then((copy) => copy || fresh)])) || (await fresh);
  } catch {
    const copy = await saved();
    if (copy) return copy;
    throw new Error('Offline, and ' + request.url + ' was never saved');
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const copy = await cache.match(request);
  if (copy) return copy;
  const response = await fetch(request);
  // Scripts loaded by a worker come back "opaque" (unreadable to us, but fine to save and replay).
  if (response.ok || response.type === 'opaque') cache.put(request, response.clone());
  return response;
}
