# Owned Gift Link File Checker CLI

Safe local-only processor for files you provide.

## What it does
- streams large input files
- supports line-based, CSV, gzipped, stdin, and directory batch input
- supports include/exclude glob filters in directory mode
- auto or manual CSV column selection
- parallel local normalization workers
- parallel file processing in directory mode with bounded worker-budget sharing
- optional child-process directory mode for stronger isolation on multi-core machines
- live terminal progress bars when running in an interactive TTY
- per-phase timing breakdown in summaries
- exact deduplication using disk-backed partitions
- writes results directly to files for better multi-GB handling
- supports sharded output files for huge result sets
- supports optional JSONL outputs
- supports optional gzipped result outputs
- writes checkpoints so later phases can be resumed
- shows progress logs with rows/min and ETA for file inputs
- upgrades those progress logs to live single-line progress bars in interactive terminals
- optional webhook batches for your provided valid entries only

## What it does not do
- generate gift links
- brute-force or discover unknown links
- probe external services to verify status
- claim or redeem anything

## Quick start

```bash
npm run check:file -- --input ./codes.txt --profile turbo --output-dir ./output/run-1
```

## Gzipped input

```bash
npm run check:file -- \
  --input ./codes.txt.gz \
  --gzip auto \
  --profile turbo \
  --output-dir ./output/gzip-run
```

## Stdin input

```bash
cat ./codes.txt | npm run check:file -- --stdin --profile fast --output-dir ./output/stdin-run
```

## CSV example

```bash
npm run check:file -- \
  --input ./codes.csv \
  --format csv \
  --column link \
  --header true \
  --delimiter auto \
  --profile turbo \
  --output-dir ./output/csv-run
```

## JSONL outputs

```bash
npm run check:file -- \
  --input ./codes.txt \
  --output-format jsonl \
  --output-dir ./output/jsonl-run
```

Write both text and JSONL:

```bash
npm run check:file -- \
  --input ./codes.txt \
  --output-format both \
  --output-dir ./output/both-run
```

## Gzipped result outputs

```bash
npm run check:file -- \
  --input ./codes.txt \
  --output-format both \
  --gzip-output true \
  --output-dir ./output/gzip-output-run
```

## Resume checkpoints

The CLI writes a checkpoint file at the end of major phases.

```bash
npm run check:file -- \
  --input ./codes.txt \
  --output-dir ./output/resume-run \
  --checkpoint-file ./output/resume-run/checkpoint.json
```

Resume later:

```bash
npm run check:file -- \
  --input ./codes.txt \
  --output-dir ./output/resume-run \
  --checkpoint-file ./output/resume-run/checkpoint.json \
  --resume
```

## Sharded outputs

Split huge result files into shards of fixed line counts:

```bash
npm run check:file -- \
  --input ./codes.txt \
  --profile turbo \
  --shard-size 1000000 \
  --output-dir ./output/sharded-run
```

This produces files like:
- `valid-0001.txt`
- `valid-0002.txt`
- `duplicates-0001.txt`
- `invalid-0001.txt`

If JSONL and gzip are enabled, the same pattern becomes:
- `valid-0001.jsonl.gz`
- `valid-0002.jsonl.gz`
- `duplicates-0001.jsonl.gz`
- `invalid-0001.jsonl.gz`

## Directory batch processing

Process every regular file in a directory tree:

```bash
npm run check:file -- \
  --input-dir ./incoming \
  --profile turbo \
  --file-concurrency 4 \
  --output-dir ./output/batch-run
```

This creates one subdirectory per input file plus:
- `batch-summary.json`
- `batch-summary.csv`

By default, directory mode auto-picks inline vs child-process execution. You can force child-process fan-out on stronger machines:

```bash
npm run check:file -- \
  --input-dir ./incoming \
  --profile turbo \
  --workers 24 \
  --file-concurrency 6 \
  --process-mode child \
  --output-dir ./output/batch-child-run
```

### Directory filters

Include only CSV and gzipped files:

```bash
npm run check:file -- \
  --input-dir ./incoming \
  --include "**/*.csv,**/*.gz" \
  --output-dir ./output/filtered-run
```

Exclude archive folders or names:

```bash
npm run check:file -- \
  --input-dir ./incoming \
  --exclude "**/archive/**,*backup*" \
  --output-dir ./output/no-archive-run
```

## Useful options
- `--workers 16`
- `--file-concurrency 4`
- `--process-mode auto|inline|child`
- `--chunk-size 50000`
- `--buckets 512`
- `--shard-size 1000000`
- `--output-format txt|jsonl|both`
- `--gzip-output true`
- `--include "**/*.csv,**/*.txt.gz"`
- `--exclude "**/archive/**,*backup*"`
- `--webhook-url https://example.com/webhook`
- `--webhook-concurrency 8`
- `--webhook-batch-size 100`
- `--quiet`

## Outputs
- `valid.txt` or `valid-0001.txt`, `valid-0002.txt`, ...
- `duplicates.txt` or `duplicates-0001.txt`, `duplicates-0002.txt`, ...
- `invalid.txt` or `invalid-0001.txt`, `invalid-0002.txt`, ...
- optionally `valid.jsonl`, `duplicates.jsonl`, `invalid.jsonl`
- optionally gzipped `.gz` variants of those outputs
- `summary.json` (includes per-phase timing breakdown)
- `checkpoint.json`
- `batch-summary.json` in directory mode
- `batch-summary.csv` in directory mode

## Notes for large files
- Use `--profile turbo` for stronger CPUs.
- Increase `--chunk-size` for very large files if memory allows.
- Increase `--workers` up to your CPU core count.
- In directory mode, `--workers` acts as the total worker budget and `--file-concurrency` splits that budget across active files.
- `--process-mode auto` uses child processes when directory parallelism is greater than 1, otherwise inline execution.
- Live progress bars appear only in interactive terminals; redirected output falls back to periodic log lines.
- Exact dedupe is done in partitions on disk, which scales better than holding everything in memory.
- Use `--shard-size` when output files may become very large.
- Use `--output-format jsonl` or `both` when downstream tooling prefers structured lines.
- Use `--gzip-output true` when disk space matters more than CPU time.
- Webhook delivery time depends on network and the receiving server.
- Resume checkpoints currently resume completed major phases rather than byte-perfect mid-line recovery.
