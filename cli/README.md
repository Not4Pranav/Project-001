# Owned Gift Link File Checker CLI

Safe local-only processor for files you provide.

## What it does
- streams large input files
- supports line-based or CSV input
- auto or manual CSV column selection
- parallel local normalization workers
- exact deduplication using disk-backed partitions
- writes results directly to files for better multi-GB handling
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

CSV example:

```bash
npm run check:file -- \
  --input ./codes.csv \
  --format csv \
  --column link \
  --header true \
  --profile turbo \
  --output-dir ./output/csv-run
```

## Outputs
- `valid.txt`
- `duplicates.txt`
- `invalid.txt`
- `summary.json`

## Notes for large files
- Use `--profile turbo` for stronger CPUs.
- Increase `--chunk-size` for very large files if memory allows.
- Increase `--workers` up to your CPU core count.
- Exact dedupe is done in partitions on disk, which scales better than holding everything in memory.
- Webhook delivery time depends on network and the receiving server.
