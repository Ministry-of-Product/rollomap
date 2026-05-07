#!/usr/bin/env python3
"""
Extract plain text from a PDF using pdftotext (poppler).

Writes the extracted text to --out (or stdout). Exits non-zero with a clear
message if pdftotext is missing or if the PDF appears to be scanned (no
extractable text — would need OCR, which this helper does NOT do).

Usage:
    pdf-to-text.py <input.pdf> [--out <path>] [--layout]
"""
import argparse
import shutil
import subprocess
import sys


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input")
    ap.add_argument("--out", help="output path (default stdout)")
    ap.add_argument("--layout", action="store_true",
                    help="preserve layout (-layout flag)")
    args = ap.parse_args()

    if shutil.which("pdftotext") is None:
        print("error: pdftotext not on PATH. Install poppler "
              "(`brew install poppler` on macOS) and retry.", file=sys.stderr)
        sys.exit(127)

    cmd = ["pdftotext"]
    if args.layout:
        cmd.append("-layout")
    cmd += [args.input, "-"]
    try:
        result = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        print(f"error: pdftotext exited {e.returncode}: {e.stderr.strip()}", file=sys.stderr)
        sys.exit(e.returncode or 1)

    text = result.stdout

    # Heuristic: if extraction yielded almost no text, the PDF is likely scanned.
    stripped = text.strip()
    if len(stripped) < 200:
        print(f"error: PDF yielded only {len(stripped)} chars of text — "
              "likely a scanned/image-only PDF. OCR not implemented in this skill. "
              "Add OCR (e.g. ocrmypdf) under .claude/skills/ingest/scripts/ to handle scans.",
              file=sys.stderr)
        sys.exit(2)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)

    print(f"pdf-to-text: extracted {len(text):,} chars from {args.input}", file=sys.stderr)


if __name__ == "__main__":
    main()
