// Pelicans-kooste – Gemini-tiivistelmät (vaihe 4)
// Kirjoittaa "Päivän Pelicans" (vahvistetut uutiset) ja "Huhumylly" (huhut) -tiivistelmät
// vain sovelluksen itse keräämästä aineistosta. Ajetaan keräyksen jälkeen (keraa.yml).
// Tarvitsee salaisuudet FIREBASE_SERVICE_ACCOUNT ja GEMINI_API_KEY.

import { createHash } from 'node:crypto';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { kirjaaGemini, kirjaaVirheet, luePoistot, onPoistettu } from './yhteiset.mjs';

// ---------- Asetukset ----------
const VALI_TUNTEJA = 2;          // uusi tiivistelmä aikaisintaan näin monen tunnin päästä edellisestä
const AINEISTO_TUNTEJA = 48;     // tiivistelmään otetaan näin tuoreet kohteet
const MAX_UUTISIA = 30;
const MAX_KETJUJA = 5;
const OTTEITA_KETJUSTA = 6;      // keskusteluista vain lyhyitä otteita Pelicans-mainintojen ympäriltä
const MALLIT = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const UA = 'pelicans-kooste/1.0 (yksityinen sovellus)';
const PAKOTA = process.env.PAKOTA === 'true';

for (const s of ['FIREBASE_SERVICE_ACCOUNT', 'GEMINI_API_KEY']) {
  if (!process.env[s]) { console.error(`Puuttuu salaisuus ${s}`); process.exit(1); }
}
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

// ---------- Apurit ----------
const hajautus = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const pvm = (t) => new Date(t).toLocaleString('fi-FI', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

async function hae(url, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const puhdas = (html) => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/\s+/g, ' ').trim();

// Otteet Pelicans-mainintojen ympäriltä. Näitä EI tallenneta, ne menevät vain Geminin aineistoksi.
async function otteet(linkki) {
  const teksti = puhdas(await hae(linkki));
  const tulos = [];
  for (const m of teksti.matchAll(/pelicans/gi)) {
    const alku = Math.max(0, m.index - 220), loppu = Math.min(teksti.length, m.index + 220);
    tulos.push(teksti.slice(alku, loppu));
  }
  return tulos.slice(-OTTEITA_KETJUSTA); // uusimmat yleensä sivun lopussa
}

// ---------- Aineisto ----------
const [kohteetDoc, ketjutDoc, vanhaDoc] = await Promise.all([
  db.doc('kooste/kohteet').get(), db.doc('kooste/keskustelut').get(), db.doc('kooste/tiivistelma').get(),
]);
const nyt = Date.now();
const raja = nyt - AINEISTO_TUNTEJA * 3600e3;
const poistot = await luePoistot(db);
const uutiset = (kohteetDoc.data()?.kohteet || []).filter((k) => k.aika >= raja && !onPoistettu(poistot, k) && !k.eiRelevantti).slice(0, MAX_UUTISIA);
const ketjut = (ketjutDoc.data()?.ketjut || []).filter((k) => k.muuttunut >= raja && !poistot.ids.has(k.id)).slice(0, MAX_KETJUJA);
const vanha = vanhaDoc.data();

const tunnisteet = [...uutiset.map((u) => u.id), ...ketjut.map((k) => `${k.id}:${k.tila}`)];
const uusia = tunnisteet.filter((t) => !(vanha?.perustuu || []).includes(t));

if (!PAKOTA) {
  if (vanha && !uusia.length) { console.log('Ei uutta aineistoa, tiivistelmää ei tehdä.'); process.exit(0); }
  if (vanha && nyt - vanha.tehty < VALI_TUNTEJA * 3600e3) {
    console.log(`Edellinen tiivistelmä on alle ${VALI_TUNTEJA} h vanha, odotetaan.`); process.exit(0);
  }
}
if (!uutiset.length && !ketjut.length) {
  console.log('Aineistoa ei ole (48 h). Tallennetaan tieto niukasta aineistosta.');
}

// Numeroidaan lähteet [1], [2], … – sovellus muuttaa numerot linkeiksi
const lahteet = {};
let n = 0;
let aineisto = 'UUTISET (mediat ja seura – vahvistettua tietoa):\n';
for (const u of uutiset) {
  lahteet[++n] = { otsikko: u.otsikko, linkki: u.linkki, lahde: u.lahde };
  aineisto += `[${n}] ${pvm(u.aika)} · ${u.lahde} · "${u.otsikko}"${u.kuvaus ? ` – ${u.kuvaus}` : ''}\n`;
}
if (!uutiset.length) aineisto += '(ei uutisia viimeisen 48 tunnin ajalta)\n';

aineisto += '\nKESKUSTELUPALSTAT (huhuja ja mielipiteitä – EI vahvistettua tietoa):\n';
for (const k of ketjut) {
  lahteet[++n] = { otsikko: k.otsikko, linkki: k.linkki, lahde: k.lahde };
  let ot = [];
  try { ot = await otteet(k.linkki); } catch (e) { console.warn(`⚠ otteet ${k.linkki}: ${e.message}`); }
  aineisto += `[${n}] ${k.lahde} · ketju "${k.otsikko}" · uutta ${pvm(k.muuttunut)}\n`;
  for (const o of ot) aineisto += `   ote: "…${o}…"\n`;
}
if (!ketjut.length) aineisto += '(ei aktiivisia keskusteluja)\n';

// ---------- Gemini ----------
const OHJE = `Olet Lahden Pelicans -jääkiekkojoukkueen uutiskoosteen toimittaja. Kirjoitat suomeksi lyhyet tiivistelmät
VAIN alla annetusta aineistosta. Säännöt:
1. "uutiset": 3–6 virkettä Pelicansin tärkeimmistä vahvistetuista asioista (vain UUTISET-osion lähteistä). Tärkeimmät ja tuoreimmat ensin.
2. "huhut": 2–5 virkettä keskustelupalstojen puheenaiheista sekä medioiden vahvistamattomista tiedoista ("tietojen mukaan", "huhujen mukaan").
   Kirjoita huhut AINA huhuina: "Suomi24:ssä arvellaan…", "Keskustelijat kysyvät…", "IS:n tietojen mukaan…". Ei koskaan tosiasiana.
3. "kuumimmat_huhut": enintään 3 lyhyttä (alle 12 sanan) huhuotsikkoa, kukin lähdenumeroineen. Tyhjä lista, jos huhuja ei ole.
4. Merkitse JOKAISEN virkkeen loppuun lähteen numero hakasulkeissa, esim. [3] tai [2][5]. Käytä vain aineiston numeroita.
5. Älä lisää mitään, mitä aineistossa ei ole. Jos aineisto on niukka, sano se lyhyesti (esim. "Viime päivinä Pelicansista on uutisoitu vähän.").
6. Kirjoita omin sanoin, älä lainaa otsikoita tai viestejä sanatarkasti. Älä mainitse nimimerkkejä tai yksittäisiä keskustelijoita.
7. Jos aineistossa on myös muiden joukkueiden asioita, kerro vain siitä, mikä koskee Pelicansia.`;

const SKEEMA = {
  type: 'OBJECT',
  properties: {
    uutiset: { type: 'STRING' },
    huhut: { type: 'STRING' },
    kuumimmat_huhut: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { teksti: { type: 'STRING' }, lahteet: { type: 'ARRAY', items: { type: 'INTEGER' } } }, required: ['teksti', 'lahteet'] },
    },
  },
  required: ['uutiset', 'huhut', 'kuumimmat_huhut'],
};

async function kysyGemini(malli) {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${malli}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: OHJE }] },
      contents: [{ role: 'user', parts: [{ text: `Tänään on ${pvm(nyt)}.\n\n${aineisto}` }] }],
      generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SKEEMA },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${data?.error?.message || ''}`.trim());
  const teksti = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!teksti) throw new Error('tyhjä vastaus');
  const j = JSON.parse(teksti);
  if (typeof j.uutiset !== 'string' || typeof j.huhut !== 'string') throw new Error('väärä muoto');
  return j;
}

let tulos = null, kaytetty = null;
for (const malli of MALLIT) {
  try { tulos = await kysyGemini(malli); kaytetty = malli; await kirjaaGemini(db, true); break; }
  catch (e) { console.warn(`⚠ ${malli}: ${e.message}`); await kirjaaGemini(db, false); await kirjaaVirheet(db, 'päivän tiivistelmä', [`${malli}: ${e.message}`]); }
}
if (!tulos) {
  // Edellinen tiivistelmä jää näkyviin; ajo ei kaadu, jotta keräys jatkuu normaalisti
  console.warn('Gemini ei vastannut. Edellinen tiivistelmä jää voimaan.');
  process.exit(0);
}

// Poistetaan viittaukset numeroihin, joita ei ole aineistossa
const siivoa = (s) => s.replace(/\[(\d+)\]/g, (m, x) => (lahteet[x] ? m : '')).trim();
const huhuLista = (tulos.kuumimmat_huhut || []).slice(0, 3)
  .map((h) => ({ teksti: String(h.teksti || '').trim(), lahteet: (h.lahteet || []).filter((x) => lahteet[x]) }))
  .filter((h) => h.teksti);

await db.doc('kooste/tiivistelma').set({
  uutiset: siivoa(tulos.uutiset),
  huhut: siivoa(tulos.huhut),
  kuumimmatHuhut: huhuLista,
  lahteet,
  perustuu: tunnisteet,
  tehty: nyt,
  malli: kaytetty,
  tunniste: hajautus(aineisto),
});
console.log(`Tiivistelmä tallennettu (${kaytetty}, ${uutiset.length} uutista, ${ketjut.length} ketjua).`);
console.log('Päivän Pelicans:', siivoa(tulos.uutiset));
console.log('Huhumylly:', siivoa(tulos.huhut));
