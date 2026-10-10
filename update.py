"""Refresh results, fixtures and odds, then rebuild index.html.

Run by the GitHub workflow every morning. It only needs the Python standard library.

    python update.py              download everything, then build
    python update.py --offline    build from the data files already in this folder
    python update.py --results-dir DIR --fixtures-dir DIR
                                          use local copies instead of downloading (for testing)

Every download is optional: if a site is down or a file looks wrong, that part
is skipped, the existing data is kept, and the site is still rebuilt.
"""
import csv, io, json, os, re, shutil, subprocess, sys, urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = ROOT  # every file sits in the top folder of the repo
UK = ZoneInfo("Europe/London")
LEAGUES = ["E0", "E1", "E2", "E3"]
# fixturedownload.com feed names for each league; the season year is added on
FEEDS = {"E0": "epl", "E1": "efl-championship", "E2": "efl-league-one", "E3": "efl-league-two"}

# Names fixturedownload uses that don't reduce to football-data's names automatically
ALIASES = {
    "Man Utd": "Man United", "Manchester United": "Man United", "Manchester City": "Man City",
    "Spurs": "Tottenham", "Tottenham Hotspur": "Tottenham", "Nottingham Forest": "Nott'm Forest",
    "Brighton & Hove Albion": "Brighton", "Brighton and Hove Albion": "Brighton",
    "Wolverhampton Wanderers": "Wolves", "West Bromwich Albion": "West Brom",
    "Queens Park Rangers": "QPR", "Preston North End": "Preston", "AFC Bournemouth": "Bournemouth",
    "MK Dons": "Milton Keynes Dons", "Peterborough United": "Peterboro", "Peterborough": "Peterboro",
    "Sheffield Wednesday": "Sheffield Weds", "Bristol Rovers": "Bristol Rvs",
}
SUFFIXES = [" City", " United", " Town", " Rovers", " Albion", " Athletic", " Wanderers",
            " County", " Argyle", " Stanley", " Alexandra", " Hotspur", " FC", " AFC"]


def log(*a):
    print(*a, flush=True)


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (match-predictor updater)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            pass


def load(name, default):
    p = os.path.join(DATA, name)
    return json.load(open(p)) if os.path.exists(p) else default


def save(name, obj):
    with open(os.path.join(DATA, name), "w") as f:
        json.dump(obj, f, separators=(",", ":"))


def season_code(today):
    """football-data's folder for the current season, e.g. 2627 for 2026/27."""
    y = today.year if today.month >= 7 else today.year - 1
    return f"{y % 100:02d}{(y + 1) % 100:02d}", y


def parse_date(s):
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s.strip(), fmt).date()
        except ValueError:
            pass
    return None


def num(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


# ---------- results (football-data.co.uk E0-E3.csv) ----------
def update_results(lg, text):
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows or "FTHG" not in rows[0] or "HST" not in rows[0]:
        log(f"  {lg}: file doesn't look like a football-data results file, skipped")
        return
    have = load(f"results_{lg}.json", [])
    seen = {(r[0], r[1], r[2]) for r in have}
    added = 0
    for r in rows:
        if r.get("Div", lg).strip() != lg:
            continue
        d = parse_date(r.get("Date", ""))
        vals = [num(r.get(k)) for k in ("FTHG", "FTAG", "HST", "AST")]
        h, a = (r.get("HomeTeam") or "").strip(), (r.get("AwayTeam") or "").strip()
        if not d or not h or not a or None in vals:
            continue
        key = (d.isoformat(), h, a)
        if key in seen:
            continue
        seen.add(key)
        have.append([d.isoformat(), h, a, *vals])
        added += 1
    have.sort(key=lambda r: (r[0], r[1]))
    save(f"results_{lg}.json", have)
    log(f"  {lg}: {added} new results, latest {have[-1][0] if have else 'none'}")


# ---------- fixtures (fixturedownload.com JSON feed) ----------
def team_names(lg):
    res = load(f"results_{lg}.json", [])
    if not res:
        return set()
    latest = res[-1][0]
    start = f"{int(latest[:4]) - (0 if latest[5:7] >= '07' else 1)}-07-01"
    return {t for r in res if r[0] >= start for t in (r[1], r[2])}


def map_name(n, names):
    n = n.strip()
    if n in names:
        return n
    if n in ALIASES and ALIASES[n] in names:
        return ALIASES[n]
    for s in SUFFIXES:
        if n.endswith(s) and n[: -len(s)] in names:
            return n[: -len(s)]
    return None


def update_fixtures(lg, text):
    feed = json.loads(text)
    names = team_names(lg)
    out, unknown = [], set()
    for m in feed:
        if m.get("HomeTeamScore") is not None:
            continue  # already played
        h, a = map_name(m["HomeTeam"], names), map_name(m["AwayTeam"], names)
        if not h: unknown.add(m["HomeTeam"])
        if not a: unknown.add(m["AwayTeam"])
        if not h or not a:
            continue
        utc = datetime.strptime(m["DateUtc"].replace("Z", "").strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        out.append([m["RoundNumber"], utc.astimezone(UK).strftime("%Y-%m-%dT%H:%M"), h, a])
    if unknown:
        log(f"  {lg}: team names not recognised {sorted(unknown)}, kept the existing fixture list")
        return
    if len(feed) < 100:
        log(f"  {lg}: feed only had {len(feed)} matches, kept the existing fixture list")
        return
    out.sort(key=lambda f: (f[1], f[2]))
    save(f"fixtures_{lg}.json", out)
    log(f"  {lg}: {len(out)} fixtures still to play")


# ---------- odds (football-data.co.uk fixtures.csv) ----------
def update_odds(text):
    rows = list(csv.DictReader(io.StringIO(text)))
    out = []
    for r in rows:
        lg = (r.get("Div") or "").strip()
        if lg not in LEAGUES:
            continue
        d = parse_date(r.get("Date", ""))
        o = r.get("Avg>2.5") or r.get("B365>2.5")
        u = r.get("Avg<2.5") or r.get("B365<2.5")
        try:
            o, u = float(o), float(u)
        except (TypeError, ValueError):
            continue
        if not d or o <= 1 or u <= 1:
            continue
        t = (r.get("Time") or "15:00").strip()[:5]
        out.append([lg, f"{d.isoformat()}T{t}", r["HomeTeam"].strip(), r["AwayTeam"].strip(), o, u])
    save("odds.json", out)
    log(f"  odds for {len(out)} upcoming matches")


# ---------- track record ----------
def save_predictions():
    """Save today's predictions (via the same JavaScript model the app uses) so they can be graded later."""
    node = shutil.which("node")
    if not node:
        log("  node not found, skipped")
        return
    out = subprocess.run([node, os.path.join(ROOT, "track.js")], capture_output=True, text=True,
                         env={**os.environ, "TZ": "Europe/London"}, timeout=300)
    log(out.stdout.strip() or out.stderr.strip())


# ---------- build ----------
def build():
    t = open(os.path.join(ROOT, "template.html"), encoding="utf-8").read()
    parts = {"__MODEL__": open(os.path.join(ROOT, "model.js"), encoding="utf-8").read(),
             "__ODDS__": json.dumps(load("odds.json", []), separators=(",", ":")),
             "__TRACK__": json.dumps(load("track.json", {}), separators=(",", ":"))}
    for lg in LEAGUES:
        parts[f"__RESULTS_{lg}__"] = json.dumps(load(f"results_{lg}.json", []), separators=(",", ":"))
        parts[f"__FIXTURES_{lg}__"] = json.dumps(load(f"fixtures_{lg}.json", []), separators=(",", ":"))
    for k, v in parts.items():
        t = t.replace(k, v)
    left = re.findall(r"__[A-Z0-9_]+__", t)
    if left:
        sys.exit(f"Build failed, placeholders not filled: {left}")
    with open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8") as f:
        f.write(t)
    log(f"Built index.html ({len(t) // 1024} KB)")


def step(label, fn):
    try:
        fn()
    except Exception as e:  # keep going: one bad download shouldn't stop the rest
        log(f"  {label}: skipped ({e})")


def main():
    args = sys.argv[1:]
    res_dir = args[args.index("--results-dir") + 1] if "--results-dir" in args else None
    fix_dir = args[args.index("--fixtures-dir") + 1] if "--fixtures-dir" in args else None
    if "--offline" not in args:
        code, year = season_code(datetime.now(UK))
        log(f"Results (season {code})")
        for lg in LEAGUES:
            src = (lambda lg=lg: open(os.path.join(res_dir, f"{lg}.csv"), encoding="utf-8-sig").read()) if res_dir \
                else (lambda lg=lg: fetch(f"https://www.football-data.co.uk/mmz4281/{code}/{lg}.csv"))
            step(lg, lambda lg=lg, src=src: update_results(lg, src()))
        log("Fixtures")
        for lg in LEAGUES:
            src = (lambda lg=lg: open(os.path.join(fix_dir, f"{lg}.json")).read()) if fix_dir \
                else (lambda lg=lg: fetch(f"https://fixturedownload.com/feed/json/{FEEDS[lg]}-{year}"))
            step(lg, lambda lg=lg, src=src: update_fixtures(lg, src()))
        log("Odds")
        if not res_dir:
            step("odds", lambda: update_odds(fetch("https://www.football-data.co.uk/fixtures.csv")))
        log("Track record")
        step("track", save_predictions)
    build()


if __name__ == "__main__":
    main()
