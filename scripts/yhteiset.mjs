// Pelicans-kooste – yhteiset apurit kaikille skripteille
// Ylläpitotiedot (lähteiden tila, virheet, Gemini-käyttö) tallennetaan dokumenttiin kooste/yllapito.
import { FieldValue } from 'firebase-admin/firestore';

// Päivämäärä Suomen ajassa muodossa 2026-11-04
export const paiva = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Helsinki' });

export const avain = (otsikko) => String(otsikko || '').toLowerCase().normalize('NFC')
  .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

// Gemini-kutsujen laskuri päivittäin
export async function kirjaaGemini(db, onnistui) {
  try {
    await db.doc('kooste/yllapito').set({
      gemini: { [paiva()]: { kutsut: FieldValue.increment(1), virheet: FieldValue.increment(onnistui ? 0 : 1) } },
    }, { merge: true });
  } catch (e) { console.warn('⚠ Gemini-laskuri:', e.message); }
}

// Viimeisimmät virheet (30 kpl) ylläpitonäkymää varten
export async function kirjaaVirheet(db, skripti, viestit) {
  if (!viestit.length) return;
  try {
    const ref = db.doc('kooste/yllapito');
    const vanhat = (await ref.get()).data()?.virheet || [];
    const uudet = viestit.map((v) => ({ aika: Date.now(), skripti, viesti: String(v).slice(0, 300) }));
    await ref.set({ virheet: [...uudet, ...vanhat].slice(0, 30) }, { merge: true });
  } catch (e) { console.warn('⚠ virheloki:', e.message); }
}

export async function kirjaaLahteet(db, lahteet) {
  try {
    await db.doc('kooste/yllapito').set({ lahteet, keraysAika: Date.now() }, { merge: true });
  } catch (e) { console.warn('⚠ lähteiden tila:', e.message); }
}

// Käyttäjän poistamat kohteet: { ids: [...], avaimet: [...] } (avaimet = siistityt otsikot)
export async function luePoistot(db) {
  const d = (await db.doc('yhteiset/poistot').get()).data() || {};
  return { ids: new Set(d.ids || []), avaimet: new Set(d.avaimet || []) };
}
export const onPoistettu = (poistot, k) => poistot.ids.has(k.id) || poistot.avaimet.has(avain(k.otsikko));
