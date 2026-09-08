# Generated Gift Link Format Self-Checker CLI

Safe local-only CLI that generates a fixed synthetic fixture and checks it immediately.

The default CLI flow no longer requires the user to provide, upload, paste, or share a file.

## What it does by default
- generates a deterministic local synthetic fixture
- runs the existing format normalizer/checker immediately
- deduplicates the generated entries
- classifies malformed or unsupported generated rows
- verifies expected valid, duplicate, and invalid counts
- verifies generated valid and duplicate output file contents
- writes a machine-readable `self-test-report.json`
- exits non-zero if any expected result does not match

## What it does not do
- generate random or redeemable gift links
- brute-force or discover unknown links
- probe external services to verify status
- call Discord APIs
- claim or redeem anything
- send the generated fixture to a webhook

## Quick start

Run the generated check with no input:

```bash
npm run generate-and-check
```

Equivalent explicit command:

```bash
npm run self-test
```

Direct Node command:

```bash
node cli/owned-gift-link-checker.mjs --self-test
```

You can also run the CLI entry without any input flags; it defaults to generated self-check mode:

```bash
node cli/owned-gift-link-checker.mjs
```

## Continuous loop mode

Use `--loop` with `--self-test` to keep regenerating the deterministic synthetic fixture and re-running the local self-check in an endless loop. It stops only when you interrupt it with **Ctrl+C** (the browser UI equivalent is **Start continuous loop** / **Stop**).

```bash
node cli/owned-gift-link-checker.mjs --self-test --loop
node cli/owned-gift-link-checker.mjs --self-test --loop --loop-delay 250
```

- `--loop` — keep generating and checking until interrupted; requires `--self-test`
- `--loop-delay <ms>` — pause between runs, `0`-`60000` (default: `100`)

Behaviour:
- progress lines are printed periodically (`loop run 25: self-check passed`) instead of one line per run
- a failed self-check is a result, not a reason to quit: the loop keeps checking until interrupted, with mismatch details throttled to the first failure and every 25th
- an unexpected error (for example an unwritable output directory) is retried, but 5 consecutive unexpected errors stop the loop with a clear message instead of spinning silently
- on stop it writes `self-test-loop-report.json` next to `self-test-report.json` with total runs, passed/failed counts, elapsed time, runs/minute, and the last run's report
- pressing Ctrl+C again before the active run finishes exits immediately with code `130`
- safety boundary is unchanged: local-only, fixed synthetic fixture, no random/redeemable codes, no network calls, no probing, no webhooks

## Performance safeguards

Generated self-check mode is intentionally lightweight:
- fixture rows are supplied in memory instead of written and re-read as input
- webhook delivery is disabled in self-test mode
- the generated fixture uses small chunk/bucket settings to avoid large-file overhead
- the same worker normalizer and dedupe/output phases are still exercised, so bugs in the checker path are caught

## Generated output

By default, self-test output is written to:

```text
output/self-test/
```

The fixture itself is generated in memory for speed. Files created after checking:
- `run/valid.txt` — normalized format-valid unique generated entries
- `run/duplicates.txt` — generated duplicates
- `run/invalid.txt` — generated malformed/unsupported rows
- `run/summary.json` — normal checker summary
- `self-test-report.json` — expected-vs-actual verification report
- `self-test-loop-report.json` — totals for `--loop` mode (written when the loop stops)

Use a custom output directory:

```bash
node cli/owned-gift-link-checker.mjs --self-test --output-dir ./output/my-generated-check
```

## Built-in repo scripts

```bash
npm run generate-and-check
npm run self-test
npm run check:file:help
npm run check:cli
npm run check:browser
npm run check:all
```

## Self-test fixture behavior

The fixture is fixed and deterministic. It includes:
- supported gift-link shapes
- raw-code shape
- duplicates
- unsupported host row
- malformed short row
- malformed whitespace/code-shape row
- blank row

Expected result counts:
- `inputLines`: 10
- `totalRows`: 9
- `processed`: 9
- `phaseOneValidCandidates`: 6
- `validUnique`: 4
- `duplicates`: 2
- `invalid`: 3

## Advanced local input modes

The CLI still contains local-only file/stdin/directory processing for maintainers who explicitly pass input flags. These modes inspect local data only and do not generate, discover, claim, redeem, or probe links.

Examples:

```bash
npm run check:file -- --input ./codes.txt --output-dir ./output/local-file-run
cat ./codes.txt | npm run check:file -- --stdin --output-dir ./output/stdin-run
npm run check:file -- --input-dir ./incoming --output-dir ./output/batch-run
```

Useful options for explicit local input modes:
- `--profile normal|fast|turbo`
- `--format auto|lines|csv`
- `--delimiter auto|,|;|tab|pipe`
- `--column auto|index|name`
- `--header true|false`
- `--gzip auto|true|false`
- `--output-format txt|jsonl|both`
- `--gzip-output true|false`
- `--workers 16`
- `--chunk-size 50000`
- `--buckets 512`
- `--shard-size 1000000`
- `--include "**/*.csv,**/*.txt.gz"`
- `--exclude "**/archive/**,*backup*"`
- `--loop` (requires `--self-test`)
- `--loop-delay 250`
- `--quiet`

Webhook options remain ignored in generated self-test mode so the generated fixture is never sent anywhere.
