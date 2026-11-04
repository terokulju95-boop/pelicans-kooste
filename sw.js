// Pelicans-kooste – service worker
// MUUTA VERSIO aina kun päivität index.html:ää tai muita sovellustiedostoja.
// Silloin sovellus kysyy "Päivitetäänkö?" ja ottaa uuden version käyttöön.
const VERSIO = '1';
const CACHE = 'pelicans-kooste-v' + VERSIO;
const TIEDOSTOT = [
  './',
  'index.html',
  'manifest.json',
  'kuvakkeet/icon-192.png',
  'kuvakkeet/icon-512.png',
  'kuvakkeet/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(TIEDOSTOT)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const avaimet = await caches.keys();
    await Promise.all(avaimet.filter((k) => k.startsWith('pelicans-kooste-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'PAIVITA') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase SDK -tiedostot (gstatic): välimuistista, jotta sovellus aukeaa nopeasti
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const osuma = await c.match(req);
      if (osuma) return osuma;
      const vastaus = await fetch(req);
      if (vastaus.ok) c.put(req, vastaus.clone());
      return vastaus;
    }));
    return;
  }

  // Omat tiedostot: välimuistista, muuten verkosta
  if (url.origin === self.location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((osuma) => osuma || fetch(req)));
  }
  // Kaikki muu (Firestore, kirjautuminen) menee suoraan verkkoon
});
