# Owned Gift Link File Checker

Safe local-only tooling for processing gift links or codes that **you already have**.

This repository now includes two versions of the same product direction:
- a **browser UI** in `index.html`
- a **high-throughput CLI** in `cli/`

Both versions stay inside the same safety boundary:
- they process only user-provided input
- they normalize and format-check entries locally
- they deduplicate results
- they can optionally send batches of your own format-valid entries to a webhook
- they do **not** generate, brute-force, discover, probe, claim, or redeem anything

## Included versions

### 1) Browser UI
Single-file app in `index.html`.

Highlights:
- paste input or upload `.txt`, `.csv`, or `.log`
- streamed processing for large uploaded files
- browser worker parallelism
- pause / resume / stop
- CSV delimiter and column selection
- saved settings in local storage
- `.txt` and `.csv` result export
- optional HTTPS webhook batching for valid entries from your own file/list

### 2) CLI
Main entry point: `cli/owned-gift-link-checker.mjs`

Highlights:
- file, stdin, gzip, CSV, and directory input
- worker-thread normalization
- exact disk-backed dedupe for large files
- resumable checkpoints
- sharded outputs
- JSONL and gzip result output
- directory batch mode with include/exclude globs
- parallel file processing with shared worker budgets
- live TTY progress bars
- per-phase timing breakdown
- optional child-process batch mode for stronger multi-core throughput

Detailed CLI guide:
- `cli/README.md`

## Quick start

### Browser UI
Open `index.html` directly in a browser, or serve the repo locally:

```bash
python3 -m http.server 4173 --bind 0.0.0.0
```

Then open:
- `http://127.0.0.1:4173`

### CLI
Run the checker with Node:

```bash
npm run check:file -- --input ./codes.txt --output-dir ./output/run-1
```

Show CLI help:

```bash
npm run check:file:help
```

## Validation commands

This repo now includes simple built-in validation scripts for both versions:

```bash
npm run check:cli
npm run check:browser
npm run check:all
```

What they do:
- `check:cli` parses both CLI `.mjs` files with Node
- `check:browser` parses the inline browser script and verifies referenced element IDs exist in `index.html`
- `check:all` runs both checks together

## Benchmark command

A reproducible benchmark helper is included for the CLI:

```bash
npm run benchmark:cli -- --rows 1000000 --files 4 --workers 8 --profile turbo
```

It generates deterministic temporary input, runs:
- one large single-file pass
- one directory inline batch pass
- one directory child-process batch pass

and then prints the measured throughput from generated summary files, including the fastest mode on that machine.

## Documentation
- `SETUP.md` — end-to-end setup and usage notes
- `cli/README.md` — detailed CLI options and examples

## Repo layout
- `index.html` — browser UI
- `cli/owned-gift-link-checker.mjs` — CLI coordinator
- `cli/owned-gift-link-worker.mjs` — worker-thread normalizer
- `scripts/check-browser.mjs` — browser sanity checker
- `scripts/benchmark-cli.mjs` — CLI benchmark helper
- `package.json` — npm scripts for validation and CLI usage

## Notes
- For very large files, prefer the CLI.
- In the browser UI, keeping **streamed file mode enabled** is best for large uploads.
- In CLI directory mode, `--workers` is the total worker budget and `--file-concurrency` splits that budget across active files.
- Child-process mode is mainly useful on stronger local machines with multiple files to process in parallel.
