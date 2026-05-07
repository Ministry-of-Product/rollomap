#!/usr/bin/env python3
"""
Strip base64-encoded image data URIs and other large blobs from a text/markdown file.
Writes the cleaned text to stdout (or --out PATH) and prints a one-line stats summary to stderr.

Usage:
    strip-images.py <input>              # writes cleaned text to stdout
    strip-images.py <input> --out <path> # writes cleaned text to <path>
"""
import argparse
import re
import sys


def clean(src: str) -> str:
    # 1. inline data: image URIs (markdown ![](data:...) or bare)
    src = re.sub(r"data:image/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=\s]+", "[IMAGE]", src)
    # 2. residual long base64-ish runs (>=500 chars of base64-safe alphabet)
    src = re.sub(r"[A-Za-z0-9+/=]{500,}", "[BLOB]", src)
    return src


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("input", help="path to input file")
    ap.add_argument("--out", help="output path (default stdout)")
    args = ap.parse_args()

    with open(args.input, encoding="utf-8", errors="replace") as f:
        src = f.read()
    cleaned = clean(src)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(cleaned)
    else:
        sys.stdout.write(cleaned)

    print(f"strip-images: in={len(src):,}ch out={len(cleaned):,}ch ratio={len(cleaned)/max(len(src),1):.4f}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
