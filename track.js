// Saves the model's predictions for upcoming matches into track.json, so the app
// can later check them against real results (the "Track record" section).
// Run by update.py every morning, before kick-off. Each run overwrites the saved
// prediction for matches that haven't started yet, so the record always holds the
// last prediction made before the game.
//
//   node track.js                      normal use
//   node track.js --now 2026-10-10T09:00   pretend it's that time (for testing / backfilling a day)
process.env.TZ = "Europe/London";
const fs = require("fs"), path = require("path");
const ROOT = __dirname;
const { predict } = require(path.join(ROOT, "model.js"));

const args = process.argv.slice(2);
const now = args.includes("--now") ? Date.parse(args[args.indexOf("--now") + 1]) : Date.now();
const HORIZON = 8 * 86400000; // only save matches in the next 8 days
const r3 = x => Math.round(x * 1000) / 1000;
const load = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), "utf8")); } catch (e) { return d; } };

const track = load("track.json", {});
let saved = 0;
for (const lg of ["E0", "E1", "E2", "E3"]) {
  const res = load(`results_${lg}.json`, []), fix = load(`fixtures_${lg}.json`, []);
  if (!res.length) continue;
  const ms = res.map(r => ({ t: Date.parse(r[0]), h: r[1], a: r[2], hg: r[3], ag: r[4], hst: r[5], ast: r[6] })).sort((x, y) => x.t - y.t);
  const asOf = new Date(ms[ms.length - 1].t + 86400000);
  const played = new Set(res.map(r => `${r[0]}|${r[1]}|${r[2]}`));
  for (const [, d, h, a] of fix) {
    const ko = Date.parse(d);
    if (!(ko > now && ko < now + HORIZON)) continue;     // already started, or too far ahead
    if (played.has(`${d.slice(0, 10)}|${h}|${a}`)) continue;
    const p = predict(ms, h, a, asOf);
    if (!p) continue;
    track[`${lg}|${d}|${h}|${a}`] = [p.pOver, p.pBtts, p.pH, p.pD, p.pA, p.pHB, p.pAB, p.pHO, p.pAO].map(r3);
    saved++;
  }
}
// tidy: keep keys in date order so the file diffs cleanly
const sorted = {};
for (const k of Object.keys(track).sort((x, y) => x.split("|")[1].localeCompare(y.split("|")[1]) || x.localeCompare(y))) sorted[k] = track[k];
fs.writeFileSync(path.join(ROOT, "track.json"), JSON.stringify(sorted));
console.log(`  saved predictions for ${saved} upcoming matches (${Object.keys(sorted).length} in the record)`);
