// Pelicans-kooste – lähteiden tarkistus (vaihe 1)
// Ajetaan GitHub Actionsissa käsin. Ei riippuvuuksia (Node 20+).
// Tulos kirjoitetaan Actionsin yhteenvetoon (Summary) taulukkona.

import { appendFileSync } from 'node:fs';

const UA = 'pelicans-kooste/0.1 (yksityinen sovellus; lahteiden tarkistus)';

// Sivustot: kotisivulta etsitään syötteet automaattisesti + kokeillaan tunnettuja ehdokkaita.
const SIVUSTOT = [
  { nimi: 'Yle Urheilu', koti: 'https://yle.fi/urheilu', ehdokkaat: [
    'https://feeds.yle.fi/uutiset/v1/recent.rss?publisherIds=YLE_URHEILU',
    'https://yle.fi/rss/urheilu'] },
  { nimi: 'Ilta-Sanomat', koti: 'https://www.is.fi/urheilu/', ehdokkaat: [
    'https://www.is.fi/rss/tuoreimmat.xml', 'https://www.is.fi/rss/urheilu.xml',
    'https://www.is.fi/rss/jaakiekko.xml'] },
  { nimi: 'Iltalehti', koti: 'https://www.iltalehti.fi/urheilu', ehdokkaat: [
    'https://www.iltalehti.fi/rss/urheilu.xml', 'https://www.iltalehti.fi/rss/uutiset.xml',
    'https://www.iltalehti.fi/rss/jaakiekko.xml'] },
  { nimi: 'MTV Uutiset', koti: 'https://www.mtvuutiset.fi/aihe/lahden-pelicans/', ehdokkaat: [
    'https://www.mtvuutiset.fi/api/feed/rss/uutiset_urheilu',
    'https://www.mtvuutiset.fi/api/feed/rss/uutiset_uusimmat'] },
  { nimi: 'Etelä-Suomen Sanomat', koti: 'https://www.ess.fi/', ehdokkaat: [
    'https://www.ess.fi/feed/rss', 'https://www.ess.fi/feed/rss/urheilu'] },
  { nimi: 'Uusi Lahti', koti: 'https://www.uusilahti.fi/', ehdokkaat: [
    'https://www.uusilahti.fi/feed/rss'] },
  { nimi: 'Liiga.fi', koti: 'https://liiga.fi/fi/uutiset', ehdokkaat: [] },
  { nimi: 'Pelicans.fi', koti: 'https://www.pelicans.fi/', ehdokkaat: [
    'https://www.pelicans.fi/feed', 'https://www.pelicans.fi/rss'] },
  { nimi: 'Jatkoaika (uutiset)', koti: 'https://www.jatkoaika.com/', ehdokkaat: [
    'https://www.jatkoaika.com/rss', 'https://www.jatkoaika.com/rss.xml',
    'https://www.jatkoaika.com/feed'] },
  { nimi: 'Jatkoaika (keskustelu)', koti: 'https://www.jatkoaika.com/foorumi/', ehdokkaat: [
    'https://www.jatkoaika.com/foorumi/forums/-/index.rss'] },
  { nimi: 'Suomi24 jääkiekko', koti: 'https://keskustelu.suomi24.fi/urheilu-ja-kuntoilu/jaakiekko', ehdokkaat: [] },
  { nimi: 'Reddit r/Liiga', koti: null, ehdokkaat: ['https://www.reddit.com/r/Liiga/.rss'] },
  { nimi: 'Google Uutiset', koti: null, ehdokkaat: [
    'https://news.google.com/rss/search?q=%22Pelicans%22+Lahti&hl=fi&gl=FI&ceid=FI:fi',
    'https://news.google.com/rss/search?q=Pelicans+Liiga&hl=fi&gl=FI&ceid=FI:fi'] },
];

// Liigan ottelurajapinta (epävirallinen). Kausi 2026–27 = 2027.
const JSON_LAHTEET = [
  { nimi: 'Liiga API ottelut', url: 'https://liiga.fi/api/v2/games?tournament=runkosarja&season=2027' },
  { nimi: 'Liiga API sarjataulukko', url: 'https://liiga.fi/api/v2/standings/?season=2027' },
];

async function hae(url, ms = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': '*/*' }, signal: c.signal, redirect: 'follow' });
    const teksti = await r.text();
    return { ok: r.ok, status: r.status, teksti, tyyppi: r.headers.get('content-type') || '', lopullinen: r.url };
  } catch (e) {
    return { ok: false, status: 0, teksti: '', virhe: String(e.message || e) };
  } finally { clearTimeout(t); }
}

function etsiSyotteet(html, pohja) {
  const tulos = new Set();
  const re = /<link[^>]+type=["']application\/(rss|atom)\+xml["'][^>]*>/gi;
  for (const m of html.matchAll(re)) {
    const href = m[0].match(/href=["']([^"']+)["']/i);
    if (href) { try { tulos.add(new URL(href[1], pohja).href); } catch {} }
  }
  return [...tulos];
}

function analysoiSyote(xml) {
  const onSyote = /<rss[\s>]|<feed[\s>]|<rdf:RDF/i.test(xml);
  const otsikot = [...xml.matchAll(/<(item|entry)[\s>][\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/gi)]
    .map(m => m[2].replace(/<!\[CDATA\[|\]\]>/g, '').trim());
  const pelicans = otsikot.filter(o => /pelicans/i.test(o) && !/new orleans|nba|zion/i.test(o));
  return { onSyote, maara: otsikot.length, pelicans };
}

async function robots(koti) {
  if (!koti) return '–';
  const u = new URL('/robots.txt', koti).href;
  const r = await hae(u, 10000);
  if (!r.ok) return `ei robots.txt (${r.status})`;
  // Yleiset säännöt (User-agent: *) – näytetään Disallow-rivit lyhyesti
  const lohkot = r.teksti.split(/\n(?=user-agent:)/i);
  const yleinen = lohkot.find(l => /user-agent:\s*\*/i.test(l)) || '';
  const kiellot = [...yleinen.matchAll(/^disallow:\s*(\S*)/gim)].map(m => m[1]).filter(Boolean);
  if (kiellot.includes('/')) return '⛔ kieltää kaiken';
  return kiellot.length ? `Disallow: ${kiellot.slice(0, 6).join(' ')}${kiellot.length > 6 ? ' …' : ''}` : 'ei kieltoja';
}

const rivit = [];
for (const s of SIVUSTOT) {
  let loydetyt = [];
  let kotiTila = '–';
  if (s.koti) {
    const k = await hae(s.koti);
    kotiTila = k.ok ? 'OK' : `${k.status || k.virhe}`;
    if (k.ok) loydetyt = etsiSyotteet(k.teksti, k.lopullinen || s.koti);
  }
  const rob = await robots(s.koti || s.ehdokkaat[0]);
  const kaikki = [...new Set([...loydetyt, ...s.ehdokkaat])];
  const tulokset = [];
  for (const url of kaikki) {
    const r = await hae(url);
    if (!r.ok) { tulokset.push(`✗ ${url} (${r.status || r.virhe})`); continue; }
    const a = analysoiSyote(r.teksti);
    if (!a.onSyote) { tulokset.push(`✗ ${url} (ei syöte)`); continue; }
    const esim = a.pelicans[0] ? ` – esim. "${a.pelicans[0].slice(0, 70)}"` : '';
    tulokset.push(`✓ ${url} — ${a.maara} kohdetta, Pelicans: ${a.pelicans.length}${esim}`);
  }
  rivit.push({ nimi: s.nimi, kotiTila, rob, loydetyt: loydetyt.length, tulokset });
  console.log(`\n## ${s.nimi}  (koti: ${kotiTila}, robots: ${rob})`);
  tulokset.forEach(t => console.log('  ' + t));
}

const jsonRivit = [];
for (const j of JSON_LAHTEET) {
  const r = await hae(j.url);
  let kuvaus = r.ok ? 'OK' : `✗ ${r.status || r.virhe}`;
  if (r.ok) {
    try {
      const d = JSON.parse(r.teksti);
      const lista = Array.isArray(d) ? d : (d.games || d.season || d.standings || Object.values(d)[0]);
      kuvaus = `✓ JSON, ${Array.isArray(lista) ? lista.length + ' riviä' : 'rakenne: ' + Object.keys(d).slice(0, 5).join(', ')}`;
    } catch { kuvaus = '✗ ei JSONia'; }
  }
  jsonRivit.push(`| ${j.nimi} | ${j.url} | ${kuvaus} |`);
  console.log(`\n## ${j.nimi}: ${kuvaus}`);
}

// Actionsin yhteenveto
let md = '# Lähteiden tarkistus\n\n';
for (const r of rivit) {
  md += `### ${r.nimi}\nKotisivu: ${r.kotiTila} · robots.txt: ${r.rob} · sivulta löytyi ${r.loydetyt} syötelinkkiä\n\n`;
  md += r.tulokset.length ? r.tulokset.map(t => `- ${t}`).join('\n') + '\n\n' : '- ei syötteitä\n\n';
}
md += '### Liigan rajapinta\n| Nimi | Osoite | Tulos |\n|---|---|---|\n' + jsonRivit.join('\n') + '\n';
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
