// Pelicans-kooste – push-ilmoitukset (Firebase Cloud Messaging)
// Lähettää: 1) Pelicansin ottelun lopputuloksen, 2) isot uutiset (tekoälyn tärkeysarvio 4–5).
// Puhelimet ilmoittavat tunnuksensa sovelluksen asetuksista (kayttajat/{uid}/profiilit/{profiili}.ilmoitukset).

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { kirjaaVirheet, luePoistot, onPoistettu } from './yhteiset.mjs';

if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('Puuttuu FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const nyt = Date.now();
const H = 3600e3;
const SOVELLUS = process.env.SOVELLUS_URL || './';

// Vastaanottajat
const profiilit = (await db.collectionGroup('profiilit').get()).docs
  .map((d) => ({ ref: d.ref, ...(d.data().ilmoitukset || {}) }))
  .filter((p) => p.token);
if (!profiilit.length) { console.log('Ei ilmoituksia tilanneita laitteita.'); process.exit(0); }

const tilaRef = db.doc('kooste/ilmoitukset');
const tilaDoc = await tilaRef.get();
const [ottelut, kohteetDoc] = await Promise.all([db.doc('kooste/ottelut').get(), db.doc('kooste/kohteet').get()]);
const pelatut = (ottelut.data()?.pelatut || []).filter((o) => o.paattynyt);
const poistot = await luePoistot(db);
const kohteet = (kohteetDoc.data()?.kohteet || []).filter((k) => !onPoistettu(poistot, k));

// Ensimmäisellä kerralla merkitään nykyiset jo "ilmoitetuiksi", ettei tule vanhojen asioiden tulvaa
if (!tilaDoc.exists) {
  await tilaRef.set({ pelit: pelatut.map((o) => o.id), jutut: kohteet.map((k) => k.id) });
  console.log('Ilmoitusten seuranta aloitettu.');
  process.exit(0);
}
const tila = tilaDoc.data();
const ilmoitetutPelit = new Set(tila.pelit || []);
const ilmoitetutJutut = new Set(tila.jutut || []);

const viestit = [];
for (const o of pelatut) {
  if (ilmoitetutPelit.has(o.id) || o.aika < nyt - 24 * H) continue;
  const oma = o.kotona ? o.kotiMaalit : o.vierasMaalit, vast = o.kotona ? o.vierasMaalit : o.kotiMaalit;
  const lisa = /WINNING_SHOT/.test(o.ratkaisu || '') ? ' vl' : /EXTENDED/.test(o.ratkaisu || '') ? ' ja' : '';
  viestit.push({ laji: 'tulos', id: o.id, otsikko: oma > vast ? '🟢 Pelicans voitti!' : '🔴 Pelicans hävisi',
    teksti: `${o.koti} – ${o.vieras} ${o.kotiMaalit}–${o.vierasMaalit}${lisa}`, polku: '#ottelut' });
}
const isot = kohteet.filter((k) => (k.tarkeys || 0) >= 4 && !ilmoitetutJutut.has(k.id) && (k.lisatty || 0) > nyt - 6 * H)
  .sort((a, b) => b.tarkeys - a.tarkeys).slice(0, 3);
for (const k of isot) {
  viestit.push({ laji: 'iso', id: k.id, otsikko: '📣 ' + (k.asiaotsikko || k.otsikko), teksti: k.lahde, polku: `#u:${k.id}` });
}

let lahetetty = 0;
const virheet = [];
for (const v of viestit) {
  for (const p of profiilit) {
    if (v.laji === 'tulos' && p.tulos === false) continue;
    if (v.laji === 'iso' && p.isot === false) continue;
    try {
      await getMessaging().send({
        token: p.token,
        data: { otsikko: v.otsikko, teksti: v.teksti, url: SOVELLUS + v.polku, tag: `${v.laji}-${v.id}` },
        webpush: { headers: { Urgency: 'high', TTL: String(12 * 3600) } },
      });
      lahetetty++;
    } catch (e) {
      const koodi = e.errorInfo?.code || e.code || '';
      if (/registration-token-not-registered|invalid-registration-token|invalid-argument/.test(koodi)) {
        await p.ref.update({ 'ilmoitukset.token': FieldValue.delete() }).catch(() => {});
        console.log('Vanhentunut tunnus poistettu.');
      } else { virheet.push(`Ilmoitus: ${e.message}`); }
    }
  }
  (v.laji === 'tulos' ? ilmoitetutPelit : ilmoitetutJutut).add(v.id);
}
// Isoiksi luokittelemattomat uudet jutut merkitään käsitellyiksi vanhetessaan (pitää listan lyhyenä)
await tilaRef.set({ pelit: [...ilmoitetutPelit].slice(-200), jutut: [...ilmoitetutJutut].slice(-400) });
console.log(`Ilmoituksia lähetetty ${lahetetty} (${viestit.length} aihetta, ${profiilit.length} laitetta).`);
await kirjaaVirheet(db, 'ilmoitukset', virheet);
