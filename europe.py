"""Download data for the Champions League tab (run from update.py).

  - Domestic results for the main European leagues from football-data.co.uk
    (same format as results_E*.json: [date, home, away, hg, ag, hst, ast]),
    stored in europe/results_<code>.json. Past seasons are fetched once; the
    current season is refreshed every run.
  - Extra leagues (goals only, no shots) from football-data's "new" files.
  - Champions League fixtures and results from fixturedownload.com,
    stored in europe/cl_<startyear>.json as [round, local kick-off, home, away, hg, ag].
"""
import csv, io, json, os
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

UK = ZoneInfo("Europe/London")
# main leagues with shots on target
MAIN = {"SP1": "Spain", "D1": "Germany", "I1": "Italy", "F1": "France", "N1": "Netherlands",
        "P1": "Portugal", "B1": "Belgium", "SC0": "Scotland", "T1": "Turkey", "G1": "Greece"}
# extra leagues: goals only (football-data "new" format, one file holding every season)
EXTRA = {"AUT": "Austria", "SWZ": "Switzerland", "DNK": "Denmark", "NOR": "Norway", "POL": "Poland",
         "ROU": "Romania", "SWE": "Sweden"}
PAST_SEASONS = 3  # plus the current one


def run(fetch, log, root, season_year):
    out = os.path.join(root, "europe")
    os.makedirs(out, exist_ok=True)
    y = season_year
    codes = [f"{(y - k) % 100:02d}{(y - k + 1) % 100:02d}" for k in range(PAST_SEASONS, -1, -1)]

    for lg in MAIN:
        path = os.path.join(out, f"results_{lg}.json")
        have = json.load(open(path)) if os.path.exists(path) else []
        seen = {(r[0], r[1], r[2]) for r in have}
        added = 0
        for i, code in enumerate(codes):
            current = i == len(codes) - 1
            if have and not current and any(r[0][:4] in (f"20{code[:2]}",) for r in have):
                continue  # past season already stored
            try:
                text = fetch(f"https://www.football-data.co.uk/mmz4281/{code}/{lg}.csv")
            except Exception as e:
                log(f"  {lg} {code}: skipped ({type(e).__name__}: {e})")
                continue
            for r in csv.DictReader(io.StringIO(text)):
                d = _date(r.get("Date", ""))
                h, a = (r.get("HomeTeam") or "").strip(), (r.get("AwayTeam") or "").strip()
                v = [_num(r.get(k)) for k in ("FTHG", "FTAG", "HST", "AST")]
                if not d or not h or not a or None in v[:2]:
                    continue
                key = (d, h, a)
                if key in seen:
                    continue
                seen.add(key)
                have.append([d, h, a, *v])
                added += 1
        have.sort(key=lambda r: (r[0], r[1]))
        json.dump(have, open(path, "w"), separators=(",", ":"))
        log(f"  {lg}: {added} new, {len(have)} stored, latest {have[-1][0] if have else '-'}")

    for lg in EXTRA:
        path = os.path.join(out, f"results_{lg}.json")
        try:
            text = fetch(f"https://www.football-data.co.uk/new/{lg}.csv")
        except Exception as e:
            log(f"  {lg}: skipped ({type(e).__name__}: {e})")
            continue
        rows = []
        first = f"{y - PAST_SEASONS}-07-01"
        for r in csv.DictReader(io.StringIO(text)):
            d = _date(r.get("Date", ""))
            h, a = (r.get("Home") or "").strip(), (r.get("Away") or "").strip()
            hg, ag = _num(r.get("HG")), _num(r.get("AG"))
            if not d or d < first or not h or not a or hg is None or ag is None:
                continue
            rows.append([d, h, a, hg, ag, None, None])
        rows.sort(key=lambda r: (r[0], r[1]))
        json.dump(rows, open(path, "w"), separators=(",", ":"))
        log(f"  {lg}: {len(rows)} stored, latest {rows[-1][0] if rows else '-'}")

    for start in range(y - 2, y + 1):
        path = os.path.join(out, f"cl_{start}.json")
        if os.path.exists(path) and start < y:
            continue  # finished seasons don't change
        feed = None
        for slug in (f"champions-league-{start}", f"uefa-champions-league-{start}", f"ucl-{start}"):
            try:
                feed = json.loads(fetch(f"https://fixturedownload.com/feed/json/{slug}"))
                if feed:
                    break
            except Exception as e:
                last = e
        if not feed:
            log(f"  CL {start}: skipped ({type(last).__name__}: {last})")
            continue
        rows = []
        for m in feed:
            utc = datetime.strptime(m["DateUtc"].replace("Z", "").strip(), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            rows.append([m.get("RoundNumber"), utc.astimezone(UK).strftime("%Y-%m-%dT%H:%M"),
                         m["HomeTeam"].strip(), m["AwayTeam"].strip(), m.get("HomeTeamScore"), m.get("AwayTeamScore")])
        rows.sort(key=lambda r: r[1])
        json.dump(rows, open(path, "w"), separators=(",", ":"))
        played = sum(1 for r in rows if r[4] is not None)
        log(f"  CL {start}: {len(rows)} matches ({played} played)")


def _date(s):
    for fmt in ("%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(s.strip(), fmt).date().isoformat()
        except ValueError:
            pass
    return None


def _num(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None
