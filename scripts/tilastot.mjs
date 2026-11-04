// Pelicans-kooste – ottelut ja tilastot Liigan rajapinnasta
// Tuottaa dokumentit:
//   kooste/ottelut  – tulevat ja pelatut ottelut tapahtumineen, sarjataulukko, rajat, kokoonpano
//   kooste/tilastot – pistepörssi, maalivahdit, vire, kuntopuntari, koti/vieras, ennuste, pisteerot, sijoituskaavio, YV/AV
//   kooste/pelit    – välimuisti: jokaisen pelatun Pelicans-ottelun jäähyt ja maalivahtitilastot (haetaan vain kerran)

const L = 'https://liiga.fi/api/v2';
const ON_PELICANS = (j) => /pelicans/i.test(`${j?.teamName || ''} ${j?.teamId || ''}`);

export function kausi() {
  const d = new Date();
  return d.getMonth() >= 6 ? d.getFullYear() + 1 : d.getFullYear(); // kausi 2026–27 = 2027
}

const nimi = (p) => (p ? `${p.firstName || ''} ${p.lastName || ''}`.trim() : '');
const ratkaisu = (ft) => (/WINNING_SHOT/.test(ft || '') ? 'vl' : /EXTENDED/.test(ft || '') ? 'ja' : '');

// Liigan pisteet: varsinaisen peliajan voitto 3, jatkoaika-/voittolaukausvoitto 2, -tappio 1
function pisteet(omat, vast, ft) {
  if (omat > vast) return ratkaisu(ft) ? 2 : 3;
  return ratkaisu(ft) ? 1 : 0;
}

// Sarjataulukko annetuista otteluista (pisteet, sitten maaliero, sitten tehdyt maalit)
function taulukko(pelit) {
  const t = {};
  const rivi = (j) => (t[j] ||= { joukkue: j, ottelut: 0, pisteet: 0, tehdyt: 0, paastetyt: 0 });
  for (const g of pelit) {
    const k = rivi(g.homeTeam.teamName), v = rivi(g.awayTeam.teamName);
    const km = g.homeTeam.goals ?? 0, vm = g.awayTeam.goals ?? 0;
    k.ottelut++; v.ottelut++;
    k.tehdyt += km; k.paastetyt += vm; v.tehdyt += vm; v.paastetyt += km;
    k.pisteet += pisteet(km, vm, g.finishedType);
    v.pisteet += pisteet(vm, km, g.finishedType);
  }
  return Object.values(t).sort((a, b) => b.pisteet - a.pisteet
    || (b.tehdyt - b.paastetyt) - (a.tehdyt - a.paastetyt) || b.tehdyt - a.tehdyt)
    .map((r, i) => ({ ...r, sija: i + 1 }));
}

function maalit(g) {
  const lista = [];
  for (const [puoli, koti] of [['homeTeam', true], ['awayTeam', false]]) {
    for (const e of g[puoli]?.goalEvents || []) {
      lista.push({
        aika: e.gameTime, era: e.period, koti,
        tekija: nimi(e.scorerPlayer),
        syottajat: (e.assistantPlayers || []).map(nimi).filter(Boolean),
        tilanne: `${e.homeTeamScore}–${e.awayTeamScore}`,
        tyyppi: (e.goalTypes || []).join(' '),
        ratkaisu: !!e.winningGoal,
      });
    }
  }
  return lista.sort((a, b) => a.aika - b.aika);
}

function perusOttelu(g) {
  return {
    id: g.id,
    aika: Date.parse(g.start) || null,
    koti: g.homeTeam?.teamName || '?',
    vieras: g.awayTeam?.teamName || '?',
    kotiMaalit: g.homeTeam?.goals ?? null,
    vierasMaalit: g.awayTeam?.goals ?? null,
    kotona: ON_PELICANS(g.homeTeam),
    paattynyt: !!g.ended,
    kaynnissa: !!g.started && !g.ended,
    ratkaisu: g.finishedType || null,
    yleiso: g.spectators || null,
    liput: g.buyTicketsUrl || null,
    halli: g.iceRink?.name || null,
  };
}

const ROOLI = { KH: 'H', VL: 'H', OL: 'H', VH: 'H', OH: 'H', H: 'H', VP: 'P', OP: 'P', P: 'P', MV: 'MV' };
function kokoonpano(pelaajat) {
  const mukana = (pelaajat || []).filter((p) => p.line != null && !p.removed);
  if (!mukana.length) return null;
  const ketjut = {};
  const mv = [];
  for (const p of mukana) {
    const r = ROOLI[p.roleCode] || (/GOAL/i.test(p.role) ? 'MV' : /DEFENSE/i.test(p.role) ? 'P' : 'H');
    const merkinta = `${nimi(p)}${p.jersey ? ' #' + p.jersey : ''}`;
    if (r === 'MV') { mv.push(merkinta); continue; }
    const k = (ketjut[p.line] ||= { ketju: p.line, hyokkaajat: [], puolustajat: [] });
    (r === 'P' ? k.puolustajat : k.hyokkaajat).push(merkinta);
  }
  return { ketjut: Object.values(ketjut).sort((a, b) => a.ketju - b.ketju), maalivahdit: mv };
}
const poissa = (pelaajat) => (pelaajat || []).filter((p) => p.injured || p.suspended)
  .map((p) => `${nimi(p)} (${p.suspended ? 'pelikielto' : 'loukkaantunut'})`);

// Yhden pelatun ottelun lisätiedot (jäähyt, maalivahdit). Haetaan kerran ja tallennetaan välimuistiin.
async function otteluLisat(hae, k, id) {
  const d = JSON.parse(await hae(`${L}/games/${k}/${id}`));
  const g = d.game || d;
  const pelaajat = new Map([...(d.homeTeamPlayers || []), ...(d.awayTeamPlayers || [])].map((p) => [p.id, p]));
  const jaahyt = [];
  for (const [puoli, koti] of [['homeTeam', true], ['awayTeam', false]]) {
    for (const e of g[puoli]?.penaltyEvents || []) {
      jaahyt.push({ aika: e.gameTime, era: e.period, koti, pelaaja: nimi(pelaajat.get(e.playerId)) || '–',
        rike: e.penaltyFaultName || e.penaltyFaultType || '', min: e.penaltyMinutes || 0 });
    }
  }
  jaahyt.sort((a, b) => a.aika - b.aika);

  const maalivahdit = [];
  try {
    const s = JSON.parse(await hae(`${L}/games/stats/${k}/${id}`));
    for (const puoli of ['homeTeam', 'awayTeam']) {
      const jaksot = s[puoli] || [];
      if (!jaksot.length || !ON_PELICANS({ teamId: jaksot[0].teamId })) continue;
      const mv = {};
      for (const j of jaksot) {
        for (const gp of j.goaliePeriodStats || []) {
          const p = gp.period || {};
          const m = (mv[gp.playerId] ||= { id: gp.playerId, nimi: nimi(pelaajat.get(gp.playerId)), torjunnat: 0, paastetyt: 0, aika: 0 });
          m.torjunnat += p.saves || 0; m.paastetyt += p.goalsAllowed || 0; m.aika += p.timeofice || 0;
        }
      }
      for (const m of Object.values(mv)) if (m.aika > 0 || m.torjunnat > 0) maalivahdit.push(m);
    }
  } catch (e) { console.warn(`  ⚠ ottelun ${id} tilastot: ${e.message}`); }

  return {
    jaahyt, maalivahdit,
    yv: { koti: [g.homeTeam?.powerplayGoals ?? 0, g.homeTeam?.powerplayInstances ?? 0],
          vieras: [g.awayTeam?.powerplayGoals ?? 0, g.awayTeam?.powerplayInstances ?? 0] },
  };
}

export async function paivitaOttelut(db, hae, vakaa) {
  const k = kausi();
  const kaikki = JSON.parse(await hae(`${L}/games?tournament=runkosarja&season=${k}`));
  const lista = (Array.isArray(kaikki) ? kaikki : (kaikki.games || [])).filter((g) => g.homeTeam?.teamName && g.awayTeam?.teamName);
  const pelatut = lista.filter((g) => g.ended).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const omat = lista.filter((g) => ON_PELICANS(g.homeTeam) || ON_PELICANS(g.awayTeam))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const omatPelatut = omat.filter((g) => g.ended);
  const omatTulevat = omat.filter((g) => !g.ended);
  console.log(`Pelicansin otteluita kaudella ${k}: ${omat.length} (pelattu ${omatPelatut.length})`);

  // --- Välimuisti: jäähyt ja maalivahdit pelatuista otteluista ---
  const peliRef = db.doc('kooste/pelit');
  const valimuisti = (await peliRef.get()).data()?.pelit || {};
  let uusiaLisia = 0;
  for (const g of omatPelatut) {
    if (valimuisti[g.id] || uusiaLisia >= 25) continue;
    try { valimuisti[g.id] = await otteluLisat(hae, k, g.id); uusiaLisia++; }
    catch (e) { console.warn(`  ⚠ ottelu ${g.id}: ${e.message}`); }
  }
  if (uusiaLisia) { await peliRef.set({ pelit: valimuisti }); console.log(`Ottelutietoja haettu ${uusiaLisia}.`); }

  // --- Seuraavan ottelun kokoonpano ja poissaolot ---
  let seuraavaTiedot = null;
  const seuraava = omatTulevat[0];
  if (seuraava) {
    try {
      const d = JSON.parse(await hae(`${L}/games/${k}/${seuraava.id}`));
      const omaKoti = ON_PELICANS(seuraava.homeTeam);
      const omatP = omaKoti ? d.homeTeamPlayers : d.awayTeamPlayers;
      const vastP = omaKoti ? d.awayTeamPlayers : d.homeTeamPlayers;
      seuraavaTiedot = {
        id: seuraava.id,
        kokoonpano: kokoonpano(omatP),
        vastustajanKokoonpano: kokoonpano(vastP),
        poissa: poissa(omatP),
        vastustajaPoissa: poissa(vastP),
      };
    } catch (e) { console.warn('  ⚠ seuraavan ottelun tiedot:', e.message); }
  }

  // --- Ottelulistat ---
  const tulevat = omatTulevat.slice(0, 6).map(perusOttelu);
  const viimeiset = omatPelatut.slice(-10).reverse().map((g) => {
    const o = perusOttelu(g);
    const lisa = valimuisti[g.id] || {};
    return { ...o, maalit: maalit(g), jaahyt: lisa.jaahyt || [], maalivahdit: lisa.maalivahdit || [] };
  });

  // --- Virallinen sarjataulukko ja rajat ---
  let sarjataulukko = [], rajat = [4, 12, 14], yvav = null;
  try {
    const st = JSON.parse(await hae(`${L}/standings/?season=${k}`));
    const rivit = st.season || [];
    if (Array.isArray(st.playoffsLines) && st.playoffsLines.length) rajat = st.playoffsLines;
    sarjataulukko = rivit.map((r, i) => ({
      sija: r.ranking ?? i + 1, joukkue: r.teamName, ottelut: r.games, pisteet: r.points,
      voitot: r.wins, tappiot: r.losses, maalit: `${r.goals}–${r.goalsAgainst}`,
      yv: Number(r.powerPlayPercentage) || 0, av: Number(r.shortHandedPercentage) || 0,
    }));
    const jarj = (kentta) => [...sarjataulukko].sort((a, b) => b[kentta] - a[kentta]);
    const oma = sarjataulukko.find((r) => /pelicans/i.test(r.joukkue));
    if (oma) {
      yvav = {
        yv: oma.yv, yvSija: jarj('yv').findIndex((r) => r.joukkue === oma.joukkue) + 1,
        av: oma.av, avSija: jarj('av').findIndex((r) => r.joukkue === oma.joukkue) + 1,
        joukkueita: sarjataulukko.length,
        yvKa: sarjataulukko.reduce((s, r) => s + r.yv, 0) / sarjataulukko.length,
        avKa: sarjataulukko.reduce((s, r) => s + r.av, 0) / sarjataulukko.length,
      };
    }
  } catch (e) { console.warn('⚠ sarjataulukko:', e.message); }

  const data = { kausi: k, tulevat, pelatut: viimeiset, sarjataulukko, rajat, seuraavaTiedot };
  const ref = db.doc('kooste/ottelut');
  const { paivitetty, ...vanhaData } = (await ref.get()).data() || {};
  if (vakaa(vanhaData) !== vakaa(data)) { await ref.set({ ...data, paivitetty: Date.now() }); console.log('Ottelut tallennettu.'); }

  // ====== Tilastot ======
  const tulos = (g) => {
    const koti = ON_PELICANS(g.homeTeam);
    const oma = koti ? g.homeTeam.goals : g.awayTeam.goals, vast = koti ? g.awayTeam.goals : g.homeTeam.goals;
    return { v: oma > vast, r: ratkaisu(g.finishedType), vastustaja: koti ? g.awayTeam.teamName : g.homeTeam.teamName,
      tulos: `${oma}–${vast}`, aika: Date.parse(g.start), koti, p: pisteet(oma, vast, g.finishedType) };
  };
  const vire = omatPelatut.slice(-10).map(tulos);

  // Kuntopuntari: 10 viimeisintä ottelua jokaiselta joukkueelta
  const joukkueet = [...new Set(lista.flatMap((g) => [g.homeTeam.teamName, g.awayTeam.teamName]))];
  const kuntopuntari = joukkueet.map((j) => {
    const sen = pelatut.filter((g) => g.homeTeam.teamName === j || g.awayTeam.teamName === j).slice(-10);
    const p = sen.reduce((s, g) => s + (g.homeTeam.teamName === j ? pisteet(g.homeTeam.goals, g.awayTeam.goals, g.finishedType)
      : pisteet(g.awayTeam.goals, g.homeTeam.goals, g.finishedType)), 0);
    return { joukkue: j, ottelut: sen.length, pisteet: p };
  }).sort((a, b) => b.pisteet - a.pisteet).map((r, i) => ({ ...r, sija: i + 1 }));

  // Koti- ja vierastaulukot
  const osaTaulukko = (puoli) => joukkueet.map((j) => {
    const sen = pelatut.filter((g) => g[puoli].teamName === j);
    const muu = puoli === 'homeTeam' ? 'awayTeam' : 'homeTeam';
    return { joukkue: j, ottelut: sen.length,
      pisteet: sen.reduce((s, g) => s + pisteet(g[puoli].goals, g[muu].goals, g.finishedType), 0) };
  }).sort((a, b) => b.pisteet / Math.max(b.ottelut, 1) - a.pisteet / Math.max(a.ottelut, 1)).map((r, i) => ({ ...r, sija: i + 1 }));
  const koti = osaTaulukko('homeTeam'), vieras = osaTaulukko('awayTeam');

  // Keskinäiset seuraavaa vastustajaa vastaan
  const vastustaja = seuraava ? (ON_PELICANS(seuraava.homeTeam) ? seuraava.awayTeam.teamName : seuraava.homeTeam.teamName) : null;
  const keskinaiset = vastustaja ? omatPelatut.filter((g) => [g.homeTeam.teamName, g.awayTeam.teamName].includes(vastustaja)).map(tulos) : [];

  // Ennuste: nykyinen pistetahti × koko runkosarjan ottelumäärä
  const nykyinen = taulukko(pelatut);
  const ennusteTaulukko = nykyinen.map((r) => {
    const yhteensa = lista.filter((g) => g.homeTeam.teamName === r.joukkue || g.awayTeam.teamName === r.joukkue).length;
    return { joukkue: r.joukkue, pisteet: Math.round(r.pisteet / Math.max(r.ottelut, 1) * yhteensa), ottelut: yhteensa };
  }).sort((a, b) => b.pisteet - a.pisteet).map((r, i) => ({ ...r, sija: i + 1 }));

  // Pisteerot viivoihin virallisen taulukon mukaan
  const oma = sarjataulukko.find((r) => /pelicans/i.test(r.joukkue));
  const viiva = (sija) => sarjataulukko.find((r) => r.sija === sija);
  const ero = (sija, nimiTxt) => {
    const r = viiva(sija);
    return r && oma ? { nimi: nimiTxt, sija, joukkue: r.joukkue, pisteet: r.pisteet, ottelut: r.ottelut,
      ero: oma.pisteet - r.pisteet, otteluero: oma.ottelut - r.ottelut } : null;
  };
  const pisteerot = [
    ero(rajat[0], 'Suoraan puolivälieriin'),
    ero(rajat[1], 'Pudotuspeliviiva'),
    ero((rajat[2] || 14) + 1, 'Putoamisviiva'),
  ].filter(Boolean);

  // Sijoituksen kehitys jokaisen Pelicans-ottelun jälkeen
  const kaavio = omatPelatut.map((g, i) => {
    const asti = pelatut.filter((x) => Date.parse(x.start) <= Date.parse(g.start));
    const r = taulukko(asti).find((x) => /pelicans/i.test(x.joukkue));
    return { n: i + 1, sija: r?.sija ?? null, pisteet: r?.pisteet ?? 0, aika: Date.parse(g.start) };
  });

  // Pistepörssi ja maalivahdit
  let porssi = [];
  try {
    const pel = JSON.parse(await hae(`${L}/players/stats/summed/${k}/${k}/runkosarja/true?dataType=basicStats`));
    porssi = (Array.isArray(pel) ? pel : []).filter((p) => /pelicans/i.test(p.teamName || '') && !p.goalkeeper && p.current !== false)
      .map((p) => ({ nimi: nimi(p), nro: p.jersey, rooli: p.role, o: p.games, m: p.goals, s: p.assists, p: p.points,
        pm: p.plusMinus, jm: p.penaltyMinutes, yvm: p.powerplayGoals, laukaukset: p.shots,
        loukkaantunut: !!p.injured, pelikielto: !!p.suspended }))
      .filter((p) => p.o > 0)
      .sort((a, b) => b.p - a.p || b.m - a.m);
  } catch (e) { console.warn('⚠ pistepörssi:', e.message); }

  const mvSumma = {};
  for (const lisa of Object.values(valimuisti)) {
    for (const m of lisa.maalivahdit || []) {
      const s = (mvSumma[m.id] ||= { nimi: m.nimi, ottelut: 0, torjunnat: 0, paastetyt: 0, aika: 0 });
      s.ottelut++; s.torjunnat += m.torjunnat; s.paastetyt += m.paastetyt; s.aika += m.aika;
    }
  }
  const maalivahdit = Object.values(mvSumma).map((m) => ({ ...m,
    torjuntaProsentti: m.torjunnat + m.paastetyt ? m.torjunnat / (m.torjunnat + m.paastetyt) : null,
    paastetytKa: m.aika ? m.paastetyt / (m.aika / 3600) : null,
  })).sort((a, b) => b.aika - a.aika);

  const tilastot = { kausi: k, vire, kuntopuntari, koti, vieras, keskinaiset, vastustaja, ennuste: ennusteTaulukko,
    pisteerot, kaavio, porssi, maalivahdit, yvav };
  const tRef = db.doc('kooste/tilastot');
  const { paivitetty: _p, ...vanhatT } = (await tRef.get()).data() || {};
  if (vakaa(vanhatT) !== vakaa(tilastot)) { await tRef.set({ ...tilastot, paivitetty: Date.now() }); console.log('Tilastot tallennettu.'); }
}
