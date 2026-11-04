// Pelicans-kooste – keräys
// Lukee lähteet, suodattaa Pelicans-aiheiset, poistaa tuplat ja tallentaa Firestoreen.
// Hakee myös Liigan ottelut ja sarjataulukon.
// Ajetaan GitHub Actionsissa (keraa.yml). Tarvitsee salaisuuden FIREBASE_SERVICE_ACCOUNT.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const UA = 'pelicans-kooste/1.0 (yksityinen sovellus)';
const SAILYTYS_PV = 30;
const MAX_KOHTEITA = 400;
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

// ---------- Uutisten keräys ----------
async function keraaLahde(lahde) {
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

  for (const lahde of LAHTEET) {
    try {
      const uudet = await keraaLahde(lahde);
      console.log(`${lahde.id}: ${uudet.length} Pelicans-kohdetta`);
      for (const u of uudet) {
        const a = avain(u.otsikko);
        const olemassa = avaimet.get(a);
        if (!olemassa) {
          const k = { ...u, lisatty: nyt };
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
      console.warn(`⚠ ${lahde.id}: ${e.message}`);
    }
  }

  const raja = nyt - SAILYTYS_PV * 864e5;
  const ennen = kohteet.length;
  const siivottu = kohteet
    .filter((k) => k.aika >= raja)
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

// ---------- Ajo ----------
let virhe = false;
for (const [nimi, fn] of [['uutiset', paivitaUutiset], ['ottelut', paivitaOttelut]]) {
  try { await fn(); } catch (e) { virhe = true; console.error(`✗ ${nimi}:`, e); }
}
process.exit(virhe ? 1 : 0);
