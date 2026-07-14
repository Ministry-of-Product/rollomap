#!/usr/bin/env python3
"""
Import a .vcf (vCard 2.1/3.0) contacts export into rollomap via the REST API.

Parses vCards with the stdlib (line unfolding, quoted-printable, base64 PHOTO
blocks skipped), merges duplicate cards within the file (shared email, then
exact display name), then dedupes against the DB the same way merge-csv.py
does (email -> exact display_name -> fuzzy first+last-token) and PATCHes vs
POSTs accordingly.

Field mapping: FN/N -> display_name, EMAIL -> primary_email/known_emails,
TEL -> known_phones, ORG -> company, TITLE -> title, URL with linkedin.com ->
linkedin_url. ADR / non-LinkedIn URLs / X-ANDROID-CUSTOM relations are
preserved in summary (no schema fields yet — see MIN-1237). Dead
google.com/profiles (Google+) URLs are dropped.

Cards with no name (email-only autosaves) and business cards (org name, no
person name) are skipped and listed in the log.

Usage:
    import-vcf.py contacts.vcf \
        --how-known "Imported from phone contacts." \
        --source-label "phone contacts" \
        --skip-email you@example.com --skip-name "Your Name" \
        [--api http://localhost:4000/api/people] [--log PATH] [--dry-run]
"""
import argparse, json, quopri, re, sys, urllib.error
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
merge_csv = __import__("merge-csv")
norm, name_tokens, fetch_db, http_json = (
    merge_csv.norm, merge_csv.name_tokens, merge_csv.fetch_db, merge_csv.http_json)

DEAD_URL_RE = re.compile(r"(www\.|plus\.)?google\.com/profiles|plus\.google\.com", re.I)


def unfold(text):
    """vCard line unfolding: continuation lines start with space/tab."""
    lines = []
    for raw in text.splitlines():
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        else:
            lines.append(raw)
    return lines


def parse_prop(line):
    """'item1.EMAIL;TYPE=HOME:a@b.c' -> ('EMAIL', {'TYPE': 'HOME'}, 'a@b.c')"""
    if ":" not in line:
        return None
    head, value = line.split(":", 1)
    parts = head.split(";")
    name = parts[0].split(".")[-1].upper()  # strip itemN. group prefix
    params = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.upper()
        elif p:
            params.setdefault("TYPE", p.upper())
    if params.get("ENCODING") == "QUOTED-PRINTABLE":
        value = quopri.decodestring(value.encode()).decode("utf-8", "replace")
    return name, params, value


def split_structured(value):
    """Split N/ADR/ORG component values on unescaped ';' and unescape."""
    parts = re.split(r"(?<!\\);", value)
    return [p.replace("\\;", ";").replace("\\,", ",").replace("\\n", "\n").strip() for p in parts]


def digits(phone):
    return re.sub(r"\D", "", phone)[-10:]


def parse_vcf(path):
    """Yield one dict per vCard."""
    raw = Path(path).read_text(encoding="utf-8", errors="replace")
    card = None
    cards = []
    lines = unfold(raw)
    i = 0
    while i < len(lines):
        line = lines[i]
        # quoted-printable soft line breaks: trailing '=' continues on next line
        while line.rstrip().endswith("=") and "QUOTED-PRINTABLE" in line.upper().split(":")[0] and i + 1 < len(lines):
            line = line.rstrip()[:-1] + lines[i + 1]
            i += 1
        i += 1
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.upper() == "BEGIN:VCARD":
            card = {"emails": [], "phones": [], "urls": [], "adrs": [], "notes": []}
            continue
        if card is None:
            continue
        if stripped.upper() == "END:VCARD":
            cards.append(card)
            card = None
            continue
        prop = parse_prop(stripped)
        if not prop:
            continue
        name, params, value = prop
        value = value.strip()
        if not value:
            continue
        if name == "PHOTO":
            card["has_photo"] = True
        elif name == "FN":
            card["fn"] = re.sub(r"\s+", " ", value.replace("\\,", ",").replace("\\;", ";")).strip()
        elif name == "N":
            comp = split_structured(value)
            card["family"] = comp[0] if len(comp) > 0 else ""
            card["given"] = comp[1] if len(comp) > 1 else ""
            card["middle"] = comp[2] if len(comp) > 2 else ""
        elif name == "EMAIL":
            e = value.strip().lower()
            if e and "@" in e and e not in card["emails"]:
                card["emails"].append(e)
        elif name == "TEL":
            p = re.sub(r"\s+", " ", value).strip()
            if p and digits(p) not in [digits(x) for x in card["phones"]]:
                card["phones"].append(p)
        elif name == "ORG":
            card["org"] = split_structured(value)[0]
        elif name == "TITLE":
            card["title"] = value
        elif name == "URL":
            card["urls"].append(value)
        elif name == "ADR":
            comp = split_structured(value)
            # ADR: pobox;ext;street;city;region;zip;country
            addr = ", ".join(x for x in comp[2:] if x)
            if addr:
                label = (params.get("TYPE") or "").lower()
                card["adrs"].append(f"{addr}" + (f" ({label})" if label else ""))
        elif name == "X-ANDROID-CUSTOM" and "relation" in value.lower().split(";")[0]:
            rel = split_structured(value)
            if len(rel) > 1 and rel[1]:
                card["notes"].append(f"Relation: {rel[1]}")
    return cards


def card_display(card):
    if card.get("fn"):
        return card["fn"]
    given, family = card.get("given", ""), card.get("family", "")
    return re.sub(r"\s+", " ", f"{given} {family}").strip()


def summarize(card, source_label):
    bits = []
    for a in card["adrs"]:
        bits.append(f"Address: {a}")
    for u in card["urls"]:
        if DEAD_URL_RE.search(u) or "linkedin.com" in u.lower():
            continue
        bits.append(f"Website: {u}")
    bits.extend(card["notes"])
    return "\n".join(bits) or None


def linkedin_of(card):
    for u in card["urls"]:
        if "linkedin.com" in u.lower() and u.startswith("http"):
            return u
    return None


def merge_cards(cards):
    """Within-file dedupe: union cards sharing an email, then exact name."""
    merged = []
    by_email, by_name = {}, {}
    for c in cards:
        target = None
        for e in c["emails"]:
            if e in by_email:
                target = by_email[e]
                break
        if target is None:
            key = norm(card_display(c))
            if key and key in by_name:
                target = by_name[key]
        if target is None:
            merged.append(c)
            target = c
        else:
            for e in c["emails"]:
                if e not in target["emails"]:
                    target["emails"].append(e)
            for p in c["phones"]:
                if digits(p) not in [digits(x) for x in target["phones"]]:
                    target["phones"].append(p)
            target["urls"].extend(u for u in c["urls"] if u not in target["urls"])
            target["adrs"].extend(a for a in c["adrs"] if a not in target["adrs"])
            target["notes"].extend(n for n in c["notes"] if n not in target["notes"])
            for f in ("fn", "given", "family", "org", "title"):
                if not target.get(f) and c.get(f):
                    target[f] = c[f]
        for e in c["emails"]:
            by_email.setdefault(e, target)
        key = norm(card_display(c))
        if key:
            by_name.setdefault(key, target)
    return merged


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vcf_path")
    ap.add_argument("--how-known", default="Imported from vCard contacts export.")
    ap.add_argument("--source-label", default="vcf import")
    ap.add_argument("--skip-email", action="append", default=[])
    ap.add_argument("--skip-name", action="append", default=[])
    ap.add_argument("--api", default="http://localhost:4000/api/people")
    ap.add_argument("--log", default="/tmp/vcf_import_log.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    started = datetime.now(timezone.utc).isoformat()
    cards = parse_vcf(args.vcf_path)
    total_raw = len(cards)
    cards = merge_cards(cards)

    log = {"source": args.vcf_path, "started_at": started,
           "raw_cards": total_raw, "merged_cards": len(cards),
           "updated": [], "created": [], "skipped": [], "errors": []}

    skip_emails = {e.lower() for e in args.skip_email}
    skip_names = {n.lower() for n in args.skip_name}

    db = fetch_db(args.api)
    by_email = {}
    for p in db:
        if p.get("primary_email"):
            by_email[norm(p["primary_email"])] = p
        for e in (p.get("known_emails") or []):
            by_email.setdefault(norm(e), p)
    by_name = {}
    for p in db:
        by_name.setdefault(norm(p["display_name"]), []).append(p)
    by_first_lasttoken = {}
    for p in db:
        toks = name_tokens(p["display_name"])
        if len(toks) >= 2:
            key = (toks[0].lower(), re.sub(r"[^a-z]", "", toks[1].lower()))
            by_first_lasttoken.setdefault(key, []).append(p)

    counts = {"CREATE": 0, "PATCH": 0}
    for card in cards:
        display = card_display(card)
        if not display:
            log["skipped"].append({"reason": "no_name", "emails": card["emails"][:3]})
            continue
        if display.lower() in skip_names or any(e in skip_emails for e in card["emails"]):
            log["skipped"].append({"reason": "owner", "name": display})
            continue
        if not card.get("given") and not card.get("family") and card.get("org") and norm(card.get("fn", "")) == norm(card["org"]):
            log["skipped"].append({"reason": "business_card", "name": display})
            continue

        # Match against DB
        hit, reason = None, None
        for e in card["emails"]:
            if norm(e) in by_email:
                hit, reason = by_email[norm(e)], "email"
                break
        if not hit:
            cands = by_name.get(norm(display), [])
            if len(cands) == 1:
                hit, reason = cands[0], "exact_name"
        if not hit:
            toks = name_tokens(display)
            if len(toks) >= 2:
                key = (toks[0].lower(), re.sub(r"[^a-z]", "", toks[1].lower()))
                cands = by_first_lasttoken.get(key, [])
                if len(cands) == 1:
                    hit, reason = cands[0], "fuzzy_first_lasttoken"

        summary = summarize(card, args.source_label)
        linkedin = linkedin_of(card)
        try:
            if hit:
                body = {}
                known_emails = list(hit.get("known_emails") or [])
                known_phones = list(hit.get("known_phones") or [])
                aliases = list(hit.get("aliases") or [])
                if card["emails"] and not hit.get("primary_email"):
                    body["primary_email"] = card["emails"][0]
                for e in card["emails"]:
                    if e not in [x.lower() for x in known_emails]:
                        known_emails.append(e)
                for p in card["phones"]:
                    if digits(p) not in [digits(x) for x in known_phones]:
                        known_phones.append(p)
                if card.get("org") and not hit.get("company"):
                    body["company"] = card["org"]
                if card.get("title") and not hit.get("title"):
                    body["title"] = card["title"]
                if linkedin and not hit.get("linkedin_url"):
                    body["linkedin_url"] = linkedin
                if summary and summary not in (hit.get("summary") or ""):
                    existing = (hit.get("summary") or "").strip()
                    body["summary"] = (existing + f"\n\n— From {args.source_label} —\n" + summary).strip() if existing else summary
                if display.lower() != (hit.get("display_name") or "").lower() and display not in aliases:
                    aliases.append(display)
                if known_emails != (hit.get("known_emails") or []):
                    body["known_emails"] = known_emails
                if known_phones != (hit.get("known_phones") or []):
                    body["known_phones"] = known_phones
                if aliases != (hit.get("aliases") or []):
                    body["aliases"] = aliases
                if not body:
                    log["skipped"].append({"reason": "no_changes", "id": hit["id"], "name": hit["display_name"]})
                    continue
                counts["PATCH"] += 1
                if args.dry_run:
                    print(f"DRY  PATCH  {hit['display_name']:40.40s} via {reason:22s} {sorted(body.keys())}")
                    continue
                result = http_json("PATCH", f"{args.api}/{hit['id']}", body)
                log["updated"].append({"id": hit["id"], "name": result["person"]["display_name"],
                                       "match_reason": reason, "fields_changed": sorted(body.keys())})
            else:
                body = {"display_name": display,
                        "primary_email": card["emails"][0] if card["emails"] else None,
                        "known_emails": card["emails"],
                        "known_phones": card["phones"],
                        "company": card.get("org"),
                        "title": card.get("title"),
                        "linkedin_url": linkedin,
                        "summary": summary,
                        "how_known": args.how_known}
                body = {k: v for k, v in body.items() if v not in (None, "", [])}
                counts["CREATE"] += 1
                if args.dry_run:
                    print(f"DRY  CREATE {display:40.40s} emails={len(card['emails'])} phones={len(card['phones'])}")
                    continue
                result = http_json("POST", args.api, body)
                log["created"].append({"id": result["person"]["id"], "name": display,
                                       "primary_email": body.get("primary_email")})
        except urllib.error.HTTPError as e:
            log["errors"].append({"name": display, "http": e.code, "body": e.read().decode("utf-8")[:300]})

    log["finished_at"] = datetime.now(timezone.utc).isoformat()
    with open(args.log, "w") as f:
        json.dump(log, f, indent=2)
    skip_reasons = {}
    for s in log["skipped"]:
        skip_reasons[s["reason"]] = skip_reasons.get(s["reason"], 0) + 1
    print(f"\n{'DRY RUN — ' if args.dry_run else ''}cards={total_raw} (merged to {len(cards)}) "
          f"create={counts['CREATE']} patch={counts['PATCH']} "
          f"skipped={len(log['skipped'])} {skip_reasons} errors={len(log['errors'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
