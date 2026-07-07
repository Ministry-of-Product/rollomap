#!/usr/bin/env python3
"""
Extract dated meeting / pitch sections from a journal-style text file and
write them to RolloMap as `interaction` rows linked to participants.

Designed for retrospective books / meeting journals where each meeting has a
header like:

    Feb 16, 2015: Alex Rivera
    March 7, 2015: Jamie Torres
    Feb 25, 2015: Sam Chen + Jordan Lee
    October 21, 2015: Sam Chen, Taylor Brooks
    August 27, 2015: Morgan Diaz (Acme Corp)
    July 30, 2015: Met with Casey @ Example Inc

The script:
  1. Finds all section headers matching `<Month> <Day>, <Year>: <Attendee(s)>`.
  2. Parses one or more attendee names from the suffix.
  3. Resolves each attendee against the existing DB (exact, fuzzy first+last-
     token, or as a substring of an existing display_name). If unresolved,
     CREATEs a stub person with `how_known = "<source-label> on <date>."`.
  4. Slices out the section body up to the next header.
  5. POSTs an `interaction` (type=meeting) with participant_ids, occurred_at,
     a one-line summary, and the body.
  6. Optionally adds the interaction to a topic via the participants' topic
     attachments (topics on interactions get folded back via add_interaction
     in MCP, but the REST route stores them in the `topics` JSONB column).

Skips:
  - Headers with no attendee suffix (pure-journal entries with no attendee,
    e.g. `January 5, 2015`).
  - Retrospective sections explicitly marked (e.g. `"Retrospect"`,
    `"retrospection"`, `"Retrospective"`).
  - Headers whose attendee field is a generic noun ("Cap Table", "Minutes",
    "Pitch Clinic", etc.) — those are added by --skip-attendees, or come from
    the workspace profile's `journalSkipPhrases` (see fetch_skip_phrases()).

Usage:
    extract-dated-interactions.py <text-file> \\
        --topic Fundraising \\
        --source-label "seed round" \\
        --interaction-type meeting \\
        --log /tmp/interactions_log.json \\
        [--api http://localhost:4000/api] \\
        [--dry-run] \\
        [--skip-attendee Geoff] [--skip-attendee "Cap Table"] ...
"""
import argparse, json, re, sys, urllib.error, urllib.request
from datetime import datetime, timezone

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

HEADER_RE = re.compile(
    r"^(?P<mon>[A-Z][a-z]+\.?)\s+(?P<day>\d{1,2}),?\s+(?P<year>\d{4})"
    r"(?:\s*[:\-–—]\s*(?P<rest>.+))?$"
)

# Suffix patterns to strip from a candidate name token
NAME_STRIP_PATTERNS = [
    re.compile(r"^Met with\s+", re.I),
    re.compile(r"^Meeting with\s+", re.I),
    re.compile(r"\s+Meeting$", re.I),
    re.compile(r"\s+\(.*\)$"),          # trailing "(Arvato)" / "(He/Him)"
    re.compile(r"\s+@\s+.*$"),          # "Casey @ Example Inc" → "Casey"
    re.compile(r"\s+of\s+[A-Z].*$"),    # "Diego of Algorithmia" → "Diego"
    re.compile(r"\s+(eDiscovery|Pitch|Talk|Call|Retrospective|Retrospection|Retrospect|"
               r"Meeting)\s+expert.*$", re.I),
    re.compile(r"\s+(eDiscovery|expert|Talk|Pitch|Retrospective|Retrospection|Retrospect|"
               r"Clinic|Conference|response with .*|with .*)$", re.I),
    re.compile(r":\s+.*$"),             # "Randal Lucas: Voyager & Lighter Capital" → "Randal Lucas"
]

# If the original `rest` matches one of these patterns, skip the whole header —
# it's a journal-author-only section, retrospective, or event title (no
# attendees). Kept intentionally small and generic (universal business-
# meeting/journal nouns only); source-specific titles belong in the
# workspace profile's `journalSkipPhrases` field (see fetch_skip_phrases()),
# not hardcoded here.
NON_PERSON_REST_PATTERNS = [
    re.compile(r"\b(Conference|Clinic|Pitch Clinic|Plan Review|"
               r"Retrospect|Retrospection|Retrospective|"
               r"Cap Table|Minutes|"
               r"Sales pain|pain point|"
               r"Self Eval|personal journal|Evaluation and decisions)\b", re.I),
]

# A candidate name must look like a real person — every token starts with an
# uppercase letter, tokens are letters / apostrophes / hyphens / periods only.
NAME_TOKEN_RE = re.compile(r"^[A-Z][a-zA-Z'.\-]*$")


DOT_LEADER_RE = re.compile(r"\s*\.{3,}\s*\d+\s*$")


def parse_header(line):
    m = HEADER_RE.match(line.strip())
    if not m:
        return None
    mon = m.group("mon").rstrip(".").lower()
    if mon not in MONTHS:
        return None
    try:
        dt = datetime(int(m.group("year")), MONTHS[mon], int(m.group("day")), 12, 0, 0, tzinfo=timezone.utc)
    except ValueError:
        return None
    rest = (m.group("rest") or "").strip()
    # Skip TOC entries — they end with dot-leaders + page number
    if DOT_LEADER_RE.search(rest) or "...." in rest:
        return None
    return {"date": dt, "rest": rest, "raw": line.strip()}


def split_attendees(rest, skip_attendees):
    """Return a list of cleaned candidate person names from the suffix."""
    if not rest:
        return []
    # Skip the whole header if the original rest matches an event/journal pattern
    skip_lower = {a.lower() for a in skip_attendees}
    if rest.lower() in skip_lower:
        return []
    if any(p.search(rest) for p in NON_PERSON_REST_PATTERNS):
        return []
    # Split on + or ,
    raw = re.split(r"\s*[+,]\s*", rest)
    out = []
    for cand in raw:
        # Strip any trailing colon-clause first ("Randal Lucas: Voyager &..." → "Randal Lucas")
        cand = cand.split(":")[0].strip() if ":" in cand else cand
        for p in NAME_STRIP_PATTERNS:
            cand = p.sub("", cand).strip()
        if not cand or cand.lower() in skip_lower:
            continue
        # Strip trailing role descriptors token-wise
        toks = cand.split()
        while toks and toks[-1].lower() in {"call", "talk", "meeting", "expert", "pitch",
                                             "clinic", "conference", "retrospective",
                                             "retrospection", "retrospect", "discussion"}:
            toks.pop()
        if len(toks) < 2:
            continue
        # Every token must look like a proper-name token (capitalized letters/'/-/.)
        if not all(NAME_TOKEN_RE.match(t) for t in toks):
            continue
        out.append(" ".join(toks))
    return out


def fetch_db_people(api):
    with urllib.request.urlopen(f"{api}/people?limit=500", timeout=10) as r:
        return json.loads(r.read())["people"]


def fetch_skip_phrases(api):
    """Best-effort fetch of the workspace profile's `journalSkipPhrases`.

    Personal / source-specific journal section titles (things like a
    particular deal-flow group's name, or a one-off "never sent" entry)
    live in the owner's profile rather than hardcoded here. If the API is
    unreachable or the profile has none set, fall back to an empty list —
    callers union this with the small generic default and any
    --skip-attendee values, so a fetch failure never breaks the script.
    """
    try:
        with urllib.request.urlopen(f"{api}/profile", timeout=10) as r:
            profile = json.loads(r.read())["profile"]
        return [p for p in (profile.get("journalSkipPhrases") or []) if p]
    except Exception:
        return []


def http_json(method, url, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def name_tokens(name):
    return [t for t in re.split(r"\s+", (name or "").strip()) if t]


def build_lookups(db):
    by_name = {}
    by_first_lasttoken = {}
    by_alias = {}
    for p in db:
        by_name.setdefault(p["display_name"].strip().lower(), []).append(p)
        toks = name_tokens(p["display_name"])
        if len(toks) >= 2:
            key = (toks[0].lower(), re.sub(r"[^a-z]", "", toks[1].lower()))
            by_first_lasttoken.setdefault(key, []).append(p)
        for a in (p.get("aliases") or []):
            by_alias.setdefault(a.strip().lower(), []).append(p)
    return by_name, by_first_lasttoken, by_alias


def resolve_or_create(name, lookups, api, source_label, source_date, dry_run, log):
    by_name, by_first_lasttoken, by_alias = lookups
    nlow = name.lower()
    if nlow in by_name and len(by_name[nlow]) == 1:
        return by_name[nlow][0]["id"], "exact_name"
    if nlow in by_alias and len(by_alias[nlow]) == 1:
        return by_alias[nlow][0]["id"], "alias"
    toks = name_tokens(name)
    if len(toks) >= 2:
        key = (toks[0].lower(), re.sub(r"[^a-z]", "", toks[1].lower()))
        cands = by_first_lasttoken.get(key, [])
        if len(cands) == 1:
            return cands[0]["id"], "fuzzy_first_lasttoken"
    # Not found — create
    body = {
        "display_name": name,
        "how_known": f"Met during {source_label} on {source_date.strftime('%b %d, %Y')}.",
    }
    if dry_run:
        log["would_create_people"].append({"name": name, "from_date": source_date.isoformat()})
        return None, "would_create"
    result = http_json("POST", f"{api}/people", body)
    pid = result["person"]["id"]
    log["created_people"].append({"id": pid, "name": name})
    # Update lookups so subsequent meetings dedupe against this new person
    by_name.setdefault(nlow, []).append(result["person"])
    if len(toks) >= 2:
        key = (toks[0].lower(), re.sub(r"[^a-z]", "", toks[1].lower()))
        by_first_lasttoken.setdefault(key, []).append(result["person"])
    return pid, "created"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("text_file")
    ap.add_argument("--topic", action="append", default=[], help="Topic name(s) to attach to each interaction (repeatable)")
    ap.add_argument("--source-label", default="meeting source", help="Label used in created-person how_known and in summary")
    ap.add_argument("--interaction-type", default="meeting")
    ap.add_argument("--api", default="http://localhost:4000/api")
    ap.add_argument("--log", default="/tmp/interactions_log.json")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-attendee", action="append", default=[], help="Skip headers whose attendee equals this (repeatable)")
    ap.add_argument("--max-body-chars", type=int, default=8000)
    args = ap.parse_args()

    with open(args.text_file, encoding="utf-8") as f:
        lines = f.readlines()

    # Pass 1: identify all section headers (line indices)
    sections = []
    for i, line in enumerate(lines):
        h = parse_header(line)
        if h:
            sections.append({"line": i, "header": h})
    # Add a sentinel for the end
    sections.append({"line": len(lines), "header": None})

    db = fetch_db_people(args.api)
    lookups = build_lookups(db)

    # Union: --skip-attendee values (CLI) + journalSkipPhrases (profile, best-effort)
    skip_attendees = list(args.skip_attendee) + fetch_skip_phrases(args.api)

    log = {
        "source_file": args.text_file,
        "source_label": args.source_label,
        "topics": args.topic,
        "interactions_created": [],
        "skipped": [],
        "created_people": [],
        "would_create_people": [],
        "errors": [],
    }

    for idx, sec in enumerate(sections[:-1]):
        h = sec["header"]
        attendees = split_attendees(h["rest"], skip_attendees)
        if not attendees:
            log["skipped"].append({
                "raw_header": h["raw"],
                "reason": "no_attendees" if h["rest"] else "no_suffix",
            })
            continue

        # Slice body
        start = sec["line"] + 1
        end = sections[idx + 1]["line"]
        body = "".join(lines[start:end]).strip()
        if len(body) > args.max_body_chars:
            body = body[:args.max_body_chars] + "\n\n…[truncated]"

        # Resolve attendees
        pids = []
        unresolved = []
        for a in attendees:
            try:
                pid, how = resolve_or_create(a, lookups, args.api, args.source_label, h["header"]["date"] if False else h["date"], args.dry_run, log)
                if pid:
                    pids.append(pid)
                else:
                    unresolved.append(a)
            except urllib.error.HTTPError as e:
                log["errors"].append({"name": a, "stage": "resolve", "http": e.code, "body": e.read().decode("utf-8")})

        if args.dry_run:
            print(f"DRY  [{h['date'].date()}] {' + '.join(attendees):60s}  pids={len(pids)}  unresolved={unresolved or '-'}")
            continue

        if not pids:
            log["skipped"].append({"raw_header": h["raw"], "reason": "no_resolved_pids"})
            continue

        title = f"{args.source_label} — {h['date'].strftime('%b %d, %Y')} — {' + '.join(attendees)}"
        summary = f"Met with {' + '.join(attendees)} on {h['date'].strftime('%B %d, %Y')} during {args.source_label}."
        ix_body = {
            "interaction_type": args.interaction_type,
            "title": title,
            "summary": summary,
            "body": body,
            "occurred_at": h["date"].isoformat(),
            "topics": args.topic,
            "participant_ids": pids,
        }
        try:
            result = http_json("POST", f"{args.api}/interactions", ix_body)
            log["interactions_created"].append({
                "id": result["interaction"]["id"],
                "title": title,
                "occurred_at": result["interaction"]["occurred_at"],
                "participant_ids": pids,
                "raw_header": h["raw"],
            })
            print(f"OK   [{h['date'].date()}] {title}")
        except urllib.error.HTTPError as e:
            log["errors"].append({"raw_header": h["raw"], "http": e.code,
                                  "body": e.read().decode("utf-8")[:500]})
            print(f"ERR  [{h['date'].date()}] {title}: HTTP {e.code}", file=sys.stderr)

    # Attach topic confirmations on participants (each participant gets the topic)
    if args.topic and not args.dry_run:
        seen_pids = set()
        for ix in log["interactions_created"]:
            for pid in ix["participant_ids"]:
                if pid in seen_pids:
                    continue
                seen_pids.add(pid)
                for topic in args.topic:
                    try:
                        http_json("POST", f"{args.api}/people/{pid}/topics",
                                  {"topic_name": topic, "confidence": 0.85, "user_confirmed": True})
                    except Exception as e:
                        log["errors"].append({"pid": pid, "stage": "topic_attach", "error": str(e)})

    with open(args.log, "w") as f:
        json.dump(log, f, indent=2, default=str)

    print(f"\ninteractions={len(log['interactions_created'])} "
          f"new_people={len(log['created_people'])} "
          f"skipped={len(log['skipped'])} errors={len(log['errors'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
