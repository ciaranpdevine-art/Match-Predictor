// Over 2.5 goals model: time-weighted, shrunk home/away ratings from goals and shots on target.
const HALF_LIFE = 500, SHRINK = 20, BLEND = 0.7; // BLEND = share of shots-on-target estimate
const DAY = 86400000;

function predict(matches, home, away, asOf) {
  const t = asOf.getTime();
  let W = 0, s = { hg: 0, ag: 0, hst: 0, ast: 0 };
  const H = { w: 0, hg: 0, ag: 0, hst: 0, ast: 0 }, A = { w: 0, hg: 0, ag: 0, hst: 0, ast: 0 };
  for (const m of matches) {
    if (m.t >= t) continue;
    const w = Math.pow(0.5, (t - m.t) / DAY / HALF_LIFE);
    W += w; s.hg += w * m.hg; s.ag += w * m.ag; s.hst += w * m.hst; s.ast += w * m.ast;
    if (m.h === home) { H.w += w; H.hg += w * m.hg; H.ag += w * m.ag; H.hst += w * m.hst; H.ast += w * m.ast; }
    if (m.a === away) { A.w += w; A.hg += w * m.hg; A.ag += w * m.ag; A.hst += w * m.hst; A.ast += w * m.ast; }
  }
  if (!W) return null;
  const lg = { hg: s.hg / W, ag: s.ag / W, hst: s.hst / W, ast: s.ast / W };
  const rate = (T, k) => ((T[k] + SHRINK * lg[k]) / (T.w + SHRINK)) / lg[k];
  // goals-based expected goals
  const gH = lg.hg * rate(H, "hg") * rate(A, "hg");
  const gA = lg.ag * rate(A, "ag") * rate(H, "ag");
  // shots-on-target based, converted at league conversion rate
  const sH = lg.hst * rate(H, "hst") * rate(A, "hst") * (lg.hg / lg.hst);
  const sA = lg.ast * rate(A, "ast") * rate(H, "ast") * (lg.ag / lg.ast);
  const xh = BLEND * sH + (1 - BLEND) * gH, xa = BLEND * sA + (1 - BLEND) * gA;
  const tot = xh + xa;
  const dist = [];
  let f = 1;
  for (let i = 0; i <= 10; i++) { if (i) f *= i; dist.push(Math.exp(-tot) * Math.pow(tot, i) / f); }
  const pOver = 1 - dist[0] - dist[1] - dist[2];
  // both teams to score from independent Poissons
  const pBtts = (1 - Math.exp(-xh)) * (1 - Math.exp(-xa));
  return { xh, xa, tot, pOver, pBtts, dist, homeGames: H.w, awayGames: A.w };
}

if (typeof module !== "undefined") module.exports = { predict };
