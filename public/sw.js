/* SMARTTEP ACADEMY V68 service worker. Public static assets only; never cache API or authenticated pages. */
const CACHE_NAME = 'smarttep-public-static-v68';
const PRECACHE = [
  '/offline.html',
  '/manifest.webmanifest',
  '/css/style.css',
  '/js/data-saver.js',
  '/images/smarttep-academy-logo.png'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('smarttep-public-static-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never cache authenticated pages, API responses, uploads, exams, payments or user data.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/') || url.pathname.startsWith('/auth') || url.pathname.includes('logout')) return;
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/offline.html')) || new Response('You are offline. Reconnect and try again.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } })));
    return;
  }
  const isPublicStatic = /\.(?:css|js|png|jpg|jpeg|webp|svg|woff2?|ttf|ico|webmanifest)$/i.test(url.pathname);
  if (!isPublicStatic) return;
  event.respondWith(caches.match(req).then(cached => {
    const network = fetch(req).then(response => {
      if (response && response.ok && response.type === 'basic') {
        const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return response;
    });
    return cached || network;
  }).catch(() => caches.match('/offline.html')));
});
/* Existing Web Push functionality retained. */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'SMARTTEP ACADEMY';
  const options = { body: data.body || 'You have a new SMARTTEP ACADEMY notification.', icon: data.icon || '/images/smarttep-academy-logo.png', badge: data.badge || '/images/smarttep-academy-logo.png', image: data.image || undefined, tag: data.tag || 'smarttep-notification', renotify: true, data: { url: data.url || '/' } };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) { if ('focus' in client) { try { await client.navigate(url); } catch (_) {} return client.focus(); } }
    return self.clients.openWindow(url);
  })());
});
