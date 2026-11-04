// Pelicans-kooste – tietolähteiden tutkimus (ajetaan käsin, ei tallenna mitään Firestoreen)
// Hakee näytteet Liigan rajapinnasta ja sivuilta, joita seuraavat ominaisuudet tarvitsevat,
// ja tallentaa ne kansioon naytteet/. Actions pakkaa kansion ladattavaksi zip-tiedostoksi.
import { mkdirSync, writeFileSync } from 'node:fs';

const UA = 'pelicans-kooste/1.0 (yksityinen sovellus; tutkimus)';
const MAX = 400_000;
mkdirSync('naytteet', { recursive: true });
const yhteenveto = [];

async function nayte(nimi, url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    const teksti = await r.text();
    const tyyppi = r.headers.get('content-type') || '';
    let sisalto = teksti;
    if (tyyppi.includes('json')) { try { sisalto = JSON.stringify(JSON.parse(teksti), null, 1); } catch {} }
    writeFileSync(`naytteet/${nimi}`, sisalto.slice(0, MAX));
    yhteenveto.push(`${r.status}\t${teksti.length}\t${tyyppi.split(';')[0]}\t${nimi}\t${url}`);
    console.log(`${r.status} ${nimi} (${teksti.length} merkkiä)`);
    return r.ok ? teksti : null;
  } catch (e) {
    yhteenveto.push(`ERR\t0\t-\t${nimi}\t${url}\t${e.message}`);
    console.log(`ERR ${nimi}: ${e.message}`);
    return null;
  }
}

const d = new Date();
const kausi = d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear();
const L = 'https://liiga.fi/api/v2';

// --- Liiga: ottelut ---
const pelit = JSON.parse((await nayte('liiga-games.json', `${L}/games?tournament=runkosarja&season=${kausi}`)) || '[]');
const lista = Array.isArray(pelit) ? pelit : (pelit.games || []);
const omat = lista.filter((g) => /pelicans/i.test(JSON.stringify([g.homeTeam?.teamName, g.awayTeam?.teamName, g.homeTeam?.teamId, g.awayTeam?.teamId])));
const pelattu = omat.filter((g) => g.ended).at(-1);
const tuleva = omat.find((g) => !g.ended);
const pelicansId = (pelattu && (/pelicans/i.test(pelattu.homeTeam?.teamName) ? pelattu.homeTeam?.teamId : pelattu.awayTeam?.teamId)) || 'pelicans';
console.log('Pelicans teamId:', pelicansId, 'pelattu:', pelattu?.id, 'tuleva:', tuleva?.id);

if (pelattu) {
  await nayte('liiga-game-detail.json', `${L}/games/${kausi}/${pelattu.id}`);
  await nayte('liiga-game-stats.json', `${L}/games/stats/${kausi}/${pelattu.id}`);
  await nayte('liiga-game-events.json', `${L}/games/${kausi}/${pelattu.id}/events`);
  await nayte('liiga-game-lineups.json', `${L}/games/${kausi}/${pelattu.id}/lineups`);
}
if (tuleva) await nayte('liiga-game-tuleva.json', `${L}/games/${kausi}/${tuleva.id}`);

// --- Liiga: tilastot (useita arvauksia osoitteista) ---
await nayte('liiga-players-summed.json', `${L}/players/stats/summed/${kausi}/${kausi}/runkosarja/true?dataType=basicStats`);
await nayte('liiga-players-goalies.json', `${L}/players/stats/summed/${kausi}/${kausi}/runkosarja/true?dataType=goalieStats`);
await nayte('liiga-players-team.json', `${L}/players/stats/${kausi}/runkosarja?teamId=${encodeURIComponent(pelicansId)}`);
await nayte('liiga-teams-stats.json', `${L}/teams/stats/${kausi}/runkosarja`);
await nayte('liiga-team-stats.json', `${L}/teams/stats/summed/${kausi}/${kausi}/runkosarja/true`);
await nayte('liiga-team.json', `${L}/teams/${encodeURIComponent(pelicansId)}?season=${kausi}`);
await nayte('liiga-standings.json', `${L}/standings/?season=${kausi}`);
await nayte('liiga-news-api.json', `${L}/news?limit=20`);

// --- Liiga.fi-sivut (rakenne: onko __NEXT_DATA__ tms.) ---
await nayte('liigafi-uutiset.html', 'https://liiga.fi/fi/uutiset');
await nayte('liigafi-pelicans.html', 'https://liiga.fi/fi/joukkueet/pelicans');
if (pelattu) await nayte('liigafi-ottelu.html', `https://liiga.fi/fi/ottelut/${kausi}/runkosarja/${pelattu.id}`);

// --- Suomi24: osasto ja yksi ketju ---
const osasto = await nayte('suomi24-osasto.html', 'https://keskustelu.suomi24.fi/urheilu-ja-kuntoilu/jaakiekko');
const ketju = osasto?.match(/href="((?:https:\/\/keskustelu\.suomi24\.fi)?\/t\/\d+\/[^"#?]+)"/)?.[1];
if (ketju) await nayte('suomi24-ketju.html', new URL(ketju, 'https://keskustelu.suomi24.fi').href);

// --- HFBoards ---
await nayte('hfboards-robots.txt', 'https://www.hfboards.com/robots.txt');
await nayte('hfboards-etusivu.html', 'https://www.hfboards.com/');
await nayte('hfboards-europe.html', 'https://www.hfboards.com/forums/european-leagues.19/');

// --- Pelicans.fi ---
await nayte('pelicansfi-etusivu.html', 'https://www.pelicans.fi/');
await nayte('pelicansfi-uutiset.html', 'https://www.pelicans.fi/uutiset');

writeFileSync('naytteet/_yhteenveto.tsv', 'tila\tkoko\ttyyppi\tnimi\tosoite\n' + yhteenveto.join('\n'));
console.log('\nValmis. Lataa "naytteet" ajon sivulta (Artifacts).');
