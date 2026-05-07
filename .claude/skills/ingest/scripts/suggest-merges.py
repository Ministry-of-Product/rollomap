#!/usr/bin/env python3
"""
Scan the rollomap DB for likely-duplicate person records and emit a JSON
report. Use after an ingest run to surface near-duplicates the matcher
missed (typos, diacritics, nickname/full-name pairs, etc.).

Heuristics:
  - same first name + first 3 chars of last name (catches "Polak"/"Polyak")
  - same email (across primary or known_emails)
  - same display_name
  - normalized-no-diacritic display_name match

Output: JSON to stdout (or --out) with `pairs` array, each item =
  {"reason", "a": {id, display_name, company, email}, "b": {...}}

Usage:
    suggest-merges.py [--api http://localhost:4000/api/people] [--out path]
"""
import argparse, json, sys, unicodedata, urllib.request
from collections import defaultdict


def deaccent(s):
    if not s:
        return ""
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def fetch_db(api):
    base = api.rstrip("/")
    with urllib.request.urlopen(f"{base}?limit=500", timeout=10) as r:
        return json.loads(r.read())["people"]


def shortened(p):
    return {
        "id": p["id"],
        "display_name": p["display_name"],
        "company": p.get("company"),
        "email": p.get("primary_email"),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--api", default="http://localhost:4000/api/people")
    ap.add_argument("--out", help="write JSON here (default stdout)")
    args = ap.parse_args()

    people = fetch_db(args.api)
    pairs = []
    seen = set()

    def add_pair(a, b, reason):
        if a["id"] == b["id"]:
            return
        key = tuple(sorted([a["id"], b["id"]])) + (reason,)
        if key in seen:
            return
        seen.add(key)
        pairs.append({"reason": reason, "a": shortened(a), "b": shortened(b)})

    # 1. same first name + last[:3]
    buckets = defaultdict(list)
    for p in people:
        toks = (p["display_name"] or "").split()
        if len(toks) >= 2:
            buckets[(toks[0].lower(), toks[1][:3].lower())].append(p)
    for v in buckets.values():
        if len(v) > 1:
            for i in range(len(v)):
                for j in range(i + 1, len(v)):
                    add_pair(v[i], v[j], "first_name+last_prefix")

    # 2. same display_name (case insensitive)
    by_name = defaultdict(list)
    for p in people:
        by_name[(p["display_name"] or "").strip().lower()].append(p)
    for v in by_name.values():
        if len(v) > 1:
            for i in range(len(v)):
                for j in range(i + 1, len(v)):
                    add_pair(v[i], v[j], "exact_display_name")

    # 3. de-accented display_name match
    by_deaccent = defaultdict(list)
    for p in people:
        by_deaccent[deaccent((p["display_name"] or "").strip().lower())].append(p)
    for v in by_deaccent.values():
        if len(v) > 1:
            for i in range(len(v)):
                for j in range(i + 1, len(v)):
                    add_pair(v[i], v[j], "deaccented_match")

    # 4. shared email (primary or known_emails)
    by_email = defaultdict(list)
    for p in people:
        emails = set()
        if p.get("primary_email"):
            emails.add(p["primary_email"].lower().strip())
        for e in (p.get("known_emails") or []):
            if e:
                emails.add(e.lower().strip())
        for e in emails:
            by_email[e].append(p)
    for e, v in by_email.items():
        if len(v) > 1:
            for i in range(len(v)):
                for j in range(i + 1, len(v)):
                    add_pair(v[i], v[j], f"shared_email:{e}")

    out = {"pairs": pairs, "total_people": len(people), "pair_count": len(pairs)}
    payload = json.dumps(out, indent=2)
    if args.out:
        with open(args.out, "w") as f:
            f.write(payload)
    else:
        print(payload)
    print(f"suggest-merges: {len(pairs)} candidate pair(s) across {len(people)} people", file=sys.stderr)


if __name__ == "__main__":
    main()
