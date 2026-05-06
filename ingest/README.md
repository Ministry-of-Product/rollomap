# Ingest

Drop files here, then ask Claude to ingest them. Claude reads each file, extracts people / interactions / notes / topics, and writes them into RolloMap via the REST API at `http://localhost:4000`.

The pipeline is implemented as a project-level skill at `.claude/skills/ingest/SKILL.md` — that file is the source of truth for the workflow, the supported formats, and the rules for when to refuse a drop.

## Workflow

1. Drop a file into `inbox/`.
2. In Claude Code, say **"ingest the inbox"** (or `/ingest`, or name a specific file). The `ingest` skill activates.
3. The skill will:
   - Health-check the API.
   - Detect the file format and dispatch (CSV → `merge-csv.py`; markdown/plaintext → image-strip + LLM extraction; vCard, eml/mbox → format parser).
   - Match each candidate person against existing DB records (by email → exact name → fuzzy first+last-token) before creating duplicates.
   - PATCH existing records or POST new ones via the REST API.
   - Move the file to `processed/<YYYY-MM-DD>/` and write a `<filename>.log.json` sidecar listing every ID created/updated for auditability and rollback.
   - Run a post-run dupe sweep (`suggest-merges.py`); if new candidate duplicates surfaced, file a Linear issue listing them.

## When the skill will REFUSE to ingest (by design)

The skill halts loudly rather than guessing. It will stop and ask before proceeding if:

- the API at `http://localhost:4000` is not reachable;
- the inbox is empty;
- you point it at a path outside `ingest/inbox/`;
- the file extension is not in `{.md, .txt, .csv, .tsv, .vcf, .json, .eml, .mbox}` (PDFs and Office docs are deliberately excluded — adding them is a conscious decision, not an implicit one);
- a `.txt` / `.md` file contains > 5 % non-printable bytes (binary masquerading as text);
- after image-stripping the cleaned text is still > 2 MB (too large for in-context extraction);
- the content does not look like contact / relationship data (source code, transactions, journals, medical records, etc.);
- a file with the same name + SHA-256 already exists under `processed/` (idempotency);
- the file contains sensitive PII (SSNs, credit-card numbers, government IDs) attached to people.

In each of those cases the skill will tell you exactly which rule fired and wait for direction.

## Supported drop types

| Format | Extension | What gets extracted |
| --- | --- | --- |
| Markdown / plain-text notes (e.g. meeting notes) | `.md`, `.txt` | People mentioned, topics, interactions (meetings, calls), open loops |
| Wild Apricot member roster | `.csv` | One person per row (recipe in `SKILL.md`) |
| LinkedIn connections export | `.csv` | One person per row (recipe in `SKILL.md`) |
| Google Contacts export | `.csv` | One person per row (column mapping confirmed interactively) |
| Generic / unknown CSV | `.csv` | Claude will surface the header and ask for column mapping |
| vCard | `.vcf` | Person + known emails / phones / org / title |
| Email export / mbox | `.eml`, `.mbox` | Interaction (type=email) with sender + recipients as participants |
| RolloMap-shaped JSON | `.json` | Validated then forwarded to the API |

For freeform formats Claude prefers fewer high-confidence creates over many low-confidence ones — single first-name mentions without a distinguishing signal are skipped and listed in the log under `skipped: [{reason: "ambiguous_first_name", ...}]` rather than guessed at.

## Conventions

- Files in `inbox/` and `processed/` are **gitignored** — they may contain personal data.
- One file per logical batch is fine.
- A sidecar `<filename>.hint.md` next to a drop file is read for ingestion hints ("these are all from a 2024 conference", "skip emails I already have", "this CSV's email column is `e1`").

## Reverting an ingest

Each `processed/<date>/<filename>.log.json` lists every entity ID created and updated. Ask Claude to "undo the ingest of `<filename>`" — it will DELETE the rows in the `created` array and (best effort) revert the `updated` ones using the API's correction-log history.

## Adding support for a new format

1. Drop a preprocessor / parser into `.claude/skills/ingest/scripts/` (Python, single-file, stdlib only when possible).
2. Add a row to the dispatcher table in `SKILL.md` and a recipe at the bottom if it's a structured source.
3. Run with `--dry-run` first; commit when the plan looks right.
