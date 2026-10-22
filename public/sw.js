/* SMARTTEP ACADEMY Web Push Service Worker */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'SMARTTEP ACADEMY';
  const options = {
    body: data.body || 'You have a new SMARTTEP ACADEMY notification.',
    icon: data.icon || '/images/smarttep-academy-logo.png',
    badge: data.badge || '/images/smarttep-academy-logo.png',
    image: data.image || undefined,
    tag: data.tag || 'smarttep-notification',
    renotify: true,
    data: { url: data.url || '/' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification?.data?.url || '/';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if ('focus' in client) {
        try { await client.navigate(url); } catch (_) {}
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
