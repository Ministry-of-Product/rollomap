#!/usr/bin/env python3
"""
Merge a CSV of contacts into rollomap via the REST API.

Generic over column names — pass the source's column names via flags. Detects
existing people by email (highest confidence), then exact display-name, then
fuzzy first-name + first-token-of-last-name. Updates existing records by
PATCH (filling missing fields, appending to summary, adding aliases /
known_emails / known_phones); creates new ones via POST.

Writes a JSON log to --log (default /tmp/merge_log.json) with `updated`,
`created`, `skipped`, and `errors` arrays.

Usage example:
    merge-csv.py path/to/members.csv \\
        --first-col "First name" --last-col "Last name" \\
        --email-col Email --secondary-email-col "Secondary Email" \\
        --linkedin-col LinkedIn --org-col Organization \\
        --phone-col Phone \\
        --summary-cols Interests "Why join?" Contribution? Notes \\
        --how-known "Member of the 601 Club." \\
        --skip-email matt@ministryofproduct.com \\
        --skip-name "Matt Paulin" \\
        --api http://localhost:4000/api/people \\
        --log /tmp/merge_log.json
"""
import argparse, csv, json, re, sys, urllib.error, urllib.request


def norm(s):
    return (s or "").strip().lower()


def name_tokens(name):
    return [t for t in re.split(r"\s+", (name or "").strip()) if t]


def fetch_db(api):
    base = api.rstrip("/")
    with urllib.request.urlopen(f"{base}?limit=500", timeout=10) as r:
        return json.loads(r.read())["people"]


def http_json(method, url, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def cell(row, col):
    return (row.get(col) or "").strip() if col else ""


def build_summary(row, cols):
    parts = []
    for c in cols:
        v = cell(row, c)
        if v:
            parts.append(f"{c}: {v}" if c.lower() not in ("interests", "summary", "bio") else v)
    return "\n\n".join(parts) if parts else None


def build_create(row, args):
    first = cell(row, args.first_col)
    last = cell(row, args.last_col)
    display = cell(row, args.display_col) if args.display_col else f"{first} {last}".strip()
    if not display:
        return None
    email = cell(row, args.email_col) or None
    sec_email = cell(row, args.secondary_email_col)
    phone = cell(row, args.phone_col)
    linkedin = cell(row, args.linkedin_col) or None
    org = cell(row, args.org_col) or None
    summary = build_summary(row, args.summary_cols or [])
    body = {
        "display_name": display,
        "primary_email": email,
        "company": org,
        "linkedin_url": linkedin if linkedin and linkedin.startswith("http") else None,
        "summary": summary,
        "how_known": args.how_known,
        "known_emails": [e for e in [email, sec_email] if e],
        "known_phones": [phone] if phone else [],
    }
    return {k: v for k, v in body.items() if v not in (None, "", [])}


def build_patch(existing, row, args):
    csv_email = cell(row, args.email_col)
    sec_email = cell(row, args.secondary_email_col)
    phone = cell(row, args.phone_col)
    linkedin = cell(row, args.linkedin_col)
    org = cell(row, args.org_col)
    csv_summary = build_summary(row, args.summary_cols or [])
    first = cell(row, args.first_col)
    last = cell(row, args.last_col)

    body = {}
    aliases = list(existing.get("aliases") or [])
    known_emails = list(existing.get("known_emails") or [])
    known_phones = list(existing.get("known_phones") or [])

    if csv_email and not existing.get("primary_email"):
        body["primary_email"] = csv_email
    for e in [csv_email, sec_email]:
        if e and e not in known_emails:
            known_emails.append(e)
    if phone and phone not in known_phones:
        known_phones.append(phone)
    if linkedin and linkedin.startswith("http") and not existing.get("linkedin_url"):
        body["linkedin_url"] = linkedin
    if org and not existing.get("company"):
        body["company"] = org
    if csv_summary:
        existing_summary = (existing.get("summary") or "").strip()
        if csv_summary not in existing_summary:
            body["summary"] = (existing_summary + f"\n\n— From {args.source_label} —\n" + csv_summary).strip() if existing_summary else csv_summary
    csv_display = f"{first} {last}".strip()
    if csv_display and csv_display.lower() != (existing.get("display_name") or "").lower() and csv_display not in aliases:
        aliases.append(csv_display)
    if known_emails != (existing.get("known_emails") or []):
        body["known_emails"] = known_emails
    if known_phones != (existing.get("known_phones") or []):
        body["known_phones"] = known_phones
    if aliases != (existing.get("aliases") or []):
        body["aliases"] = aliases
    return body


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv_path", help="path to CSV file")
    ap.add_argument("--first-col", help="column with given name")
    ap.add_argument("--last-col", help="column with family name")
    ap.add_argument("--display-col", help="column with full display name (overrides first/last)")
    ap.add_argument("--email-col", help="column with primary email")
    ap.add_argument("--secondary-email-col", help="column with secondary email")
    ap.add_argument("--linkedin-col", help="column with LinkedIn URL")
    ap.add_argument("--org-col", help="column with organization / company")
    ap.add_argument("--phone-col", help="column with phone number")
    ap.add_argument("--summary-cols", nargs="*", default=[],
                    help="one or more columns whose contents go into summary")
    ap.add_argument("--how-known", default="Imported from CSV.",
                    help="how_known string applied to created people")
    ap.add_argument("--source-label", default="CSV import",
                    help="label used when appending CSV summary to existing summary")
    ap.add_argument("--skip-email", action="append", default=[],
                    help="skip rows with this email (repeatable)")
    ap.add_argument("--skip-name", action="append", default=[],
                    help="skip rows with this display name (repeatable)")
    ap.add_argument("--api", default="http://localhost:4000/api/people")
    ap.add_argument("--log", default="/tmp/merge_log.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not args.display_col and not (args.first_col and args.last_col):
        print("error: must specify --display-col OR both --first-col and --last-col", file=sys.stderr)
        sys.exit(2)

    db = fetch_db(args.api)
    by_email = {norm(p["primary_email"]): p for p in db if p.get("primary_email")}
    by_name = {}
    for p in db:
        by_name.setdefault(norm(p["display_name"]), []).append(p)
    by_first_lasttoken = {}
    for p in db:
        toks = name_tokens(p["display_name"])
        if len(toks) >= 2:
            key = (toks[0].lower(), re.sub(r"[^a-z]", "", toks[1].lower()))
            by_first_lasttoken.setdefault(key, []).append(p)

    skip_emails = {e.lower() for e in args.skip_email}
    skip_names = {n.lower() for n in args.skip_name}

    with open(args.csv_path, encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))

    log = {"source": args.csv_path, "updated": [], "created": [], "skipped": [], "errors": []}

    for row in rows:
        first = cell(row, args.first_col)
        last = cell(row, args.last_col)
        display = cell(row, args.display_col) if args.display_col else f"{first} {last}".strip()
        email = norm(cell(row, args.email_col))

        if not display:
            log["skipped"].append({"reason": "no_display_name", "row_keys": list(row.keys())[:5]})
            continue
        if email and email in skip_emails:
            log["skipped"].append({"reason": "skip_email", "name": display, "email": email}); continue
        if display.lower() in skip_names:
            log["skipped"].append({"reason": "skip_name", "name": display}); continue

        # Match
        hit, reason = None, None
        if email and email in by_email:
            hit, reason = by_email[email], "email"
        elif display.lower() in by_name and len(by_name[display.lower()]) == 1:
            hit, reason = by_name[display.lower()][0], "exact_name"
        elif first and last:
            last_first = re.sub(r"[^a-z]", "", last.lower().split()[0]) if last else ""
            cands = by_first_lasttoken.get((first.lower(), last_first), [])
            if len(cands) == 1:
                hit, reason = cands[0], "fuzzy_first_lasttoken"

        try:
            if hit:
                body = build_patch(hit, row, args)
                if not body:
                    log["skipped"].append({"reason": "no_changes", "id": hit["id"], "name": hit["display_name"]})
                    continue
                if args.dry_run:
                    print(f"DRY  PATCH {hit['display_name']:35s} via {reason}  {list(body.keys())}")
                    continue
                result = http_json("PATCH", f"{args.api}/{hit['id']}", body)
                log["updated"].append({
                    "id": hit["id"], "name": result["person"]["display_name"],
                    "match_reason": reason, "fields_changed": list(body.keys()),
                })
                print(f"PATCH {hit['display_name']:35s} via {reason}  {list(body.keys())}")
            else:
                body = build_create(row, args)
                if not body:
                    log["skipped"].append({"reason": "build_create_returned_none", "name": display})
                    continue
                if args.dry_run:
                    print(f"DRY  CREATE {display:34s}")
                    continue
                result = http_json("POST", args.api, body)
                log["created"].append({
                    "id": result["person"]["id"],
                    "name": result["person"]["display_name"],
                    "company": result["person"].get("company"),
                    "primary_email": result["person"].get("primary_email"),
                })
                print(f"CREATE {result['person']['display_name']:34s} ({result['person'].get('company') or '-'})")
        except urllib.error.HTTPError as e:
            err = {"name": display, "http": e.code, "body": e.read().decode("utf-8")}
            log["errors"].append(err)
            print(f"ERR    {display}: HTTP {e.code} — {err['body'][:120]}", file=sys.stderr)

    with open(args.log, "w") as f:
        json.dump(log, f, indent=2)
    print(f"\nupdated={len(log['updated'])} created={len(log['created'])} "
          f"skipped={len(log['skipped'])} errors={len(log['errors'])}", file=sys.stderr)


if __name__ == "__main__":
    main()
