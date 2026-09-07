# Setup and Usage

This project ships as:
- a browser app in `index.html`
- a Node.js CLI in `cli/`

## Prerequisites

### Browser app
- any modern desktop browser
- no build step
- no npm install required

### CLI
- Node.js 20+ recommended
- npm available
- no external package install currently required

## Browser setup

### Option A: open the file directly
Open `index.html` in your browser.

### Option B: serve it locally
Useful when you want a cleaner local URL or browser behavior closer to a hosted page.

```bash
python3 -m http.server 4173 --bind 0.0.0.0
```

Open:
- `http://127.0.0.1:4173`

## Browser usage

1. Upload a `.txt`, `.csv`, or `.log` file, or paste entries manually.
2. Pick a profile: `Normal`, `Fast`, or `Turbo`.
3. Choose input mode:
   - `Auto detect`
   - `One entry per line`
   - `CSV / delimited rows`
4. If using CSV, choose delimiter and column.
5. Keep **Stream uploaded file directly** enabled for large files.
6. Click **Start processing**.
7. Export the resulting valid, duplicate, or invalid rows if needed.

### Browser notes
- Large uploaded files are previewed first.
- If you disable streaming on a large uploaded file, the app now loads the full file into browser memory before processing so it does not accidentally process only the preview.
- Webhook delivery is validated before processing starts and requires an HTTPS URL.
- For multi-GB work, use the CLI instead of the browser UI.

## CLI setup

From the repository root:

```bash
npm run check:file:help
```

Basic example:

```bash
npm run check:file -- --input ./codes.txt --output-dir ./output/run-1
```

Detailed CLI guide:
- `cli/README.md`

## CLI validation

Run syntax and sanity checks:

```bash
npm run check:cli
npm run check:browser
npm run check:all
```

## CLI benchmark helper

Example 1M-row benchmark:

```bash
npm run benchmark:cli -- --rows 1000000 --files 4 --workers 8 --profile turbo
```

This helper:
- creates deterministic test data in a temp directory
- runs a single-file benchmark
- runs a directory inline benchmark
- runs a directory child-process benchmark
- prints measured throughput from the generated summaries
- reports the fastest mode on that machine

## Recommended tuning

### Browser
- small jobs: `Normal` or `Fast`
- larger jobs: `Turbo`
- keep streaming enabled for uploaded files
- use summary logging for best throughput

### CLI single-file
- start with `--profile turbo`
- raise `--workers` up to your CPU core count if useful
- raise `--chunk-size` when files are very large and RAM allows

### CLI directory mode
- use `--file-concurrency` for multiple files
- use `--process-mode child` on stronger multi-core machines
- remember that `--workers` is the total worker budget in directory mode
- good starting point on a stronger machine:

```bash
npm run check:file -- \
  --input-dir ./incoming \
  --profile turbo \
  --workers 16 \
  --file-concurrency 4 \
  --process-mode child \
  --output-dir ./output/batch-run
```

## Regression checklist used on this branch

### Browser
- inline browser script parses successfully
- referenced `id="..."` elements exist in `index.html`
- large-file preview logic reviewed and fixed for non-stream mode
- webhook pre-validation reviewed

### CLI
- `node --check cli/owned-gift-link-checker.mjs`
- `node --check cli/owned-gift-link-worker.mjs`
- `--help` output reviewed
- single-file smoke test
- gzip input/output smoke test
- JSONL smoke test
- stdin smoke test
- resume smoke test
- sharded output smoke test
- directory mode with include filters
- directory mode in `inline`, `child`, and `auto` process modes
- benchmarked single-file vs inline directory mode vs child-process directory mode

## Safety boundary

This repo is intentionally limited to:
- local normalization
- format validation
- deduplication
- local export
- optional webhook delivery for user-supplied valid entries only

It does not include:
- random code generation
- brute-force scanning
- service probing
- claiming or redemption flows
