# Owned Gift Link File Checker CLI

Safe local-only processor for files you provide.

## What it does
- streams large input files
- supports line-based, CSV, gzipped, and stdin input
- auto or manual CSV column selection
- parallel local normalization workers
- exact deduplication using disk-backed partitions
- writes results directly to files for better multi-GB handling
- supports sharded output files for huge result sets
- saves checkpoints so later phases can be resumed
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

## Outputs
- `valid.txt` or `valid-0001.txt`, `valid-0002.txt`, ...
- `duplicates.txt` or `duplicates-0001.txt`, `duplicates-0002.txt`, ...
- `invalid.txt` or `invalid-0001.txt`, `invalid-0002.txt`, ...
- `summary.json`
- `checkpoint.json`

## Notes for large files
- Use `--profile turbo` for stronger CPUs.
- Increase `--chunk-size` for very large files if memory allows.
- Increase `--workers` up to your CPU core count.
- Exact dedupe is done in partitions on disk, which scales better than holding everything in memory.
- Use `--shard-size` when output files may become very large.
- Webhook delivery time depends on network and the receiving server.
- Resume checkpoints currently resume completed major phases rather than byte-perfect mid-line recovery.
