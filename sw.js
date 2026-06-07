self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.hostname !== 'www.googleapis.com') return;
  if (!url.pathname.includes('/drive/v3/files/')) return;

  const token = url.searchParams.get('auth_token');
  if (!token) return;

  url.searchParams.delete('auth_token');

  const headers = new Headers();
  headers.set('Authorization', `Bearer ${token}`);

  // Forward Range header so seeking works
  const range = event.request.headers.get('Range');
  if (range) headers.set('Range', range);

  event.respondWith(fetch(url.toString(), { headers }));
});
