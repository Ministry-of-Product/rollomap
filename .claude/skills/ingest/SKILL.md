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
4. **Unsupported format.** Supported extensions: `.md`, `.txt`, `.csv`, `.tsv`, `.vcf`, `.json`, `.eml`, `.mbox`. Anything else (`.mp3`, `.mp4`, `.mov`, `.wav`, `.zip`, `.exe`, `.dmg`, `.pkg`, `.docx`, `.xlsx`, `.pptx`, `.pdf`, image formats other than already-extracted text, etc.) → stop with: `Unsupported format <ext>. This skill processes text-based contact / interaction sources. To handle <ext>, add a preprocessor under .claude/skills/ingest/scripts/ and a dispatch branch in SKILL.md.`
   - Specifically refuse `.pdf` here. Adding PDF support is a deliberate decision (do you OCR? text-extract? both?) and should not be done implicitly.
5. **Binary content masquerading as text.** If a `.txt` or `.md` file contains > 5% non-printable bytes (after stripping known data-URIs), stop with: `<file> appears to be binary. Aborting — manual review needed.`
6. **Oversize after preprocessing.** After running `strip-images.py`, if the cleaned text is still > 2,000,000 characters (~2 MB), stop with: `<file> is still <size> chars after image stripping. Too large for in-context extraction. Pre-split the file or write a structured parser.`
7. **Out-of-scope content.** If the file is clearly *not* contact / relationship data — source code, financial transactions, system logs, personal journal entries, medical records — stop with: `<file> does not look like contact / relationship data. This skill does not ingest <what-you-saw>. If this is intentional, tell me what you want extracted.`
8. **Already-processed file.** If a file with the same name and same SHA-256 exists under `ingest/processed/`, stop with: `<file> appears already-processed (matches <prior-path>). Re-ingest would create duplicates.` Offer to diff or force-re-ingest only if the user explicitly asks.
9. **Sensitive PII not about people.** If the file contains SSNs, full credit-card numbers, government IDs, or medical-record identifiers attached to people, stop with: `<file> contains sensitive PII fields not modeled in RolloMap. Strip or redact those fields before ingest.`

## Workflow (when no STOP rule fires)

### 1. Preflight
- API health check (rule 1).
- List `ingest/inbox/`. If a single new drop, target it. If multiple, ask which (or "all").
- Compute SHA-256, check against `ingest/processed/**/*.<ext>` (rule 8).

### 2. Detect format
- By extension first; on ambiguous text files, sniff the first 1-2 KB.
- Supported formats and dispatcher:

| Extension | Approach |
|---|---|
| `.csv`, `.tsv` | Inspect header. If schema is recognized (Wild Apricot members, LinkedIn connections, Google Contacts), use `merge-csv.py` with the appropriate column-mapping flags (see `csv-recipes.md` if present, otherwise figure out the mapping from the header and document it inline). For unknown schemas, ask the user for the column mapping before running. |
| `.md`, `.txt` | (a) Run `strip-images.py` to remove embedded base64. (b) Read the cleaned text. (c) Extract people / meeting events / topics / commitments using the LLM. (d) For each extracted person, dedupe by name+context against existing DB (`GET /api/people?q=<name>`) before POST. (e) For meeting events, create `interaction` rows linking participants. |
| `.vcf` | Parse vCard with stdlib (each `BEGIN:VCARD ... END:VCARD` block = one person). Map FN→display_name, EMAIL→primary_email/known_emails, TEL→known_phones, ORG→company, TITLE→title, URL containing "linkedin.com"→linkedin_url. Run dedupe before POST. |
| `.eml`, `.mbox` | Parse with stdlib `email`. For each message: create one `interaction` (type=email), participants = sender + To + Cc resolved against existing people; create new people for unrecognized addresses. Subject→title, plaintext body→body. |
| `.json` | If shape is `[{display_name, ...}, ...]` matching the `POST /api/people` schema, validate and forward. Otherwise stop and ask for a column mapping. |

### 3. Match → write
- Use `merge-csv.py` for tabular sources — it dedupes by email → exact name → fuzzy first+last-token, and PATCHes vs POSTs accordingly.
- For freeform extraction (markdown / plaintext): for each candidate person, `GET /api/people?q=<name>` first. Do not create a record for a single first name unless you have a distinguishing signal (email, LinkedIn, distinctive context). Skip ambiguous mentions and list them in the log under `skipped: [{reason: "ambiguous_first_name", ...}]`.
- **Never** insert the user (Matt Paulin / matt@ministryofproduct.com / "You" / "Me" chat handles).

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
- `merge-csv.py <csv> --first-col ... --last-col ... --email-col ... [--secondary-email-col ...] [--linkedin-col ...] [--org-col ...] [--phone-col ...] [--summary-cols A B C] [--how-known TEXT] [--source-label TEXT] [--skip-email EMAIL] [--skip-name NAME] [--api URL] [--log PATH] [--dry-run]` — dedupe-aware CSV merger.
- `suggest-merges.py [--api URL] [--out PATH]` — finds near-duplicate person records by 4 heuristics: first+last-prefix, exact display_name, deaccented display_name, shared email.

Each script supports `--help`. Always pass `--dry-run` first on an unfamiliar CSV to verify the column mapping and the patch/create plan look right, then re-run for real.

## Known CSV recipes (extend as new sources appear)

### Wild Apricot member roster (601 Club)

```
.claude/skills/ingest/scripts/merge-csv.py "<csv>" \
  --first-col "First name" --last-col "Last name" \
  --email-col Email --secondary-email-col "Secondary Email" \
  --linkedin-col LinkedIn --org-col Organization --phone-col Phone \
  --summary-cols Interests "Why join?" "Contribution?" Notes \
  --how-known "Member of the 601 Club (Fortunato Vega's networking group, Seattle)." \
  --source-label "601 member roster" \
  --skip-email matt@ministryofproduct.com --skip-name "Matt Paulin" \
  --log /tmp/merge_log.json
```

### LinkedIn Connections export

LinkedIn's `Connections.csv` headers are `First Name, Last Name, URL, Email Address, Company, Position, Connected On`. Use:
```
merge-csv.py "<csv>" \
  --first-col "First Name" --last-col "Last Name" \
  --email-col "Email Address" --linkedin-col URL \
  --org-col Company \
  --summary-cols Position "Connected On" \
  --how-known "LinkedIn connection (imported)." \
  --source-label "LinkedIn export"
```

(Skip the first 2-3 metadata rows LinkedIn prepends — strip them before running.)

### Google Contacts export

Headers vary by version. Common subset: `Name, Given Name, Family Name, E-mail 1 - Value, Phone 1 - Value, Organization 1 - Name, Organization 1 - Title`.

If you encounter a CSV whose header you don't recognize, do *not* guess. Show the header to the user and confirm the column mapping before running.

## Notes for the LLM doing the work

- `MEMORY.md` already records: API path is REST not MCP (project_ingest_path); 601 Club is the primary network (project_601_club); Linear project is Ministry of Product / RolloMap (reference_linear). Apply these.
- When extracting from freeform notes, prefer **fewer high-confidence creates** over **many low-confidence ones**. The `MIN-500` issue tracks how to revisit single-name mentions later.
- The `/api/people/merge` endpoint does not currently merge `summary` / `linkedin_url` / `company` / `aliases` / `known_emails` (see MIN-504). Until fixed, PATCH the target with the source's missing fields *before* calling `/merge`, or skip auto-merge.
- Always write the `.log.json` even on partial failure — it's the auditable record and the basis for any rollback.
