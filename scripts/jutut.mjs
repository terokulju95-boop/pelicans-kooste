// Pelicans-kooste – tekoälytiivistelmä jokaisesta uutisesta ja keskustelusta
// Lukee jutun sivun, poimii tekstin ja pyytää Geminiltä lyhyen tiivistelmän + tärkeimmät pointit.
// Tiivistelmä tallennetaan kohteen yhteyteen, joten sovelluksessa se aukeaa heti.
// Ajetaan keräyksen jälkeen (keraa.yml). Tarvitsee FIREBASE_SERVICE_ACCOUNT ja GEMINI_API_KEY.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { kirjaaGemini, kirjaaVirheet, luePoistot, onPoistettu } from './yhteiset.mjs';

const VIRHEET = [];

const UA = 'pelicans-kooste/1.0 (yksityinen sovellus)';
const MAX_JUTTUJA_AJOSSA = 6;     // uusia juttutiivistelmiä per ajo (ajo 30 min välein)
const MAX_KETJUJA_AJOSSA = 2;
const KETJU_UUSINTA_H = 3;        // aktiivisen ketjun tiivistelmä päivitetään enintään 3 h välein
const MAX_YRITYKSET = 2;
const TEKSTI_MAX = 12000;
const MALLIT = ['gemini-flash-latest', 'gemini-flash-lite-latest'];
// Sivustot, joita ei lueta (Jatkoaika estää automaattiset haut – sen toivetta kunnioitetaan)
const EI_LUETA = /(^|\.)jatkoaika\.com$/i;

for (const s of ['FIREBASE_SERVICE_ACCOUNT', 'GEMINI_API_KEY']) {
  if (!process.env[s]) { console.error(`Puuttuu salaisuus ${s}`); process.exit(1); }
}
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();
const odota = (ms) => new Promise((r) => setTimeout(r, ms));

async function hae(url, asetukset = {}, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...asetukset, headers: { 'User-Agent': UA, ...(asetukset.headers || {}) }, signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return { teksti: await r.text(), url: r.url };
  } finally { clearTimeout(t); }
}

// ---------- Google Uutisten linkin purku alkuperäiseksi osoitteeksi ----------
async function puraGoogle(linkki) {
  const id = linkki.match(/news\.google\.com\/(?:rss\/)?articles\/([^?/#]+)/)?.[1];
  if (!id) return null;
  const { teksti: sivu } = await hae(`https://news.google.com/rss/articles/${id}`);
  const sg = sivu.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = sivu.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) return null;
  const pyynto = [[['Fbv4je',
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${id}",${ts},"${sg}"]`,
    null, 'generic']]];
  const { teksti } = await hae('https://news.google.com/_/DotsSplashUi/data/batchexecute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: 'f.req=' + encodeURIComponent(JSON.stringify(pyynto)),
  });
  try {
    const osa = JSON.parse(teksti.split('\n\n')[1]);
    const url = JSON.parse(osa[0][2])[1];
    if (/^https?:\/\//.test(url)) return url;
  } catch {}
  const m = teksti.match(/garturlres\\",\\"(https?:[^\\]+)\\"/);
  return m ? m[1] : null;
}

// ---------- Sivun luku ----------
const hiljainen = new VirtualConsole();
function poimiArtikkeli(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole: hiljainen });
  const d = dom.window.document;
  const meta = (s) => d.querySelector(s)?.getAttribute('content') || null;
  const julkaistu = meta('meta[property="article:published_time"]') || meta('meta[name="pubdate"]') ||
    d.querySelector('time[datetime]')?.getAttribute('datetime') || null;
  const otsikko = meta('meta[property="og:title"]') || d.title || '';
  const artikkeli = new Readability(d).parse();
  const teksti = (artikkeli?.textContent || '').replace(/\s+/g, ' ').trim();
  return { teksti, otsikko: (artikkeli?.title || otsikko).trim(), julkaistu: Date.parse(julkaistu || '') || null };
}

function ketjunTeksti(html, url) {
  const dom = new JSDOM(html, { url, virtualConsole: hiljainen });
  const d = dom.window.document;
  d.querySelectorAll('script,style,nav,header,footer,aside,form').forEach((e) => e.remove());
  return (d.body?.textContent || '').replace(/\s+/g, ' ').trim();
}

// ---------- Gemini ----------
const LUOKAT = ['otteluraportti', 'siirto', 'loukkaantuminen', 'talous', 'juniorit', 'kolumni', 'muu'];
const SKEEMA = {
  type: 'OBJECT',
  properties: {
    asiaotsikko: { type: 'STRING' },
    lyhyt: { type: 'STRING' },
    tiivistelma: { type: 'STRING' },
    pointit: { type: 'ARRAY', items: { type: 'STRING' } },
    vajaa: { type: 'BOOLEAN' },
    luokka: { type: 'STRING', enum: LUOKAT },
    pelaajat: { type: 'ARRAY', items: { type: 'STRING' } },
    tarkeys: { type: 'INTEGER' },
  },
  required: ['asiaotsikko', 'lyhyt', 'tiivistelma', 'pointit', 'vajaa', 'luokka', 'pelaajat', 'tarkeys'],
};

const OHJE_UUTINEN = `Tiivistät suomeksi jääkiekkouutisen Lahden Pelicans -faneille.
- "asiaotsikko": selkeä asiaotsikko (alle 12 sanaa), joka kertoo suoraan mitä tapahtui – ei klikkiotsikkoa, ei kysymyksiä.
- "lyhyt": 1–2 virkettä, jutun ydin.
- "tiivistelma": 3–5 virkettä omin sanoin: mitä tapahtui ja miksi sillä on väliä Pelicansille.
- "pointit": 3–5 lyhyttä tärkeintä tietoa (luvut, nimet, päivämäärät, sopimusten kestot, tulokset).
- "vajaa": true, jos teksti näyttää katkeavan (maksumuuri) tai on liian lyhyt kunnolliseen tiivistelmään. Kerro silloin tiivistelmässä, että se perustuu vain jutun alkuun.
- "luokka": otteluraportti (ottelun kulku/tulos), siirto (pelaajahankinnat, sopimukset, lähdöt, huhut siirroista, valmentajavaihdokset), loukkaantuminen, talous (seuran talous, omistajat, yleisö, areena), juniorit (nuoret ja junioritoiminta), kolumni (mielipide- tai asiantuntija-analyysi), muu.
- "pelaajat": jutussa mainitut pelaajat, valmentajat ja seurajohdon henkilöt koko nimellä (enintään 6, tärkein ensin).
- "tarkeys": 1–5. 5 = iso uutinen Pelicansille (pelaajasiirto, valmentajavaihdos, vakava loukkaantuminen, seuran talouskriisi). 3 = tavallinen ottelu-uutinen. 1 = sivumaininta.
- Käytä vain annettua tekstiä. Älä keksi mitään. Älä lainaa pitkiä pätkiä sanatarkasti.`;

const OHJE_OTSIKKO = `Luokittelet suomeksi jääkiekkouutisen Lahden Pelicans -faneille pelkän otsikon (ja mahdollisen lyhyen kuvauksen) perusteella.
Täytä kentät samoin säännöin kuin koko jutulle, mutta: "lyhyt" ja "tiivistelma" = tyhjä merkkijono, "pointit" = tyhjä lista, "vajaa" = true.
"asiaotsikko": selkeä asiaotsikko otsikon perusteella. "luokka", "pelaajat" ja "tarkeys" otsikon perusteella. Älä keksi mitään, mitä otsikossa ei ole.
Luokat: otteluraportti, siirto, loukkaantuminen, talous, juniorit, kolumni, muu. Tärkeys 1–5 (5 = iso uutinen Pelicansille).`;

const OHJE_KETJU = `Tiivistät suomeksi keskustelupalstan ketjun Lahden Pelicans -faneille.
- "asiaotsikko": selkeä kuvaus ketjun tämänhetkisestä puheenaiheesta (alle 12 sanaa).
- "lyhyt": 1–2 virkettä: mistä nyt puhutaan.
- "tiivistelma": 3–5 virkettä: mistä ketjussa puhutaan ja millainen tunnelma on. Painota Pelicansia koskevaa ja tuoreinta keskustelua.
- "luokka": aiheen mukaan (siirto = siirtohuhut, otteluraportti = ottelukeskustelu jne.). "pelaajat": mainitut pelaajat koko nimellä, jos tunnistettavissa (enintään 6).
- "tarkeys": 1–5 sen mukaan, kuinka merkittävästä Pelicans-asiasta puhutaan.
- "pointit": 3–5 keskeistä puheenaihetta tai huhua. Kirjoita huhut aina huhuina ("arvellaan", "kysytään", "väitetään"), ei tosiasioina.
- "vajaa": true, jos tekstissä on hyvin vähän Pelicansia koskevaa.
- Älä mainitse nimimerkkejä tai yksittäisiä keskustelijoita. Käytä vain annettua tekstiä. Älä lainaa viestejä sanatarkasti.`;

let viimeKutsu = 0;
async function gemini(ohje, sisalto) {
  for (const malli of MALLIT) {
    const tauko = 4500 - (Date.now() - viimeKutsu); // pysytään ilmaisen tason minuuttirajoissa
    if (tauko > 0) await odota(tauko);
    viimeKutsu = Date.now();
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${malli}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: ohje }] },
          contents: [{ role: 'user', parts: [{ text: sisalto }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: SKEEMA },
        }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(`${r.status} ${data?.error?.message || ''}`);
      const j = JSON.parse(data.candidates[0].content.parts.map((p) => p.text || '').join(''));
      await kirjaaGemini(db, true);
      return {
        teksti: String(j.tiivistelma || '').trim().slice(0, 1200),
        lyhyt: String(j.lyhyt || '').trim().slice(0, 400),
        pointit: (j.pointit || []).map((p) => String(p).trim()).filter(Boolean).slice(0, 5).map((p) => p.slice(0, 200)),
        vajaa: !!j.vajaa,
        malli,
        // kohteen omat tiedot
        asiaotsikko: String(j.asiaotsikko || '').trim().slice(0, 140),
        luokka: LUOKAT.includes(j.luokka) ? j.luokka : 'muu',
        pelaajat: (j.pelaajat || []).map((p) => String(p).trim()).filter((p) => p.length > 3 && p.length < 50).slice(0, 6),
        tarkeys: Math.min(5, Math.max(1, Number(j.tarkeys) || 2)),
      };
    } catch (e) {
      await kirjaaGemini(db, false);
      VIRHEET.push(`Gemini ${malli}: ${e.message}`);
      console.warn(`  ⚠ ${malli}: ${e.message}`);
    }
  }
  return null;
}

// Erottelee Geminin vastauksesta kohteen tiedot (luokka, pelaajat…) ja tiivistelmän
function tallennaTulos(k, t, lisa = {}) {
  const { asiaotsikko, luokka, pelaajat, tarkeys, ...tiiv } = t;
  Object.assign(k, { luokka, pelaajat, tarkeys });
  if (asiaotsikko) k.asiaotsikko = asiaotsikko;
  if (!lisa.vainLuokitus) k.tiiv = { ...tiiv, tehty: Date.now(), ...lisa };
}

// ---------- Uutiset ----------
// Luokitus pelkän otsikon perusteella (kun juttua ei voi lukea, tai vanhoille jutuille)
async function luokitteleOtsikosta(k) {
  const t = await gemini(OHJE_OTSIKKO, `Lähde: ${k.lahde}\nOtsikko: ${k.otsikko}${k.kuvaus ? `\nKuvaus: ${k.kuvaus}` : ''}${k.tiiv?.teksti ? `\nTiivistelmä: ${k.tiiv.teksti}` : ''}`);
  if (t) tallennaTulos(k, t, { vainLuokitus: true });
  k.luokiteltu = true;
}

async function kasitteleUutinen(k) {
  let linkki = k.linkki;
  if (k.google) {
    try {
      const suora = await puraGoogle(linkki);
      if (suora) { k.googleLinkki = k.linkki; k.linkki = linkki = suora; k.google = false; console.log(`  ↪ ${suora}`); }
    } catch (e) { console.warn(`  ⚠ Google-linkin purku: ${e.message}`); }
  }
  const host = (() => { try { return new URL(linkki).hostname; } catch { return ''; } })();
  if (EI_LUETA.test(host) || /news\.google\.com$/.test(host)) {
    k.tiiv = { eiSaatavilla: true, syy: EI_LUETA.test(host) ? 'Tätä sivustoa ei lueta automaattisesti.' : 'Juttua ei saatu auki.', tehty: Date.now() };
    await luokitteleOtsikosta(k);
    return;
  }
  const { teksti: html, url } = await hae(linkki);
  const art = poimiArtikkeli(html, url);
  if (k.aikaArvio && art.julkaistu) { k.aika = art.julkaistu; delete k.aikaArvio; }
  if (k.lahde === 'Pelicans.fi' && art.otsikko && art.otsikko.length > 10) k.otsikko = art.otsikko.slice(0, 160);
  if (art.teksti.length < 200) {
    k.tiiv = { eiSaatavilla: true, syy: 'Jutun tekstiä ei saatu luettua (todennäköisesti maksumuuri).', tehty: Date.now() };
    k.maksumuuri = true;
    await luokitteleOtsikosta(k);
    return;
  }
  const t = await gemini(OHJE_UUTINEN, `Lähde: ${k.lahde}\nOtsikko: ${k.otsikko}\n\nTeksti:\n${art.teksti.slice(0, TEKSTI_MAX)}`);
  if (!t) throw new Error('Gemini ei vastannut');
  if (t.vajaa) k.maksumuuri = true;
  tallennaTulos(k, t);
  k.luokiteltu = true;
}

// ---------- Keskustelut ----------
async function kasitteleKetju(k) {
  const { teksti: html, url } = await hae(k.linkki);
  const teksti = ketjunTeksti(html, url);
  const t = await gemini(OHJE_KETJU, `Ketju: ${k.otsikko} (${k.lahde})\n\nSivun teksti (uusimmat viestit yleensä lopussa):\n${teksti.slice(-TEKSTI_MAX)}`);
  if (!t) throw new Error('Gemini ei vastannut');
  tallennaTulos(k, t, { tila: k.tila });
}

// ---------- Ajo ----------
const poistot = await luePoistot(db);
const kohteetRef = db.doc('kooste/kohteet');
const kohteet = (await kohteetRef.get()).data()?.kohteet || [];
const elossa = kohteet.filter((k) => !onPoistettu(poistot, k));
const jono = elossa
  .filter((k) => !k.tiiv && (k.tiivYritykset || 0) < MAX_YRITYKSET)
  .sort((a, b) => (b.aikaArvio ? 1 : 0) - (a.aikaArvio ? 1 : 0) || b.aika - a.aika)
  .slice(0, MAX_JUTTUJA_AJOSSA);
// Vanhat jutut, joilta puuttuu luokka/pelaajat/asiaotsikko: luokitellaan tiivistelmän perusteella
const takautuvat = elossa
  .filter((k) => k.tiiv && !k.luokiteltu && !jono.includes(k))
  .sort((a, b) => b.aika - a.aika)
  .slice(0, MAX_JUTTUJA_AJOSSA);

let muutoksia = 0;
for (const k of jono) {
  console.log(`Uutinen: ${k.otsikko} (${k.lahde})`);
  try { await kasitteleUutinen(k); muutoksia++; }
  catch (e) {
    k.tiivYritykset = (k.tiivYritykset || 0) + 1;
    if (k.tiivYritykset >= MAX_YRITYKSET) k.tiiv = { eiSaatavilla: true, syy: 'Juttua ei saatu luettua.', tehty: Date.now() };
    muutoksia++;
    console.warn(`  ⚠ ${e.message}`);
  }
}
for (const k of takautuvat) {
  console.log(`Luokitus: ${k.otsikko}`);
  try { await luokitteleOtsikosta(k); muutoksia++; } catch (e) { console.warn(`  ⚠ ${e.message}`); }
}
if (muutoksia) {
  await kohteetRef.update({ kohteet });
  console.log(`Uutisia käsitelty ${jono.length}, luokiteltu jälkikäteen ${takautuvat.length}.`);
}

const ketjutRef = db.doc('kooste/keskustelut');
const ketjut = (await ketjutRef.get()).data()?.ketjut || [];
const ketjuJono = ketjut
  .filter((k) => !poistot.ids.has(k.id))
  .filter((k) => !k.tiiv || !k.luokka || (k.tiiv.tila !== k.tila && Date.now() - k.tiiv.tehty > KETJU_UUSINTA_H * 3600e3))
  .slice(0, MAX_KETJUJA_AJOSSA);
for (const k of ketjuJono) {
  console.log(`Ketju: ${k.otsikko}`);
  try { await kasitteleKetju(k); } catch (e) { console.warn(`  ⚠ ${e.message}`); VIRHEET.push(`Ketju ${k.otsikko}: ${e.message}`); }
}
if (ketjuJono.length) {
  await ketjutRef.update({ ketjut });
  console.log(`Ketjuja käsitelty ${ketjuJono.length}.`);
}
if (!jono.length && !takautuvat.length && !ketjuJono.length) console.log('Ei uusia tiivistettäviä.');
await kirjaaVirheet(db, 'tiivistelmät', VIRHEET);
