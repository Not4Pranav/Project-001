# Owned Gift Link File Checker CLI

Safe local-only processor for files you provide.

## What it does
- streams large input files
- supports line-based, CSV, gzipped, stdin, and directory batch input
- auto or manual CSV column selection
- parallel local normalization workers
- exact deduplication using disk-backed partitions
- writes results directly to files for better multi-GB handling
- supports sharded output files for huge result sets
- supports optional JSONL outputs
- supports optional gzipped result outputs
- writes checkpoints so later phases can be resumed
- shows progress logs with rows/min and ETA for file inputs
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
  --output-dir ./output/batch-run
```

This creates one subdirectory per input file plus a top-level `batch-summary.json`.

## Useful options
- `--workers 8`
- `--chunk-size 20000`
- `--buckets 256`
- `--shard-size 1000000`
- `--output-format txt|jsonl|both`
- `--gzip-output true`
- `--webhook-url https://example.com/webhook`
- `--webhook-concurrency 4`
- `--webhook-batch-size 50`
- `--quiet`

## Outputs
- `valid.txt` or `valid-0001.txt`, `valid-0002.txt`, ...
- `duplicates.txt` or `duplicates-0001.txt`, `duplicates-0002.txt`, ...
- `invalid.txt` or `invalid-0001.txt`, `invalid-0002.txt`, ...
- optionally `valid.jsonl`, `duplicates.jsonl`, `invalid.jsonl`
- optionally gzipped `.gz` variants of those outputs
- `summary.json`
- `checkpoint.json`
- `batch-summary.json` in directory mode

## Notes for large files
- Use `--profile turbo` for stronger CPUs.
- Increase `--chunk-size` for very large files if memory allows.
- Increase `--workers` up to your CPU core count.
- Exact dedupe is done in partitions on disk, which scales better than holding everything in memory.
- Use `--shard-size` when output files may become very large.
- Use `--output-format jsonl` or `both` when downstream tooling prefers structured lines.
- Use `--gzip-output true` when disk space matters more than CPU time.
- Webhook delivery time depends on network and the receiving server.
- Resume checkpoints currently resume completed major phases rather than byte-perfect mid-line recovery.
