// Pelicans-kooste – service worker
// Päivittyy automaattisesti: sovellustiedostot haetaan aina ensin verkosta,
// ja välimuistia käytetään vain, jos verkkoa ei ole. Uusi versio näkyy siis
// heti kun sovelluksen avaa, eikä sovellusta tarvitse asentaa uudelleen.
// VERSIO-numeroa ei tarvitse enää muuttaa joka kerta (sen muuttaminen tyhjentää välimuistin).
const VERSIO = '2';
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
  self.skipWaiting(); // uusi versio käyttöön heti, ei odotusta
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(TIEDOSTOT)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const avaimet = await caches.keys();
    await Promise.all(avaimet.filter((k) => k.startsWith('pelicans-kooste-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Vanhan version "Päivitä"-napin tuki
self.addEventListener('message', (e) => {
  if (e.data === 'PAIVITA') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Firebase SDK (versioitu osoite, ei muutu): välimuistista
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

  // Omat tiedostot: ensin verkosta (aina uusin versio), verkon puuttuessa välimuistista
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const vastaus = await fetch(req, { cache: 'no-cache' });
        if (vastaus.ok) c.put(req, vastaus.clone());
        return vastaus;
      } catch {
        return (await c.match(req, { ignoreSearch: true })) ||
               (req.mode === 'navigate' ? await c.match('index.html') : undefined) ||
               Response.error();
      }
    })());
  }
  // Kaikki muu (Firestore, kirjautuminen) menee suoraan verkkoon
});
