// Pelicans-kooste – keräys
// Lukee lähteet, suodattaa Pelicans-aiheiset, poistaa tuplat ja tallentaa Firestoreen.
// Hakee myös Liigan ottelut ja sarjataulukon.
// Ajetaan GitHub Actionsissa (keraa.yml). Tarvitsee salaisuuden FIREBASE_SERVICE_ACCOUNT.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { kirjaaLahteet, kirjaaVirheet, luePoistot, onPoistettu } from './yhteiset.mjs';

const TILA = [];     // lähteiden tila ylläpitonäkymään
const VIRHEET = [];
const UA = 'pelicans-kooste/1.0 (yksityinen sovellus)';
const SAILYTYS_PV = 30;
const MAX_KOHTEITA = 300; // pitää Firestore-dokumentin reilusti alle 1 Mt:n myös tiivistelmien kanssa
const KUVAUS_MAX = 200;

const lue = (polku) => JSON.parse(readFileSync(new URL(polku, import.meta.url), 'utf8'));
const LAHTEET = lue('../lahteet.json');
const SANAT = lue('../avainsanat.json');

// ---------- Firebase ----------
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error('Puuttuu salaisuus FIREBASE_SERVICE_ACCOUNT');
  process.exit(1);
}
initializeApp({ credential: cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = getFirestore();

// ---------- Apurit ----------
async function hae(url, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: c.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

const parser = new Parser({ customFields: { item: [['source', 'source']] } });

const hajautus = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
const avain = (otsikko) => otsikko.toLowerCase().normalize('NFC')
  .replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

function lyhenna(teksti) {
  if (!teksti) return '';
  const t = teksti.replace(/\s+/g, ' ').trim();
  return t.length <= KUVAUS_MAX ? t : t.slice(0, KUVAUS_MAX).replace(/\s+\S*$/, '') + '…';
}

function onPelicans(teksti) {
  const t = teksti.toLowerCase();
  if (!SANAT.vaaditut.some((s) => t.includes(s))) return false;
  return !SANAT.poissulje.some((s) => new RegExp(`\\b${s}\\b`, 'i').test(t));
}

// JSON avaimet aakkosjärjestyksessä, jotta vertailu ei riipu Firestoren järjestyksestä
function vakaa(x) {
  if (Array.isArray(x)) return `[${x.map(vakaa).join(',')}]`;
  if (x && typeof x === 'object') return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${vakaa(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}

function lahdeNimi(item) {
  const s = item.source;
  if (!s) return null;
  return typeof s === 'string' ? s : (s._ || null);
}

// ---------- Pelicans.fi (ei syötettä: luetaan uutislinkit sivulta) ----------
async function haePelicansFi(lahde) {
  const loydetyt = new Map();
  for (const sivu of lahde.sivut) {
    let html;
    try { html = await hae(sivu); } catch (e) { console.warn(`  ${sivu}: ${e.message}`); continue; }
    for (const m of html.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      let url;
      try { url = new URL(m[1].replace(/&amp;/g, '&'), sivu); } catch { continue; }
      if (!/(^|\.)pelicans\.fi$/i.test(url.hostname)) continue;
      if (!/\/(uutiset|uutinen|news|artikkeli|tiedote|tiedotteet)\/[^/]+/i.test(url.pathname)) continue;
      const teksti = puhdas(m[2]);
      if (teksti.length < 15) continue;
      const avainUrl = url.origin + url.pathname.replace(/\/$/, '');
      if (!loydetyt.has(avainUrl) || teksti.length > loydetyt.get(avainUrl).length) loydetyt.set(avainUrl, teksti);
    }
  }
  console.log(`  pelicans.fi: ${loydetyt.size} uutislinkkiä`, [...loydetyt.values()].slice(0, 3).join(' | '));
  return [...loydetyt].slice(0, 15).map(([linkki, otsikko], i) => ({
    id: hajautus(linkki), tyyppi: 'uutinen', lahde: 'Pelicans.fi', otsikko: otsikko.slice(0, 160), kuvaus: '',
    linkki, aika: null, aikaArvio: true, jarjestys: i, google: false, maksumuuri: false,
  }));
}

// ---------- Uutisten keräys ----------
async function keraaLahde(lahde) {
  if (lahde.tapa === 'pelicansfi') return haePelicansFi(lahde);
  const xml = await hae(lahde.url);
  const syote = await parser.parseString(xml);
  const tulos = [];
  for (const item of syote.items || []) {
    let otsikko = (item.title || '').trim();
    let nimi = lahde.nimi;
    if (lahde.google) {
      // Google Uutisten otsikko on muotoa "Otsikko - Media"
      const media = lahdeNimi(item);
      if (media) {
        nimi = media.trim();
        if (otsikko.endsWith(' - ' + nimi)) otsikko = otsikko.slice(0, -(nimi.length + 3)).trim();
      }
    }
    const kuvaus = lahde.kuvaus ? lyhenna(item.contentSnippet || '') : '';
    if (!otsikko || !item.link) continue;
    // Google-haku on jo rajattu Pelicansiin; muista syötteistä vaaditaan Pelicans-maininta
    const teksti = `${otsikko} ${kuvaus}`;
    if (lahde.google ? !onPelicans(teksti + ' pelicans') : !onPelicans(teksti)) continue;
    const aika = Date.parse(item.isoDate || item.pubDate || '') || Date.now();
    tulos.push({
      id: hajautus(item.link),
      tyyppi: lahde.tyyppi,
      lahde: nimi,
      otsikko,
      kuvaus,
      linkki: item.link,
      aika,
      google: !!lahde.google,
      maksumuuri: !!lahde.maksumuuri,
    });
  }
  return tulos;
}

async function paivitaUutiset() {
  const ref = db.doc('kooste/kohteet');
  const vanha = (await ref.get()).data();
  const kohteet = vanha?.kohteet || [];
  const avaimet = new Map(kohteet.map((k) => [avain(k.otsikko), k]));
  const nyt = Date.now();
  let lisatty = 0, korvattu = 0;
  const virheet = [];
  const poistot = await luePoistot(db);

  for (const lahde of LAHTEET) {
    try {
      const uudet = (await keraaLahde(lahde)).filter((u) => !onPoistettu(poistot, u));
      console.log(`${lahde.id}: ${uudet.length} Pelicans-kohdetta`);
      TILA.push({ id: lahde.id, nimi: lahde.nimi, ok: true, maara: uudet.length, aika: Date.now() });
      // Pelicans.fi:n ensimmäisellä kerralla vanhoja tiedotteita ei merkitä uusiksi eikä nosteta listan kärkeen
      const ekaKerta = lahde.tapa === 'pelicansfi' && !kohteet.some((k) => k.lahde === 'Pelicans.fi');
      for (const u of uudet) {
        const a = avain(u.otsikko);
        const olemassa = avaimet.get(a) || kohteet.find((k) => k.id === u.id);
        if (!olemassa) {
          if (u.aika == null) u.aika = ekaKerta ? nyt - 3 * 864e5 - u.jarjestys * 60000 : nyt;
          delete u.jarjestys;
          const k = { ...u, lisatty: ekaKerta ? 0 : nyt };
          kohteet.push(k);
          avaimet.set(a, k);
          lisatty++;
        } else if (olemassa.google && !u.google) {
          // Sama juttu löytyi median omasta syötteestä: käytetään median omaa linkkiä
          Object.assign(olemassa, {
            linkki: u.linkki, lahde: u.lahde, google: false,
            kuvaus: u.kuvaus || olemassa.kuvaus, maksumuuri: u.maksumuuri,
          });
          korvattu++;
        }
      }
    } catch (e) {
      virheet.push(`${lahde.id}: ${e.message}`);
      VIRHEET.push(`${lahde.nimi} (${lahde.id}): ${e.message}`);
      TILA.push({ id: lahde.id, nimi: lahde.nimi, ok: false, maara: 0, virhe: e.message, aika: Date.now() });
      console.warn(`⚠ ${lahde.id}: ${e.message}`);
    }
  }

  const raja = nyt - SAILYTYS_PV * 864e5;
  const ennen = kohteet.length;
  const siivottu = kohteet
    .filter((k) => k.aika >= raja && !onPoistettu(poistot, k))
    .sort((a, b) => b.aika - a.aika)
    .slice(0, MAX_KOHTEITA);
  const poistettu = ennen - siivottu.length;

  if (!vanha || lisatty || korvattu || poistettu) {
    await ref.set({ kohteet: siivottu, paivitetty: nyt, virheet });
    console.log(`Tallennettu: +${lisatty} uutta, ${korvattu} linkkiä vaihdettu, ${poistettu} vanhaa poistettu (yht. ${siivottu.length})`);
  } else {
    // Merkitään silti tarkistusaika, jotta sovellus näyttää "Päivitetty klo …"
    await ref.update({ tarkistettu: nyt, virheet });
    console.log('Ei uutta.');
  }
}

// ---------- Liigan ottelut ja sarjataulukko ----------
function kausi() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear(); // kausi 2026–27 = 2027
}

const onPeli = (j) => /pelicans/i.test(`${j?.teamName || ''} ${j?.teamId || ''}`);
const nimi = (j) => j?.teamName || j?.teamId || '?';

async function paivitaOttelut() {
  const k = kausi();
  const peleja = JSON.parse(await hae(`https://liiga.fi/api/v2/games?tournament=runkosarja&season=${k}`));
  const lista = Array.isArray(peleja) ? peleja : (peleja.games || []);
  if (lista[0]) console.log('Ottelun kentät:', Object.keys(lista[0]).join(', '));

  const omat = lista
    .filter((g) => onPeli(g.homeTeam) || onPeli(g.awayTeam))
    .map((g) => ({
      id: g.id,
      aika: Date.parse(g.start) || null,
      koti: nimi(g.homeTeam),
      vieras: nimi(g.awayTeam),
      kotiMaalit: g.homeTeam?.goals ?? null,
      vierasMaalit: g.awayTeam?.goals ?? null,
      kotona: onPeli(g.homeTeam),
      paattynyt: !!g.ended,
      kaynnissa: !!g.started && !g.ended,
      ratkaisu: g.finishedType || null,
    }))
    .sort((a, b) => a.aika - b.aika);
  console.log(`Pelicansin otteluita kaudella ${k}: ${omat.length}`);

  const tulevat = omat.filter((o) => !o.paattynyt).slice(0, 5);
  const pelatut = omat.filter((o) => o.paattynyt).slice(-5).reverse();

  let sarjataulukko = [];
  try {
    const st = JSON.parse(await hae(`https://liiga.fi/api/v2/standings/?season=${k}`));
    const rivit = Array.isArray(st) ? st : (st.season || st.standings || Object.values(st).find(Array.isArray) || []);
    if (rivit[0]) console.log('Sarjataulukon kentät:', Object.keys(rivit[0]).join(', '));
    sarjataulukko = rivit.map((r, i) => ({
      sija: r.ranking ?? r.position ?? i + 1,
      joukkue: r.teamName ?? r.name ?? r.team?.teamName ?? r.internalId ?? '?',
      ottelut: r.games ?? r.gamesPlayed ?? null,
      pisteet: r.points ?? null,
      maalit: r.goals != null && r.goalsAgainst != null ? `${r.goals}–${r.goalsAgainst}` : null,
    })).filter((r) => r.joukkue !== '?');
  } catch (e) {
    console.warn('⚠ sarjataulukko:', e.message);
  }

  const data = { kausi: k, tulevat, pelatut, sarjataulukko };
  const ref = db.doc('kooste/ottelut');
  const vanha = (await ref.get()).data();
  const { paivitetty, ...vanhaData } = vanha || {};
  if (vakaa(vanhaData) !== vakaa(data)) {
    await ref.set({ ...data, paivitetty: Date.now() });
    console.log('Ottelut tallennettu.');
  } else {
    console.log('Ottelut ennallaan.');
  }
}

// ---------- Keskustelut (Suomi24) ----------
// Tallennetaan vain ketjun otsikko, linkki ja aktiivisuustieto. Nimimerkkejä tai viestejä ei tallenneta.
const KESKUSTELUT = lue('../keskustelut.json');
const odota = (ms) => new Promise((r) => setTimeout(r, ms));

function puhdas(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim();
}

async function haeSuomi24Lista(url) {
  const html = await hae(url);
  const ketjut = new Map();
  const re = /<a[^>]+href="((?:https:\/\/keskustelu\.suomi24\.fi)?\/t\/(\d+)\/[^"#?]*)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const id = m[2];
    const otsikko = puhdas(m[3]);
    if (otsikko.length < 4) continue;
    const linkki = new URL(m[1], 'https://keskustelu.suomi24.fi').href;
    const vanha = ketjut.get(id);
    // Sama ketju voi olla listalla useamman linkin takana; pidetään pisin teksti (yleensä otsikko)
    if (!vanha || otsikko.length > vanha.otsikko.length) ketjut.set(id, { id, otsikko: otsikko.slice(0, 160), linkki });
  }
  return [...ketjut.values()];
}

async function tutkiKetju(linkki) {
  const teksti = puhdas(await hae(linkki));
  const maininnat = (teksti.match(/pelicans|pelsu/gi) || []).length;
  // Muutoksen tunniste: sivun teksti ilman numeroita (suhteelliset ajat yms. eivät aiheuta turhia muutoksia)
  const tila = hajautus(teksti.replace(/\d+/g, ''));
  return { maininnat, tila };
}

async function paivitaKeskustelut() {
  const asetus = KESKUSTELUT.suomi24;
  const yleiset = new RegExp(asetus.yleisetKetjut, 'i');
  const ref = db.doc('kooste/keskustelut');
  const vanha = (await ref.get()).data();
  const ketjut = new Map((vanha?.ketjut || []).map((k) => [k.id, k]));
  const nyt = Date.now();

  let ehdokkaat = [];
  for (const osasto of asetus.osastot) {
    try {
      const lista = await haeSuomi24Lista(osasto);
      console.log(`Suomi24 ${osasto}: ${lista.length} ketjua listalla`);
      console.log('  esim:', lista.slice(0, 5).map((k) => k.otsikko).join(' | '));
      ehdokkaat.push(...lista);
      TILA.push({ id: 'suomi24', nimi: 'Suomi24', ok: lista.length > 0, maara: lista.length,
        virhe: lista.length ? null : 'Listalta ei löytynyt ketjuja', aika: Date.now() });
    } catch (e) {
      console.warn(`⚠ Suomi24 ${osasto}: ${e.message}`);
      VIRHEET.push(`Suomi24: ${e.message}`);
      TILA.push({ id: 'suomi24', nimi: 'Suomi24', ok: false, maara: 0, virhe: e.message, aika: Date.now() });
    }
  }

  const poistot = await luePoistot(db);
  for (const id of poistot.ids) ketjut.delete(id);
  ehdokkaat = ehdokkaat.filter((k) => !poistot.ids.has('s24-' + k.id));
  const omat = ehdokkaat.filter((k) => onPelicans(k.otsikko));
  const muut = ehdokkaat.filter((k) => !onPelicans(k.otsikko) && yleiset.test(k.otsikko));
  const tutkittavat = [...omat, ...muut].slice(0, asetus.maxKetjuja);
  console.log(`Pelicans-ketjuja ${omat.length}, yleisiä huhuketjuja ${muut.length}, tutkitaan ${tutkittavat.length}`);

  for (const k of tutkittavat) {
    try {
      await odota(1000);
      const { maininnat, tila } = await tutkiKetju(k.linkki);
      const oma = onPelicans(k.otsikko);
      if (!oma && maininnat === 0) continue; // yleinen ketju, jossa ei puhuta Pelicansista
      const id = 's24-' + k.id;
      const ed = ketjut.get(id);
      if (!ed) {
        ketjut.set(id, { id, tyyppi: 'keskustelu', lahde: 'Suomi24', otsikko: k.otsikko, linkki: k.linkki,
          pelicansKetju: oma, maininnat, tila, lisatty: nyt, muuttunut: nyt });
      } else if (ed.tila !== tila) {
        Object.assign(ed, { otsikko: k.otsikko, maininnat, tila, muuttunut: nyt });
      }
    } catch (e) { console.warn(`⚠ ketju ${k.linkki}: ${e.message}`); }
  }

  const raja = nyt - asetus.sailytysPaivia * 864e5;
  const lista = [...ketjut.values()].filter((k) => k.muuttunut >= raja).sort((a, b) => b.muuttunut - a.muuttunut);
  if (!vanha || vakaa(lista) !== vakaa(vanha.ketjut || [])) {
    await ref.set({ ketjut: lista, paivitetty: nyt });
    console.log(`Keskustelut tallennettu (${lista.length} ketjua).`);
  } else {
    console.log('Keskustelut ennallaan.');
  }
}

// ---------- Ajo ----------
let virhe = false;
for (const [nimi, fn] of [['uutiset', paivitaUutiset], ['ottelut', paivitaOttelut], ['keskustelut', paivitaKeskustelut]]) {
  try {
    await fn();
    if (nimi === 'ottelut') TILA.push({ id: 'liiga', nimi: 'Liiga (ottelut ja taulukko)', ok: true, maara: null, aika: Date.now() });
  } catch (e) {
    virhe = true;
    console.error(`✗ ${nimi}:`, e);
    VIRHEET.push(`${nimi}: ${e.message}`);
    if (nimi === 'ottelut') TILA.push({ id: 'liiga', nimi: 'Liiga (ottelut ja taulukko)', ok: false, virhe: e.message, aika: Date.now() });
  }
}
await kirjaaLahteet(db, TILA);
await kirjaaVirheet(db, 'keräys', VIRHEET);
process.exit(virhe ? 1 : 0);
