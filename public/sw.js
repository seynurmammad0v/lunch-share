// Service Worker — приём Web Push уведомлений
// Стратегия: сеть-вперёд. Страницы всегда берутся с сервера (свежая версия),
// кэш используется только как офлайн-фолбэк. Так PWA на главном экране не застревает на старой версии.
const CACHE_NAME = 'lunch-share-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting(); // активируем новый SW сразу, не дожидаясь закрытия вкладки
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) => Promise.all(keys.map((k) => k !== CACHE_NAME && caches.delete(k)))),
    ])
  );
});

// push-уведомления
self.addEventListener('push', (e) => {
  let data = { title: '🍱 Lunch share', body: '' };
  try {
    data = e.data.json();
  } catch {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon.png',
      badge: '/icon.png',
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(e.notification.data.url || '/');
    })
  );
});

// сеть-вперёд: навигация и статика всегда с сервера, кэш — только офлайн-фолбэк
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // страницы и API — только сеть (без кэша), чтобы всегда была свежая версия
  if (req.mode === 'navigate' || new URL(req.url).pathname.startsWith('/api/')) {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // статика: сеть-вперёд с кэш-фолбэком
  e.respondWith(
    fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(req))
  );
});
