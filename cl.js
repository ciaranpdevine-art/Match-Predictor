// Champions League model.
//
// Each club gets attack/defence ratings from its own domestic league (same idea as the
// main model: time-weighted, shrunk toward the league average, blending goals with shots
// on target where available). Because leagues differ in strength, every league also gets
// a "quality" score, fitted on past Champions League results, so a team that dominates a
// weaker league isn't treated like one that dominates the Premier League.
//
//   node cl.js              fit on finished CL seasons, write cl.json for the app
//   node cl.js --backtest   test on past CL seasons (fit on one, predict the other)
process.env.TZ = "Europe/London";
const fs = require("fs"), path = require("path");
const ROOT = __dirname, EU = path.join(ROOT, "europe");
const DAY = 86400000, HALF_LIFE = +(process.env.CL_HL || 365), SHRINK = +(process.env.CL_SHRINK || 12), BLEND = 0.7;
const RIDGE = +(process.env.CL_RIDGE || 15), GPEN = +(process.env.CL_GPEN || 40);
// BTTS: the raw model over-predicts it in the Champions League, so blend halfway toward the historical CL rate (tested on 2024 and 2025)
const BTTS_K = 0.5; // penalties: league quality toward 0, γ toward 1

// fixturedownload name -> football-data name (only where they differ)
const ALIAS = {
  "AEK Athens": "AEK", "Athletic Club": "Ath Bilbao", "Atleti": "Ath Madrid", "B. Dortmund": "Dortmund",
  "Bayern München": "Bayern Munich", "Bodø/Glimt": "Bodo/Glimt", "Copenhagen": "FC Copenhagen",
  "Fenerbahçe": "Fenerbahce", "Frankfurt": "Ein Frankfurt", "Leipzig": "RB Leipzig", "Man Utd": "Man United",
  "Olympiacos": "Olympiakos", "PSV": "PSV Eindhoven", "Paris": "Paris SG", "Real Betis": "Betis",
  "Sporting CP": "Sp Lisbon", "Union SG": "St. Gilloise",
};
const LEAGUE_NAMES = { E0: "England", SP1: "Spain", D1: "Germany", I1: "Italy", F1: "France", N1: "Netherlands",
  P1: "Portugal", B1: "Belgium", SC0: "Scotland", T1: "Turkey", G1: "Greece", AUT: "Austria", SWZ: "Switzerland",
  DNK: "Denmark", NOR: "Norway", POL: "Poland", ROU: "Romania", SWE: "Sweden", OTHER: "Other" };

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return d; } };

// ---------- domestic data ----------
function loadDomestic() {
  const leagues = {};
  const add = (lg, rows) => { leagues[lg] = rows.map(r => ({ t: Date.parse(r[0]), d: r[0], h: r[1], a: r[2], hg: r[3], ag: r[4], hst: r[5], ast: r[6] })).sort((x, y) => x.t - y.t); };
  add("E0", load(path.join(ROOT, "results_E0.json"), []));
  for (const f of fs.readdirSync(EU)) if (f.startsWith("results_")) add(f.slice(8, -5), load(path.join(EU, f), []));
  // which league each club plays in (most recent appearance wins)
  const home = {};
  for (const lg in leagues) for (const m of leagues[lg]) for (const t of [m.h, m.a]) if (!home[t] || home[t].t < m.t) home[t] = { lg, t: m.t };
  return { leagues, leagueOf: t => home[t] ? home[t].lg : null };
}

// attack/defence for one team relative to its league average, using games before asOf
function rating(D, team, asOf) {
  const lg = D.leagueOf(team);
  if (!lg) return { lg: "OTHER", att: 1, def: 1, n: 0 };
  const ms = D.leagues[lg];
  let W = 0, G = 0, S = 0, SW = 0, gf = 0, ga = 0, sf = 0, sa = 0, w = 0, sw = 0;
  for (const m of ms) {
    if (m.t >= asOf) break;
    const k = Math.pow(0.5, (asOf - m.t) / DAY / HALF_LIFE);
    const shots = m.hst != null && m.ast != null;
    W += 2 * k; G += k * (m.hg + m.ag);
    if (shots) { SW += 2 * k; S += k * (m.hst + m.ast); }
    if (m.h === team || m.a === team) {
      const home = m.h === team;
      w += k; gf += k * (home ? m.hg : m.ag); ga += k * (home ? m.ag : m.hg);
      if (shots) { sw += k; sf += k * (home ? m.hst : m.ast); sa += k * (home ? m.ast : m.hst); }
    }
  }
  if (!W) return { lg, att: 1, def: 1, n: 0 };
  const g = G / W, s = SW ? S / SW : null;                       // league goals and shots per team per game
  const shrink = (x, n, avg) => ((x + SHRINK * avg) / (n + SHRINK)) / avg;
  let att = shrink(gf, w, g), def = shrink(ga, w, g);
  if (s && sw > 0) {
    att = BLEND * shrink(sf, sw, s) + (1 - BLEND) * att;
    def = BLEND * shrink(sa, sw, s) + (1 - BLEND) * def;
  }
  return { lg, att, def, n: w };
}

// ---------- Champions League data ----------
function loadCL() {
  const seasons = {};
  for (const f of fs.readdirSync(EU)) if (/^cl_\d+\.json$/.test(f)) {
    const y = +f.slice(3, 7);
    seasons[y] = load(path.join(EU, f), []).map(r => ({ round: r[0], ko: r[1], t: Date.parse(r[1]), H: r[2], A: r[3], h: ALIAS[r[2]] || r[2], a: ALIAS[r[3]] || r[3], hg: r[4], ag: r[5] }));
  }
  return seasons;
}

// ---------- model ----------
// log λ_home = mh + γ·log(attH·defA) + (qH − qA);  log λ_away = ma + γ·log(attA·defH) + (qA − qH)
const LGS = Object.keys(LEAGUE_NAMES);
function features(D, m) {
  const rH = rating(D, m.h, m.t), rA = rating(D, m.a, m.t);
  return { rH, rA, xH: Math.log(rH.att * rA.def), xA: Math.log(rA.att * rH.def) };
}
function lambdas(P, f) {
  const qH = P.q[f.rH.lg] || 0, qA = P.q[f.rA.lg] || 0;
  return [Math.exp(P.mh + P.g * f.xH + qH - qA), Math.exp(P.ma + P.g * f.xA + qA - qH)];
}
function fit(rows) {
  // rows: [{f, hg, ag}] ; Poisson likelihood with a ridge penalty on league quality (England fixed at 0)
  const P = { mh: Math.log(1.6), ma: Math.log(1.3), g: 1, q: Object.fromEntries(LGS.map(l => [l, 0])) };
  const lr = 0.02;
  for (let it = 0; it < 4000; it++) {
    const gq = Object.fromEntries(LGS.map(l => [l, 0])); let gmh = 0, gma = 0, gg = 0;
    for (const { f, hg, ag } of rows) {
      const [lh, la] = lambdas(P, f);
      const eh = hg - lh, ea = ag - la;                         // d logL / d log λ
      gmh += eh; gma += ea; gg += eh * f.xH + ea * f.xA;
      gq[f.rH.lg] += eh - ea; gq[f.rA.lg] += ea - eh;
    }
    const n = rows.length;
    P.mh += lr * gmh / n; P.ma += lr * gma / n; P.g += lr * (gg - GPEN * (P.g - 1)) / n;
    for (const l of LGS) if (l !== "E0") P.q[l] += lr * (gq[l] - RIDGE * P.q[l]) / n * 4;
  }
  return P;
}
function probs(lh, la) {
  const po = (l, k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * Math.pow(l, k) / f; };
  const ph = [], pa = [];
  for (let i = 0; i <= 10; i++) { ph.push(po(lh, i)); pa.push(po(la, i)); }
  let pH = 0, pD = 0, pA = 0, pHB = 0, pAB = 0, pHO = 0, pAO = 0;
  const dist = Array(11).fill(0);
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const p = ph[i] * pa[j], both = i > 0 && j > 0, over = i + j >= 3;
    if (i + j <= 10) dist[i + j] += p;
    if (i > j) { pH += p; if (both) pHB += p; if (over) pHO += p; }
    else if (i < j) { pA += p; if (both) pAB += p; if (over) pAO += p; }
    else pD += p;
  }
  const pOver = 1 - dist[0] - dist[1] - dist[2], pBtts = (1 - Math.exp(-lh)) * (1 - Math.exp(-la));
  return { xh: lh, xa: la, tot: lh + la, pOver, pBtts, dist, pH, pD, pA, pHB, pAB, pHO, pAO };
}

module.exports = { loadDomestic, loadCL, features, fit, lambdas, probs, rating, LEAGUE_NAMES, ALIAS };

// ---------- command line ----------
if (require.main === module) {
  const D = loadDomestic(), CL = loadCL();
  const played = s => (CL[s] || []).filter(m => m.hg != null);
  const rowsOf = ms => ms.map(m => ({ m, f: features(D, m), hg: m.hg, ag: m.ag }));
  if (process.argv.includes("--backtest")) {
    const years = Object.keys(CL).map(Number).sort();
    for (const [trainY, testY] of [[years[0], years[1]], [years[1], years[0]]]) {
      const train = rowsOf(played(trainY)), test = rowsOf(played(testY));
      const P = fit(train), flat = { mh: Math.log(train.reduce((s, r) => s + r.hg, 0) / train.length), ma: Math.log(train.reduce((s, r) => s + r.ag, 0) / train.length), g: 0, q: {} };
      const noLeague = fit(train.map(r => ({ ...r, f: { ...r.f, rH: { ...r.f.rH, lg: "E0" }, rA: { ...r.f.rA, lg: "E0" } } })));
      const baseO = train.filter(r => r.hg + r.ag >= 3).length / train.length, baseB = train.filter(r => r.hg > 0 && r.ag > 0).length / train.length;
      const score = (P, strip) => { let bo = 0, bb = 0, bf = 0, bfb = 0, br = 0, brf = 0;
        const n = test.length, base = [0, 0, 0]; train.forEach(r => base[r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2]++);
        for (const r of test) { const f = strip ? { ...r.f, rH: { ...r.f.rH, lg: "E0" }, rA: { ...r.f.rA, lg: "E0" } } : r.f;
          const p = probs(...lambdas(P, f)), o = r.hg + r.ag >= 3 ? 1 : 0, b = r.hg > 0 && r.ag > 0 ? 1 : 0;
          const y = [r.hg > r.ag, r.hg === r.ag, r.hg < r.ag].map(Number), q = [p.pH, p.pD, p.pA];
          bo += (p.pOver - o) ** 2; bb += (p.pBtts - b) ** 2; bf += (baseO - o) ** 2; bfb += (baseB - b) ** 2;
          br += q.reduce((s, v, i) => s + (v - y[i]) ** 2, 0); brf += base.reduce((s, v, i) => s + (v / train.length - y[i]) ** 2, 0); }
        return { over: (bo / n).toFixed(4), btts: (bb / n).toFixed(4), result: (br / n).toFixed(4), flatOver: (bf / n).toFixed(4), flatBtts: (bfb / n).toFixed(4), flatResult: (brf / n).toFixed(4) }; };
      console.log(`train ${trainY} (${train.length}) -> test ${testY} (${test.length})`);
      console.log("  with league strength:", score(P, false));
      console.log("  no league strength:  ", score(noLeague, true));
      console.log("  fitted γ", P.g.toFixed(2), "league quality:", Object.entries(P.q).filter(([, v]) => Math.abs(v) > 0.01).sort((a, b) => b[1] - a[1]).map(([l, v]) => `${l} ${v.toFixed(2)}`).join(", "));
    }
    return;
  }
  // fit on every finished season plus played games this season, then predict upcoming fixtures
  const years = Object.keys(CL).map(Number).sort(), cur = years[years.length - 1];
  const train = rowsOf(years.flatMap(y => played(y)));
  const P = fit(train);
  const baseB = train.filter(r => r.hg > 0 && r.ag > 0).length / train.length;
  const out = { updated: new Date().toISOString().slice(0, 16), quality: P.q, trainGames: train.length, matches: [] };
  for (const m of CL[cur]) {
    const f = features(D, m), p = probs(...lambdas(P, f));
    const raw = p.pBtts; p.pBtts = baseB + BTTS_K * (raw - baseB);
    const sc = p.pBtts / raw; p.pHB *= sc; p.pAB *= sc;           // keep win & BTTS consistent with the adjusted BTTS
    const r3 = x => Math.round(x * 1000) / 1000;
    out.matches.push({ round: m.round, ko: m.ko, h: m.H, a: m.A, hg: m.hg, ag: m.ag,
      lh: LEAGUE_NAMES[f.rH.lg], la: LEAGUE_NAMES[f.rA.lg], thinH: !f.rH.n, thinA: !f.rA.n,
      p: { xh: r3(p.xh), xa: r3(p.xa), pOver: r3(p.pOver), pBtts: r3(p.pBtts), pH: r3(p.pH), pD: r3(p.pD), pA: r3(p.pA),
           pHB: r3(p.pHB), pAB: r3(p.pAB), pHO: r3(p.pHO), pAO: r3(p.pAO), dist: p.dist.slice(0, 7).map(r3) } });
  }
  fs.writeFileSync(path.join(ROOT, "cl.json"), JSON.stringify(out));
  console.log(`  Champions League: ${out.matches.filter(m => m.hg == null).length} upcoming matches predicted (fitted on ${train.length} past CL games)`);
}
