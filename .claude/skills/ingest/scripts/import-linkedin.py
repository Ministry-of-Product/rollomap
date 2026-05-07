#!/usr/bin/env python3
"""
Import a LinkedIn `Connections.csv` export into rollomap.

Wraps `merge-csv.py` with the column mapping and skip-rules baked in, and
auto-detects + slices past LinkedIn's metadata preamble (LinkedIn prepends
~3 lines of `Notes:` text before the real header `First Name,Last Name,...`).

How to get the file:
  LinkedIn → Settings & Privacy → Data Privacy → Get a copy of your data
  → "Want something in particular? Select the data files you're most
     interested in." → check **Connections** only → Request archive.
  Email arrives ~10–60 min later with a zip; `Connections.csv` is inside.

Usage:
    import-linkedin.py <Connections.csv> [--dry-run] [--log PATH] [--api URL]

Adds these defaults on top of merge-csv.py:
  --first-col "First Name"
  --last-col "Last Name"
  --email-col "Email Address"
  --linkedin-col "URL"
  --org-col "Company"
  --summary-cols Position "Connected On"
  --how-known "LinkedIn connection (imported <today>)."
  --source-label "LinkedIn export"
  --skip-email matt@ministryofproduct.com
  --skip-name "Matt Paulin"
"""
import argparse
import csv
import os
import subprocess
import sys
import tempfile
from datetime import date


HERE = os.path.dirname(os.path.abspath(__file__))
MERGE_CSV = os.path.join(HERE, "merge-csv.py")

# Markers we expect from a LinkedIn Connections.csv
LINKEDIN_HEADER_TOKENS = ("First Name", "Last Name", "URL", "Email Address",
                          "Company", "Position", "Connected On")


def find_real_header(path):
    """Return (line_index, raw_header) where the real CSV header begins.

    LinkedIn prepends "Notes:" lines before the actual header. We scan the
    first ~10 rows looking for the line that starts with "First Name,".
    """
    with open(path, encoding="utf-8-sig", errors="replace") as f:
        for i, line in enumerate(f):
            if i > 15:
                break
            stripped = line.strip()
            # Real header has at least 4 of the LinkedIn columns
            hits = sum(1 for tok in LINKEDIN_HEADER_TOKENS if tok in stripped)
            if hits >= 4:
                return i, stripped
    return None, None


def slice_to_real_header(src_path, header_line_idx):
    """Write a temp file containing only the real CSV (header + data)."""
    fd, tmp = tempfile.mkstemp(prefix="linkedin_clean_", suffix=".csv")
    os.close(fd)
    with open(src_path, encoding="utf-8-sig", errors="replace") as fin, \
         open(tmp, "w", encoding="utf-8") as fout:
        for i, line in enumerate(fin):
            if i >= header_line_idx:
                fout.write(line)
    return tmp


def validate_schema(csv_path):
    """Read first row of the cleaned CSV; confirm LinkedIn schema."""
    with open(csv_path, encoding="utf-8") as f:
        reader = csv.reader(f)
        try:
            header = next(reader)
        except StopIteration:
            print(f"error: {csv_path} appears empty after preamble strip.", file=sys.stderr)
            sys.exit(2)
    missing = [tok for tok in LINKEDIN_HEADER_TOKENS if tok not in header]
    if missing:
        print(f"error: not a LinkedIn Connections.csv. Missing columns: {missing}\n"
              f"  saw: {header}", file=sys.stderr)
        sys.exit(2)
    return header


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv_path", help="LinkedIn Connections.csv (the .csv file inside the export zip)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Pass --dry-run through to merge-csv.py")
    ap.add_argument("--log", default="/tmp/linkedin_log.json",
                    help="Output log path (default /tmp/linkedin_log.json)")
    ap.add_argument("--api", default="http://localhost:4000/api/people")
    ap.add_argument("--how-known",
                    help="Override the default how_known string")
    ap.add_argument("--keep-temp", action="store_true",
                    help="Don't delete the cleaned-CSV temp file (debugging)")
    args = ap.parse_args()

    if not os.path.exists(args.csv_path):
        print(f"error: {args.csv_path} not found", file=sys.stderr)
        sys.exit(1)

    # 1. Find the real header row
    idx, raw = find_real_header(args.csv_path)
    if idx is None:
        print(f"error: couldn't find a LinkedIn-style header row in the first 15 lines\n"
              f"  expected a row containing at least 4 of {LINKEDIN_HEADER_TOKENS}\n"
              f"  is this actually a LinkedIn Connections.csv export?", file=sys.stderr)
        sys.exit(2)
    if idx > 0:
        print(f"info: skipping {idx} preamble line(s) before header", file=sys.stderr)

    # 2. Slice to a clean temp file
    cleaned = slice_to_real_header(args.csv_path, idx)
    try:
        # 3. Validate schema
        validate_schema(cleaned)

        # 4. Hand off to merge-csv.py
        how_known = args.how_known or f"LinkedIn connection (imported {date.today().isoformat()})."
        cmd = [
            sys.executable, MERGE_CSV, cleaned,
            "--first-col", "First Name",
            "--last-col", "Last Name",
            "--email-col", "Email Address",
            "--linkedin-col", "URL",
            "--org-col", "Company",
            "--summary-cols", "Position", "Connected On",
            "--how-known", how_known,
            "--source-label", "LinkedIn export",
            "--skip-email", "matt@ministryofproduct.com",
            "--skip-name", "Matt Paulin",
            "--api", args.api,
            "--log", args.log,
        ]
        if args.dry_run:
            cmd.append("--dry-run")

        proc = subprocess.run(cmd)
        sys.exit(proc.returncode)
    finally:
        if not args.keep_temp:
            try:
                os.unlink(cleaned)
            except OSError:
                pass
        else:
            print(f"kept cleaned temp file at {cleaned}", file=sys.stderr)


if __name__ == "__main__":
    main()
