---
name: ingest
description: Process files dropped into ingest/inbox/ to extract people, interactions, notes, topics, and commitments into the RolloMap database via http://localhost:4000. Use when the user says "ingest the inbox", "process the new file", "/ingest", or names a file under ingest/inbox/. Supports markdown notes, plaintext, and CSV (Wild Apricot, LinkedIn export, generic). HALTS LOUDLY on unsupported formats, unreachable API, oversize text, or files outside ingest/inbox/ — does not silently best-effort.
---

# Ingest skill

You are running the ingest pipeline for RolloMap. Drop-in files under `ingest/inbox/` get parsed, deduped against the existing DB, written via the REST API, and archived to `ingest/processed/<YYYY-MM-DD>/` with a `.log.json` sidecar.

## STOP IF (raise an explicit error to the user — do not proceed)

These are the "exception" cases. When any of these triggers, stop, tell the user *exactly* which rule fired and which file/condition caused it, and wait for direction. Do not improvise around them.

1. **API unreachable.** Run `curl -s -m 5 http://localhost:4000/health`. If it does not return `{"status":"ok"}`, stop with: `API at http://localhost:4000 is not responding. Start the rollomap API before re-running.`
2. **Inbox empty.** If `ingest/inbox/` contains no files (other than `.gitkeep`), stop with: `ingest/inbox/ is empty — nothing to ingest.`
3. **File outside inbox.** If the user names a path that is not under `ingest/inbox/`, stop with: `<path> is outside ingest/inbox/. Move it into the inbox first.` Do not read it.
4. **Unsupported format.** Supported extensions: `.md`, `.txt`, `.csv`, `.tsv`, `.vcf`, `.json`, `.eml`, `.mbox`, `.pdf` (born-digital only — see rule 4a). Anything else (`.mp3`, `.mp4`, `.mov`, `.wav`, `.zip`, `.exe`, `.dmg`, `.pkg`, `.docx`, `.xlsx`, `.pptx`, image formats other than already-extracted text, etc.) → stop with: `Unsupported format <ext>. This skill processes text-based contact / interaction sources. To handle <ext>, add a preprocessor under .claude/skills/ingest/scripts/ and a dispatch branch in SKILL.md.`
4a. **Scanned / image-only PDF.** If `pdf-to-text.py` exits non-zero with the "scanned" message (extracted text < 200 chars), stop with: `<file> is a scanned/image-only PDF. OCR is not implemented in this skill. Add ocrmypdf or similar under .claude/skills/ingest/scripts/ before re-running.`
5. **Binary content masquerading as text.** If a `.txt` or `.md` file contains > 5% non-printable bytes (after stripping known data-URIs), stop with: `<file> appears to be binary. Aborting — manual review needed.`
6. **Oversize after preprocessing.** After running `strip-images.py`, if the cleaned text is still > 2,000,000 characters (~2 MB), stop with: `<file> is still <size> chars after image stripping. Too large for in-context extraction. Pre-split the file or write a structured parser.`
7. **Out-of-scope content.** If the file is clearly *not* contact / relationship data — source code, financial transactions, system logs, personal journal entries, medical records — stop with: `<file> does not look like contact / relationship data. This skill does not ingest <what-you-saw>. If this is intentional, tell me what you want extracted.`
8. **Already-processed file.** If a file with the same name and same SHA-256 exists under `ingest/processed/`, stop with: `<file> appears already-processed (matches <prior-path>). Re-ingest would create duplicates.` Offer to diff or force-re-ingest only if the user explicitly asks.
9. **Sensitive PII not about people.** If the file contains SSNs, full credit-card numbers, government IDs, or medical-record identifiers attached to people, stop with: `<file> contains sensitive PII fields not modeled in RolloMap. Strip or redact those fields before ingest.`

## Workflow (when no STOP rule fires)

### 1. Preflight
- API health check (rule 1).
- Fetch `GET /api/profile`. Use `ownerEmails`/`ownerAliases` for the `--skip-email`/`--skip-name` args on `merge-csv.py` / `import-linkedin.py` (never insert the workspace owner as a person). Consult `importRecipes` for CSV sources the owner has already saved a column-mapping recipe for — prefer those over guessing from the header.
- List `ingest/inbox/`. If a single new drop, target it. If multiple, ask which (or "all").
- Compute SHA-256, check against `ingest/processed/**/*.<ext>` (rule 8).

### 2. Detect format
- By extension first; on ambiguous text files, sniff the first 1-2 KB.
- Supported formats and dispatcher:

| Extension | Approach |
|---|---|
| `.csv`, `.tsv` | Inspect header. If schema is recognized (Wild Apricot members, LinkedIn connections, Google Contacts), use `merge-csv.py` with the appropriate column-mapping flags (see `csv-recipes.md` if present, otherwise figure out the mapping from the header and document it inline). For unknown schemas, ask the user for the column mapping before running. |
| `.md`, `.txt` | (a) Run `strip-images.py` to remove embedded base64. (b) Read the cleaned text. (c) Extract people / meeting events / topics / commitments using the LLM. (d) For each extracted person, dedupe by name+context against existing DB (`GET /api/people?q=<name>`) before POST. (e) For meeting events, create `interaction` rows linking participants. (f) If the source is journal-style with `<Date>: <Name>` section headers, prefer `extract-dated-interactions.py` over hand-rolled extraction — it handles dated headers, multi-attendee splits (`+`, `,`), TOC dot-leader detection, and stub-creation for unknown attendees. |
| `.vcf` | Parse vCard with stdlib (each `BEGIN:VCARD ... END:VCARD` block = one person). Map FN→display_name, EMAIL→primary_email/known_emails, TEL→known_phones, ORG→company, TITLE→title, URL containing "linkedin.com"→linkedin_url. Run dedupe before POST. |
| `.eml`, `.mbox` | Parse with stdlib `email`. For each message: create one `interaction` (type=email), participants = sender + To + Cc resolved against existing people; create new people for unrecognized addresses. Subject→title, plaintext body→body. |
| `.json` | If shape is `[{display_name, ...}, ...]` matching the `POST /api/people` schema, validate and forward. Otherwise stop and ask for a column mapping. |
| `.pdf` | (a) Run `pdf-to-text.py <pdf> --out <tmp>.txt` to extract plain text. The helper exits non-zero on scanned PDFs — let that bubble up to STOP rule 4a. (b) Then take the `.md`/`.txt` path on the extracted file. Try `--layout` if the default extraction is jumbled (e.g. multi-column resumes / decks). Always preserve the original PDF in `processed/<date>/` next to the extracted `.txt` — both go into the archive. |

### 3. Match → write
- Use `merge-csv.py` for tabular sources — it dedupes by email → exact name → fuzzy first+last-token, and PATCHes vs POSTs accordingly.
- For freeform extraction (markdown / plaintext): for each candidate person, `GET /api/people?q=<name>` first. Do not create a record for a single first name unless you have a distinguishing signal (email, LinkedIn, distinctive context). Skip ambiguous mentions and list them in the log under `skipped: [{reason: "ambiguous_first_name", ...}]`.
- **Never** insert the workspace owner as a person (see the profile's `ownerName` / `ownerEmails` / `ownerAliases` from preflight, plus generic "You" / "Me" chat handles).

### 4. Archive
- `mv ingest/inbox/<file> ingest/processed/<YYYY-MM-DD>/<file>` (create the dated folder if missing).
- Write `<file>.log.json` next to it: `{source, sha256, started_at, finished_at, updated[], created[], skipped[], errors[]}`.
- If a meeting-notes file produced both people *and* interactions, write both ID lists into the same log.

### 5. Post-run dupe sweep
- Run `suggest-merges.py --out /tmp/suggest_merges.json`.
- Compare the pair count to the count from before this ingest (you can snapshot `total_people` at preflight). If new candidate pairs appeared, file a single Linear issue listing them — title: `Resolve N candidate duplicate person records from <date> ingest`, project `RolloMap`, team `Ministry Of Product`. Include the pair table with reason/IDs.
- If no new pairs, no issue needed.

### 6. Report back
One short message to the user:
- file processed, sha256 (first 8 chars), counts (created/updated/skipped/errors)
- archive path
- dupe-issue link if filed, or "no new dupes" if not

## Helper scripts

In `.claude/skills/ingest/scripts/`:

- `strip-images.py <input> [--out PATH]` — removes base64 data URIs and >500-char base64 blobs.
- `pdf-to-text.py <input.pdf> [--out PATH] [--layout]` — extracts text via `pdftotext` (poppler); exits non-zero on scanned PDFs.
- `extract-dated-interactions.py <text-file> --topic NAME --source-label LABEL [--skip-attendee X ...] [--dry-run]` — finds dated section headers like `Feb 16, 2015: Alex Rivera` (or `Sam Chen + Jordan Lee`), parses attendees, resolves them against the DB (creating stubs for unknowns), slices the body, and POSTs an `interaction` per section. Skips journal-author-only entries / retrospective sections / TOC entries (anything matching `\.{3,}` dot-leader is treated as TOC). Always run with `--dry-run` first on an unfamiliar source.
- `import-linkedin.py <Connections.csv> [--dry-run]` — opinionated wrapper around `merge-csv.py` for LinkedIn's `Connections.csv` export. Auto-detects + skips LinkedIn's `Notes:` preamble, bakes in the column mapping, and validates the schema before running. Exits non-zero on a non-LinkedIn CSV.
- `merge-csv.py <csv> --first-col ... --last-col ... --email-col ... [--secondary-email-col ...] [--linkedin-col ...] [--org-col ...] [--phone-col ...] [--summary-cols A B C] [--how-known TEXT] [--source-label TEXT] [--skip-email EMAIL] [--skip-name NAME] [--api URL] [--log PATH] [--dry-run]` — dedupe-aware CSV merger.
- `suggest-merges.py [--api URL] [--out PATH]` — finds near-duplicate person records by 4 heuristics: first+last-prefix, exact display_name, deaccented display_name, shared email.

Each script supports `--help`. Always pass `--dry-run` first on an unfamiliar CSV to verify the column mapping and the patch/create plan look right, then re-run for real.

## Known CSV recipes (extend as new sources appear)

Your own saved recipes (column mappings you've confirmed before, keyed by
source) live in the workspace profile's `importRecipes` field — fetch
`GET /api/profile` during preflight and prefer a matching saved recipe over
re-deriving the mapping from the header. The templates below are generic
starting points for common export shapes.

### Wild Apricot member roster (generic template)

```
.claude/skills/ingest/scripts/merge-csv.py "<csv>" \
  --first-col "First name" --last-col "Last name" \
  --email-col Email --secondary-email-col "Secondary Email" \
  --linkedin-col LinkedIn --org-col Organization --phone-col Phone \
  --summary-cols Interests "Why join?" "Contribution?" Notes \
  --how-known "Member of <your network>." \
  --source-label "member roster" \
  --skip-email you@example.com --skip-name "Your Name" \
  --log /tmp/merge_log.json
```

### LinkedIn Connections export

Use the dedicated wrapper — it auto-detects + skips LinkedIn's preamble (the `Notes:` lines LinkedIn prepends before the real header) and bakes in the column mapping:

```
.claude/skills/ingest/scripts/import-linkedin.py "<Connections.csv>" --dry-run
# eyeball, then drop --dry-run for the real run
.claude/skills/ingest/scripts/import-linkedin.py "<Connections.csv>" --log /tmp/linkedin_log.json
```

How the user gets the file: LinkedIn → Settings & Privacy → Data Privacy → Get a copy of your data → check **Connections** only → Request archive. Email arrives ~10–60 min later with a zip; `Connections.csv` is inside.

The wrapper validates that the file actually has the LinkedIn schema (`First Name, Last Name, URL, Email Address, Company, Position, Connected On`) and exits non-zero with a clear message if not — refuses to ingest unrelated CSVs as LinkedIn data.

### Journal-style retrospective with dated meeting headers

For a text/markdown/PDF source where each meeting is a `<Date>: <Attendee(s)>` section (e.g. a retrospective book, a year-end log, a deal-flow journal):

```
extract-dated-interactions.py "<source.txt>" \
  --topic "<TopicName>" \
  --source-label "<short label, e.g. 'seed round fundraising'>" \
  --skip-attendee "<event-y header>" --skip-attendee "<another>" \
  --log /tmp/interactions_log.json \
  [--dry-run]
```

Always run `--dry-run` first; eyeball the parsed dates and attendee names. The script also fetches `journalSkipPhrases` from the workspace profile and unions them with a small generic default (`Conference`, `Clinic`, `Cap Table`, `Minutes`, etc.) and any `--skip-attendee` values, so source-specific section titles that aren't people (a particular group name, a one-off entry title, etc.) should be added to the profile's `journalSkipPhrases` rather than hardcoded — or passed ad hoc via `--skip-attendee` for a one-off run. Multi-attendee headers (`Jim + John`, `Jim, Joe`) auto-split. Attendees not yet in the DB get auto-created with `how_known = "Met during <source-label> on <date>."`. Board minutes / minutes-only headers (`<Date> – Minutes`) need a separate hand-built insert if the attendee list is in the body — see a prior dated ingest log under `ingest/processed/<date>/` for a template.

### Google Contacts export

Headers vary by version. Common subset: `Name, Given Name, Family Name, E-mail 1 - Value, Phone 1 - Value, Organization 1 - Name, Organization 1 - Title`.

If you encounter a CSV whose header you don't recognize, do *not* guess. Show the header to the user and confirm the column mapping before running.

## Notes for the LLM doing the work

- Consult the workspace profile (`GET /api/profile` — `primaryNetwork`, `ownerName`, etc.) and your project memory for network-specific and Linear-specific details (e.g. which API path convention to use, which network is primary, which Linear project to file issues in). Apply what you find there.
- When extracting from freeform notes, prefer **fewer high-confidence creates** over **many low-confidence ones**. The `MIN-500` issue tracks how to revisit single-name mentions later.
- The `/api/people/merge` endpoint does not currently merge `summary` / `linkedin_url` / `company` / `aliases` / `known_emails` (see MIN-504). Until fixed, PATCH the target with the source's missing fields *before* calling `/merge`, or skip auto-merge.
- Always write the `.log.json` even on partial failure — it's the auditable record and the basis for any rollback.
