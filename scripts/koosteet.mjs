// Pelicans-kooste – tekoälykoosteet
//   kooste/koosteet: viikko (sunnuntaisin), ennakko (ennen ottelua), jalki (ottelun jälkeen: mitä mediat sanoivat), kolumnit
//   kooste/pelaajat: pelaajakohtaiset yhteenvedot (mitä pelaajasta on kirjoitettu viime aikoina)
// Kaikki koosteet tehdään vain sovelluksen itse keräämästä aineistosta.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { kirjaaGemini, kirjaaVirheet, luePoistot, onPoistettu } from './yhteiset.mjs';

const MALLIT = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
const PAKOTA = process.env.PAKOTA === 'true';
const MAX_PELAAJIA_AJOSSA = 3;
const VIRHEET = [];

for (const s of ['FIREBASE_SERVICE_ACCOUNT', 'GEMINI_API_KEY']) {
  if (!process.env[s]) { console.error(`Puuttuu salaisuus ${s}`); process.exit(1); }
}
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

const nyt = Date.now();
const H = 3600e3;
const pvm = (t) => new Date(t).toLocaleString('fi-FI', { timeZone: 'Europe/Helsinki', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const hki = (t = nyt) => {
  const o = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', weekday: 'short', hour: 'numeric', hour12: false })
    .formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  return { viikonpaiva: o.weekday, tunti: Number(o.hour) };
};
function viikkotunnus(t = nyt) {
  const d = new Date(new Date(t).toLocaleString('en-US', { timeZone: 'Europe/Helsinki' }));
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const vuosi = d.getFullYear();
  const eka = new Date(vuosi, 0, 4);
  return `${vuosi}-V${1 + Math.round(((d - eka) / 864e5 - 3 + ((eka.getDay() + 6) % 7)) / 7)}`;
}

const SKEEMA = {
  type: 'OBJECT',
  properties: { otsikko: { type: 'STRING' }, teksti: { type: 'STRING' }, pointit: { type: 'ARRAY', items: { type: 'STRING' } } },
  required: ['otsikko', 'teksti', 'pointit'],
};
const YHTEISET_SAANNOT = `Kirjoita suomeksi, omin sanoin, vain annetusta aineistosta. Älä keksi mitään. Huhut aina huhuina.
Älä mainitse keskustelupalstojen nimimerkkejä. "otsikko": lyhyt ja asiallinen. "pointit": 3–6 lyhyttä kohtaa.`;

let viimeKutsu = 0;
async function gemini(ohje, aineisto) {
  for (const malli of MALLIT) {
    const tauko = 4500 - (Date.now() - viimeKutsu);
    if (tauko > 0) await new Promise((r) => setTimeout(r, tauko));
    viimeKutsu = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${malli}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: `${ohje}\n\n${YHTEISET_SAANNOT}` }] },
          contents: [{ role: 'user', parts: [{ text: `Nyt on ${pvm(nyt)}.\n\n${aineisto}` }] }],
          generationConfig: { temperature: 0.3, responseMimeType: 'application/json', responseSchema: SKEEMA },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(`${r.status} ${data?.error?.message || ''}`);
      const j = JSON.parse(data.candidates[0].content.parts.map((p) => p.text || '').join(''));
      await kirjaaGemini(db, true);
      return { otsikko: String(j.otsikko || '').slice(0, 140), teksti: String(j.teksti || '').slice(0, 2000),
        pointit: (j.pointit || []).map(String).filter(Boolean).slice(0, 6).map((p) => p.slice(0, 220)), malli, tehty: Date.now() };
    } catch (e) {
      await kirjaaGemini(db, false);
      VIRHEET.push(`${malli}: ${e.message}`);
      console.warn(`  ⚠ ${malli}: ${e.message}`);
    }
  }
  return null;
}

// ---------- Aineisto ----------
const [kD, tD, oD, kkD, kosD, pelD] = await Promise.all(['kohteet', 'tilastot', 'ottelut', 'keskustelut', 'koosteet', 'pelaajat']
  .map((d) => db.doc(`kooste/${d}`).get()));
const poistot = await luePoistot(db);
const kohteet = (kD.data()?.kohteet || []).filter((k) => !onPoistettu(poistot, k) && !k.eiRelevantti);
const tilastot = tD.data() || {};
const ottelut = oD.data() || {};
const ketjut = (kkD.data()?.ketjut || []).filter((k) => !poistot.ids.has(k.id));
const koosteet = kosD.data() || {};
const pelaajaDoc = pelD.data()?.pelaajat || {};
const uudet = {};

const juttuRivi = (k) => `- ${pvm(k.aika)} · ${k.lahde}${k.luokka ? ` · ${k.luokka}` : ''} · "${k.otsikko}"${k.tiiv?.lyhyt ? ` – ${k.tiiv.lyhyt}` : k.kuvaus ? ` – ${k.kuvaus}` : ''}`;
const tulosTeksti = (o) => `${o.koti} – ${o.vieras} ${o.kotiMaalit}–${o.vierasMaalit}${/WINNING_SHOT/.test(o.ratkaisu || '') ? ' vl' : /EXTENDED/.test(o.ratkaisu || '') ? ' ja' : ''}`;
const taulukkoRivi = (j) => {
  const r = (ottelut.sarjataulukko || []).find((x) => x.joukkue === j);
  return r ? `${j}: sija ${r.sija}, ${r.pisteet} p / ${r.ottelut} ott., maalit ${r.maalit}` : `${j}: ei tietoa`;
};

// ---------- 1. Viikkokooste (sunnuntaisin klo 17 jälkeen) ----------
async function viikko() {
  const { viikonpaiva, tunti } = hki();
  const tunnus = viikkotunnus();
  if (!PAKOTA && (viikonpaiva !== 'Sun' || tunti < 17 || koosteet.viikko?.tunnus === tunnus)) return;
  const jutut = kohteet.filter((k) => k.aika > nyt - 7 * 24 * H).sort((a, b) => (b.tarkeys || 2) - (a.tarkeys || 2)).slice(0, 40);
  const pelit = (ottelut.pelatut || []).filter((o) => o.aika > nyt - 7 * 24 * H);
  const kaavio = tilastot.kaavio || [];
  const aineisto = `VIIKON OTTELUT:\n${pelit.map((o) => '- ' + tulosTeksti(o)).join('\n') || '- ei otteluita'}
SIJOITUS NYT: ${taulukkoRivi('Pelicans')}${kaavio.length > 3 ? ` (viikko sitten noin sija ${kaavio[Math.max(0, kaavio.length - 1 - pelit.length)]?.sija})` : ''}
VIIKON UUTISET (tärkeimmät ensin):\n${jutut.map(juttuRivi).join('\n') || '- ei uutisia'}
KESKUSTELUJEN AIHEET:\n${ketjut.filter((k) => k.muuttunut > nyt - 7 * 24 * H).map((k) => `- "${k.otsikko}"${k.tiiv?.lyhyt ? ` – ${k.tiiv.lyhyt}` : ''}`).join('\n') || '- ei'}`;
  const t = await gemini(`Kirjoitat Lahden Pelicansin viikkokoosteen faneille. "teksti": 5–8 virkettä viikon tärkeimmistä asioista: ottelut ja niiden merkitys, sarjatilanne, siirrot, loukkaantumiset ja puheenaiheet. "pointit": viikon tärkeimmät asiat lyhyesti.`, aineisto);
  if (t) { uudet.viikko = { ...t, tunnus, perustuu: jutut.map((k) => k.id) }; console.log('Viikkokooste tehty:', t.otsikko); }
}

// ---------- 2. Otteluennakko (alle 30 h ennen ottelua) ----------
async function ennakko() {
  const o = (ottelut.tulevat || [])[0];
  if (!o || o.aika < nyt || (!PAKOTA && o.aika - nyt > 30 * H) || koosteet.ennakko?.peliId === o.id) return;
  const vast = o.kotona ? o.vieras : o.koti;
  const st = ottelut.seuraavaTiedot?.id === o.id ? ottelut.seuraavaTiedot : {};
  const kp = (tilastot.kuntopuntari || []);
  const kpRivi = (j) => { const r = kp.find((x) => x.joukkue === j); return r ? `${j}: ${r.pisteet} p 10 viim. ottelusta (kuntopuntarin sija ${r.sija})` : ''; };
  const jutut = kohteet.filter((k) => k.aika > nyt - 4 * 24 * H).slice(0, 25);
  const aineisto = `OTTELU: ${o.koti} – ${o.vieras}, ${pvm(o.aika)}${o.halli ? ', ' + o.halli : ''}
SARJATILANNE:\n${taulukkoRivi('Pelicans')}\n${taulukkoRivi(vast)}
VIRE:\n${kpRivi('Pelicans')}\n${kpRivi(vast)}
PELICANSIN 10 VIIMEISINTÄ: ${(tilastot.vire || []).map((x) => (x.v ? 'V' : 'T') + (x.r ? `(${x.r})` : '')).join(' ')}
KESKINÄISET TÄLLÄ KAUDELLA: ${(tilastot.vastustaja === vast ? tilastot.keskinaiset : []).map((x) => `${x.koti ? 'koti' : 'vieras'} ${x.tulos}${x.r ? ' ' + x.r : ''}`).join(', ') || 'ei vielä kohtaamisia'}
PELICANS POISSA (Liigan tieto): ${(st.poissa || []).join(', ') || 'ei tiedossa'}
${vast.toUpperCase()} POISSA (Liigan tieto): ${(st.vastustajaPoissa || []).join(', ') || 'ei tiedossa'}
YLIVOIMA/ALIVOIMA: ${tilastot.yvav ? `Pelicans YV ${(tilastot.yvav.yv * 100).toFixed(1)} % (sija ${tilastot.yvav.yvSija}), AV ${(tilastot.yvav.av * 100).toFixed(1)} % (sija ${tilastot.yvav.avSija})` : 'ei tietoa'}
PISTEPÖRSSIN KÄRKI: ${(tilastot.porssi || []).slice(0, 5).map((p) => `${p.nimi} ${p.m}+${p.s}`).join(', ')}
TUOREET UUTISET (poissaolot, kokoonpanot, vire):\n${jutut.map(juttuRivi).join('\n')}`;
  const t = await gemini(`Kirjoitat otteluennakon Pelicansin faneille. "teksti": 4–6 virkettä: asetelma, kummankin vire, keskinäiset, poissaolot ja mihin kannattaa kiinnittää huomiota. Uutisissa mainitut poissaolot kerrotaan lähteen mukaan. "pointit": ennakon tärkeimmät huomiot.`, aineisto);
  if (t) { uudet.ennakko = { ...t, peliId: o.id, ottelu: `${o.koti} – ${o.vieras}`, aika: o.aika }; console.log('Otteluennakko tehty:', t.otsikko); }
}

// ---------- 3. Ottelun jälkeinen kooste: mitä eri mediat sanoivat ----------
async function jalki() {
  const o = (ottelut.pelatut || [])[0];
  if (!o || !o.paattynyt || koosteet.jalki?.peliId === o.id) return;
  const vast = o.kotona ? o.vieras : o.koti;
  const raportit = kohteet.filter((k) => k.aika > o.aika && k.aika < o.aika + 36 * H
    && (k.luokka === 'otteluraportti' || new RegExp(vast, 'i').test(k.otsikko)));
  const odotettu = nyt - o.aika;
  if (!PAKOTA && (odotettu < 2.5 * H || (raportit.length < 2 && odotettu < 12 * H))) return;
  const maalit = (o.maalit || []).map((m) => `${m.era}. erä ${Math.floor(m.aika / 60)}:${String(m.aika % 60).padStart(2, '0')} ${m.tilanne} ${m.tekija}${m.syottajat?.length ? ` (${m.syottajat.join(', ')})` : ''}${m.tyyppi ? ' ' + m.tyyppi : ''}`);
  const aineisto = `OTTELU: ${tulosTeksti(o)} (${pvm(o.aika)})${o.yleiso ? `, yleisöä ${o.yleiso}` : ''}
MAALIT:\n${maalit.join('\n') || 'ei tietoa'}
MAALIVAHDIT (Pelicans): ${(o.maalivahdit || []).map((m) => `${m.nimi} ${m.torjunnat} torjuntaa, ${m.paastetyt} päästettyä`).join('; ') || 'ei tietoa'}
MEDIOIDEN JUTUT OTTELUSTA:\n${raportit.map((k) => `- ${k.lahde}: "${k.otsikko}"${k.tiiv?.teksti ? ` – ${k.tiiv.teksti}` : k.kuvaus ? ` – ${k.kuvaus}` : ''}`).join('\n') || '- ei vielä juttuja'}`;
  const t = await gemini(`Kirjoitat ottelun jälkeisen koosteen Pelicansin faneille: mitä eri mediat sanoivat pelistä. "teksti": 4–6 virkettä: lopputulos ja ratkaisut lyhyesti, sitten eri medioiden näkökulmat ja painotukset (kerro mikä media sanoi mitä). Jos juttuja ei ole, kerro ottelun kulku tilastojen perusteella ja mainitse, ettei medioiden juttuja vielä ole. "pointit": tärkeimmät huomiot.`, aineisto);
  if (t) {
    uudet.jalki = { ...t, peliId: o.id, ottelu: tulosTeksti(o), aika: o.aika,
      lahteet: raportit.slice(0, 8).map((k) => ({ lahde: k.lahde, otsikko: k.otsikko, linkki: k.linkki })) };
    console.log('Jälkikooste tehty:', t.otsikko);
  }
}

// ---------- 4. Kolumnistikooste: mitä asiantuntijat sanovat ----------
async function kolumnit() {
  const lista = kohteet.filter((k) => k.luokka === 'kolumni' && k.aika > nyt - 14 * 24 * H);
  const ids = lista.map((k) => k.id).sort();
  const vanha = koosteet.kolumnit;
  if (!lista.length) return;
  if (!PAKOTA && vanha && (JSON.stringify(ids) === JSON.stringify(vanha.perustuu) || nyt - vanha.tehty < 20 * H)) return;
  const aineisto = `KOLUMNIT JA ANALYYSIT (14 pv):\n${lista.map((k) => `- ${pvm(k.aika)} · ${k.lahde} · "${k.otsikko}"${k.tiiv?.teksti ? ` – ${k.tiiv.teksti}` : k.kuvaus ? ` – ${k.kuvaus}` : ''}`).join('\n')}`;
  const t = await gemini(`Kokoat, mitä kolumnistit ja asiantuntijat sanovat Pelicansista. "teksti": 3–5 virkettä: mitkä teemat toistuvat, missä ollaan samaa ja missä eri mieltä. Kerro kenen (media) näkemys on kyseessä. "pointit": keskeiset näkemykset mediakohtaisesti.`, aineisto);
  if (t) {
    uudet.kolumnit = { ...t, perustuu: ids, lahteet: lista.slice(0, 10).map((k) => ({ lahde: k.lahde, otsikko: k.otsikko, linkki: k.linkki })) };
    console.log('Kolumnistikooste tehty.');
  }
}

// ---------- 5. Pelaajayhteenvedot ----------
async function pelaajat() {
  const raja = nyt - 21 * 24 * H;
  const maininnat = {};
  for (const k of kohteet.filter((x) => x.aika > raja)) for (const p of k.pelaajat || []) (maininnat[p] ||= []).push(k);
  for (const k of ketjut.filter((x) => x.muuttunut > raja)) for (const p of k.pelaajat || []) (maininnat[p] ||= []).push(k);
  const ehdokkaat = Object.entries(maininnat).filter(([, l]) => l.length >= 2)
    .sort((a, b) => b[1].length - a[1].length);
  const tulos = {};
  let tehty = 0;
  for (const [nimi, lista] of ehdokkaat) {
    const ids = lista.map((k) => k.id).sort();
    const vanha = pelaajaDoc[nimi];
    const muuttunut = !vanha || JSON.stringify(ids) !== JSON.stringify(vanha.perustuu);
    if (vanha && (!muuttunut || nyt - vanha.tehty < 12 * H)) { tulos[nimi] = { ...vanha, maara: lista.length }; continue; }
    if (tehty >= MAX_PELAAJIA_AJOSSA) { if (vanha) tulos[nimi] = vanha; continue; }
    const tilasto = (tilastot.porssi || []).find((p) => p.nimi === nimi);
    const aineisto = `PELAAJA: ${nimi}${tilasto ? `\nTILASTOT TÄLLÄ KAUDELLA: ${tilasto.o} ott., ${tilasto.m}+${tilasto.s}=${tilasto.p}, +/- ${tilasto.pm}` : ''}
SIIRTOTIEDOT: ${lista.flatMap((k) => (k.siirrot || []).filter((s) => s.pelaaja === nimi).map((s) => `${s.suunta} ${s.seura || ''} ${s.sopimus || ''} (${s.varmuus}, ${k.lahde})`)).join('; ') || 'ei'}
MAININNAT:\n${lista.map((k) => k.tyyppi === 'keskustelu' ? `- keskustelu "${k.otsikko}"${k.tiiv?.lyhyt ? ` – ${k.tiiv.lyhyt}` : ''} (palsta, huhuja)` : juttuRivi(k)).join('\n')}`;
    const t = await gemini(`Kokoat, mitä pelaajasta on kirjoitettu viime aikoina (Pelicans-näkökulma). "teksti": 2–4 virkettä: rooli, viimeaikaiset otteet ja uutiset, siirto- tai sopimustilanne. Palstojen puheet huhuina. "pointit": 2–5 tärkeintä asiaa.`, aineisto);
    tehty++;
    if (t) tulos[nimi] = { ...t, perustuu: ids, maara: lista.length };
    else if (vanha) tulos[nimi] = vanha;
  }
  await db.doc('kooste/pelaajat').set({ pelaajat: tulos, paivitetty: nyt });
  if (tehty) console.log(`Pelaajayhteenvetoja tehty ${tehty}.`);
}

for (const [n, f] of [['viikko', viikko], ['ennakko', ennakko], ['jalki', jalki], ['kolumnit', kolumnit], ['pelaajat', pelaajat]]) {
  try { await f(); } catch (e) { console.warn(`⚠ ${n}: ${e.message}`); VIRHEET.push(`${n}: ${e.message}`); }
}
if (Object.keys(uudet).length) await db.doc('kooste/koosteet').set(uudet, { merge: true });
else console.log('Ei uusia koosteita.');
await kirjaaVirheet(db, 'koosteet', VIRHEET);
