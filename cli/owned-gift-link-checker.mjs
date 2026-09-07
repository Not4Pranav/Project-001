#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKERS = Math.max(1, Math.min(8, os.cpus().length || 1));
const DEFAULT_BUCKETS = 128;
const PROFILES = {
  normal: { workers: 1, chunkSize: 2_000, webhookConcurrency: 1, webhookBatchSize: 10, buckets: 64 },
  fast: { workers: Math.min(2, DEFAULT_WORKERS), chunkSize: 8_000, webhookConcurrency: 2, webhookBatchSize: 25, buckets: 128 },
  turbo: { workers: DEFAULT_WORKERS, chunkSize: 20_000, webhookConcurrency: 4, webhookBatchSize: 50, buckets: 256 },
};

function printHelp() {
  console.log(`
Owned Gift Link File Checker CLI

Safe local-only processing for files you provide. This tool does not generate, brute-force,
discover, or probe gift links. It only normalizes, validates format, deduplicates, writes results,
and can optionally send batches of your provided format-valid entries to a webhook.

Usage:
  node cli/owned-gift-link-checker.mjs --input ./codes.txt [options]
  npm run check:file -- --input ./codes.txt [options]

Required:
  --input, -i <path>               Path to input file

Optional:
  --output-dir, -o <path>          Output directory (default: ./output)
  --profile <normal|fast|turbo>    Performance profile (default: fast)
  --format <auto|lines|csv>        Input format (default: auto)
  --delimiter <auto|,|;|tab|pipe>  CSV delimiter (default: auto)
  --column <auto|index|name>       CSV column to inspect (default: auto)
  --header <true|false>            CSV first row is header (default: true)
  --workers <n>                    Worker threads (default from profile)
  --chunk-size <n>                 Rows per worker batch (default from profile)
  --buckets <n>                    Temp dedupe partitions (default from profile)
  --webhook-url <https-url>        Optional webhook URL for your provided valid entries only
  --webhook-concurrency <n>        Concurrent webhook requests (default from profile)
  --webhook-batch-size <n>         Entries per webhook batch (default from profile)
  --quiet                          Less console output
  --keep-temp                      Keep temp partition files
  --help                           Show this help

Outputs:
  <output-dir>/valid.txt
  <output-dir>/duplicates.txt
  <output-dir>/invalid.txt
  <output-dir>/summary.json
`);
}

function parseArgs(argv) {
  const args = {
    profile: 'fast',
    format: 'auto',
    delimiter: 'auto',
    column: 'auto',
    header: true,
    outputDir: path.resolve(process.cwd(), 'output'),
    quiet: false,
    keepTemp: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];

    switch (token) {
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--input':
      case '-i':
        args.input = next;
        index += 1;
        break;
      case '--output-dir':
      case '-o':
        args.outputDir = path.resolve(process.cwd(), next);
        index += 1;
        break;
      case '--profile':
        args.profile = next;
        index += 1;
        break;
      case '--format':
        args.format = next;
        index += 1;
        break;
      case '--delimiter':
        args.delimiter = next;
        index += 1;
        break;
      case '--column':
        args.column = next;
        index += 1;
        break;
      case '--header':
        args.header = parseBoolean(next, true);
        index += 1;
        break;
      case '--workers':
        args.workers = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--chunk-size':
        args.chunkSize = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--buckets':
        args.buckets = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--webhook-url':
        args.webhookUrl = next;
        index += 1;
        break;
      case '--webhook-concurrency':
        args.webhookConcurrency = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--webhook-batch-size':
        args.webhookBatchSize = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--quiet':
        args.quiet = true;
        break;
      case '--keep-temp':
        args.keepTemp = true;
        break;
      default:
        if (token.startsWith('-')) {
          throw new Error(`Unknown argument: ${token}`);
        }
    }
  }

  return args;
}

function parseBoolean(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function clampInt(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function resolveSettings(rawArgs) {
  if (!(rawArgs.profile in PROFILES)) {
    throw new Error(`Invalid profile: ${rawArgs.profile}`);
  }

  const profile = PROFILES[rawArgs.profile];
  const settings = {
    ...rawArgs,
    input: rawArgs.input ? path.resolve(process.cwd(), rawArgs.input) : undefined,
    workers: clampInt(rawArgs.workers, 1, 32, profile.workers),
    chunkSize: clampInt(rawArgs.chunkSize, 100, 250_000, profile.chunkSize),
    webhookConcurrency: clampInt(rawArgs.webhookConcurrency, 1, 32, profile.webhookConcurrency),
    webhookBatchSize: clampInt(rawArgs.webhookBatchSize, 1, 5_000, profile.webhookBatchSize),
    buckets: clampInt(rawArgs.buckets, 8, 1_024, profile.buckets || DEFAULT_BUCKETS),
  };

  if (!settings.input) {
    throw new Error('Missing required --input path');
  }

  if (!['auto', 'lines', 'csv'].includes(settings.format)) {
    throw new Error(`Invalid --format: ${settings.format}`);
  }

  if (!['auto', ',', ';', 'tab', 'pipe'].includes(settings.delimiter)) {
    throw new Error(`Invalid --delimiter: ${settings.delimiter}`);
  }

  if (settings.webhookUrl) {
    const parsed = new URL(settings.webhookUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error('Webhook URL must use HTTPS');
    }
  }

  return settings;
}

function createLogger(quiet = false) {
  return {
    info(message) {
      if (!quiet) console.log(`[info] ${message}`);
    },
    warn(message) {
      console.warn(`[warn] ${message}`);
    },
    error(message) {
      console.error(`[error] ${message}`);
    },
  };
}

function detectDelimiter(line) {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = line.split(candidate).length;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

function parseCsvLine(line, delimiter) {
  const cells = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === delimiter) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function autoDetectGiftColumnIndex(headers) {
  if (!headers.length) return 0;
  const keywords = ['gift', 'giftlink', 'gift_link', 'code', 'gift code', 'giftcode', 'link', 'url', 'invite'];
  const normalized = headers.map((header) => String(header ?? '').trim().toLowerCase());
  for (const keyword of keywords) {
    const index = normalized.findIndex((value) => value.includes(keyword));
    if (index >= 0) return index;
  }
  return 0;
}

function normalizeDelimiter(value) {
  if (value === 'tab') return '\t';
  if (value === 'pipe') return '|';
  return value;
}

function createCsvResolver(settings, stats) {
  let headerConsumed = false;
  let delimiter = normalizeDelimiter(settings.delimiter);
  let columnMode = settings.column;
  let columnIndex = 0;

  if (typeof columnMode === 'string' && /^\d+$/.test(columnMode)) {
    columnIndex = Number.parseInt(columnMode, 10);
    columnMode = 'index';
  }

  return function resolveLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const activeDelimiter = delimiter === 'auto' ? detectDelimiter(line) : delimiter;
    const cells = parseCsvLine(line, activeDelimiter);

    if (!headerConsumed && settings.header) {
      headerConsumed = true;
      if (columnMode === 'auto') {
        columnIndex = autoDetectGiftColumnIndex(cells);
      } else if (columnMode !== 'index') {
        const normalizedNeedle = String(settings.column).trim().toLowerCase();
        const foundIndex = cells.findIndex((cell) => cell.trim().toLowerCase() === normalizedNeedle);
        if (foundIndex >= 0) columnIndex = foundIndex;
      }
      stats.csvColumnResolved = columnIndex;
      stats.csvHeaders = cells;
      return { skip: true };
    }

    if (!settings.header && columnMode !== 'index' && columnMode !== 'auto') {
      return { invalid: `${line}  ← Named CSV column requires --header true` };
    }

    if (!settings.header && columnMode === 'auto') {
      columnIndex = 0;
      stats.csvColumnResolved = 0;
    }

    const value = cells[columnIndex] ?? '';
    if (!value.trim()) {
      return { invalid: `${line}  ← Selected CSV column is empty` };
    }

    return { row: value.trim() };
  };
}

function createLineResolver() {
  return function resolveLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return null;
    return { row: trimmed };
  };
}

function chooseFormat(settings) {
  if (settings.format !== 'auto') return settings.format;
  return settings.input.toLowerCase().endsWith('.csv') ? 'csv' : 'lines';
}

function createRowResolver(settings, stats) {
  const format = chooseFormat(settings);
  stats.inputFormatResolved = format;
  return format === 'csv' ? createCsvResolver(settings, stats) : createLineResolver();
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rowsPerMinute(processedRows, startedAt) {
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs <= 0) return 0;
  return Math.round((processedRows / elapsedMs) * 60_000);
}

function humanDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

async function ensureDir(directoryPath) {
  await fsp.mkdir(directoryPath, { recursive: true });
}

async function writeLines(stream, lines) {
  if (!lines.length) return;
  const content = `${lines.join('\n')}\n`;
  if (!stream.write(content)) {
    await new Promise((resolve, reject) => {
      stream.once('drain', resolve);
      stream.once('error', reject);
    });
  }
}

async function endStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.once('error', reject);
  });
}

class WorkerPool {
  constructor(workerFile, size) {
    this.workerFile = workerFile;
    this.size = size;
    this.workers = [];
    this.idle = [];
    this.taskQueue = [];
    this.taskId = 0;
  }

  async init() {
    for (let index = 0; index < this.size; index += 1) {
      const worker = new Worker(this.workerFile, { type: 'module' });
      const state = { worker, busy: false, currentTask: null };

      worker.on('message', (message) => {
        const task = state.currentTask;
        state.currentTask = null;
        state.busy = false;
        this.idle.push(state);
        if (task) task.resolve(message);
        this.drain();
      });

      worker.on('error', (error) => {
        const task = state.currentTask;
        state.currentTask = null;
        state.busy = false;
        if (task) task.reject(error);
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          const task = state.currentTask;
          state.currentTask = null;
          state.busy = false;
          if (task) task.reject(new Error(`Worker exited with code ${code}`));
        }
      });

      this.workers.push(state);
      this.idle.push(state);
    }
  }

  run(rows) {
    return new Promise((resolve, reject) => {
      this.taskQueue.push({ id: ++this.taskId, rows, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.idle.length && this.taskQueue.length) {
      const workerState = this.idle.shift();
      const task = this.taskQueue.shift();
      workerState.busy = true;
      workerState.currentTask = task;
      workerState.worker.postMessage({ rows: task.rows });
    }
  }

  async destroy() {
    await Promise.all(this.workers.map(({ worker }) => worker.terminate()));
  }
}

async function phaseOnePartition(settings, logger, stats, outputFiles) {
  const tempDir = path.join(outputFiles.outputDir, `.tmp-${Date.now()}`);
  stats.tempDir = tempDir;
  await ensureDir(tempDir);

  const invalidStream = fs.createWriteStream(outputFiles.invalid, { flags: 'w' });
  invalidStream.setMaxListeners(0);
  const bucketStreams = Array.from({ length: settings.buckets }, (_, index) => {
    const bucketPath = path.join(tempDir, `bucket-${String(index).padStart(4, '0')}.txt`);
    const stream = fs.createWriteStream(bucketPath, { flags: 'w' });
    stream.setMaxListeners(0);
    return {
      index,
      path: bucketPath,
      stream,
    };
  });

  const resolver = createRowResolver(settings, stats);
  const workerFile = path.join(__dirname, 'owned-gift-link-worker.mjs');
  const pool = new WorkerPool(workerFile, settings.workers);
  await pool.init();

  const rl = readline.createInterface({
    input: fs.createReadStream(settings.input, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const inflight = new Set();
  let candidateChunk = [];

  const processWorkerResult = async (result) => {
    stats.processed += Number(result.processed || 0);
    stats.phaseOneValidCandidates += Array.isArray(result.valid) ? result.valid.length : 0;
    stats.invalid += Array.isArray(result.invalid) ? result.invalid.length : 0;

    if (Array.isArray(result.invalid) && result.invalid.length) {
      await writeLines(invalidStream, result.invalid);
    }

    if (Array.isArray(result.valid) && result.valid.length) {
      const grouped = new Map();
      for (const normalized of result.valid) {
        const bucketIndex = hashString(normalized) % settings.buckets;
        const bucketRows = grouped.get(bucketIndex) || [];
        bucketRows.push(normalized);
        grouped.set(bucketIndex, bucketRows);
      }

      for (const [bucketIndex, rows] of grouped) {
        await writeLines(bucketStreams[bucketIndex].stream, rows);
      }
    }
  };

  const queueChunk = async () => {
    if (!candidateChunk.length) return;
    const rows = candidateChunk;
    candidateChunk = [];
    const task = pool.run(rows)
      .then(processWorkerResult)
      .finally(() => inflight.delete(task));
    inflight.add(task);

    if (inflight.size >= settings.workers * 2) {
      await Promise.race(inflight);
    }
  };

  const progressTimer = setInterval(() => {
    logger.info(`phase 1: processed ${stats.processed.toLocaleString()} rows at ~${rowsPerMinute(stats.processed, stats.startedAt).toLocaleString()} rows/min`);
  }, logger.quiet ? 0x7fffffff : 5000);

  try {
    for await (const line of rl) {
      stats.inputLines += 1;
      const resolved = resolver(line);
      if (!resolved || resolved.skip) continue;

      if (resolved.invalid) {
        stats.totalRows += 1;
        stats.processed += 1;
        stats.invalid += 1;
        await writeLines(invalidStream, [resolved.invalid]);
      } else if (resolved.row) {
        stats.totalRows += 1;
        candidateChunk.push(resolved.row);
        if (candidateChunk.length >= settings.chunkSize) {
          await queueChunk();
        }
      }
    }

    await queueChunk();
    await Promise.all(inflight);
  } finally {
    clearInterval(progressTimer);
    rl.close();
    await pool.destroy();
    await endStream(invalidStream);
    for (const bucket of bucketStreams) {
      await endStream(bucket.stream);
    }
  }

  return { tempDir, bucketFiles: bucketStreams.map((entry) => entry.path) };
}

async function phaseTwoDedupe(settings, logger, stats, tempInfo, outputFiles) {
  const validStream = fs.createWriteStream(outputFiles.valid, { flags: 'w' });
  const duplicateStream = fs.createWriteStream(outputFiles.duplicates, { flags: 'w' });
  validStream.setMaxListeners(0);
  duplicateStream.setMaxListeners(0);

  try {
    for (let index = 0; index < tempInfo.bucketFiles.length; index += 1) {
      const bucketFile = tempInfo.bucketFiles[index];
      const seen = new Set();
      const rl = readline.createInterface({
        input: fs.createReadStream(bucketFile, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });

      const validBatch = [];
      const duplicateBatch = [];
      const flushIfNeeded = async (force = false) => {
        if (force || validBatch.length >= 5000) {
          await writeLines(validStream, validBatch.splice(0, validBatch.length));
        }
        if (force || duplicateBatch.length >= 5000) {
          await writeLines(duplicateStream, duplicateBatch.splice(0, duplicateBatch.length));
        }
      };

      for await (const line of rl) {
        if (!line) continue;
        if (seen.has(line)) {
          stats.duplicates += 1;
          duplicateBatch.push(line);
        } else {
          seen.add(line);
          stats.validUnique += 1;
          validBatch.push(line);
        }
        await flushIfNeeded(false);
      }

      await flushIfNeeded(true);
      rl.close();

      if (!settings.keepTemp) {
        await fsp.rm(bucketFile, { force: true });
      }

      if ((index + 1) % Math.max(1, Math.ceil(tempInfo.bucketFiles.length / 8)) === 0) {
        logger.info(`phase 2: deduped ${index + 1}/${tempInfo.bucketFiles.length} partitions`);
      }
    }
  } finally {
    await endStream(validStream);
    await endStream(duplicateStream);
    if (!settings.keepTemp) {
      await fsp.rm(tempInfo.tempDir, { recursive: true, force: true });
    }
  }
}

async function phaseThreeWebhook(settings, logger, stats, outputFiles) {
  if (!settings.webhookUrl) return;
  if (stats.validUnique === 0) {
    logger.warn('webhook skipped: no format-valid entries found');
    return;
  }

  const totalBatches = Math.ceil(stats.validUnique / settings.webhookBatchSize);
  logger.info(`phase 3: sending ${stats.validUnique.toLocaleString()} valid entries in ${totalBatches.toLocaleString()} webhook batch(es)`);

  const rl = readline.createInterface({
    input: fs.createReadStream(outputFiles.valid, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const inflight = new Set();
  let batch = [];
  let batchIndex = 0;

  const sendBatch = async (entries, currentIndex) => {
    const payload = {
      event: 'owned_gift_link_batch',
      generatedAt: new Date().toISOString(),
      batchIndex: currentIndex,
      totalBatches,
      count: entries.length,
      entries,
      summary: {
        totalRows: stats.totalRows,
        processed: stats.processed,
        validUnique: stats.validUnique,
        duplicates: stats.duplicates,
        invalid: stats.invalid,
        workers: settings.workers,
        chunkSize: settings.chunkSize,
        format: stats.inputFormatResolved,
      },
    };

    try {
      const response = await fetch(settings.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      stats.webhookDeliveries += 1;
    } catch (error) {
      stats.webhookFailures += 1;
      logger.warn(`webhook batch ${currentIndex}/${totalBatches} failed: ${error.message}`);
    }
  };

  const queueBatch = async (entries) => {
    batchIndex += 1;
    const task = sendBatch(entries, batchIndex).finally(() => inflight.delete(task));
    inflight.add(task);
    if (inflight.size >= settings.webhookConcurrency) {
      await Promise.race(inflight);
    }
  };

  for await (const line of rl) {
    if (!line) continue;
    batch.push(line);
    if (batch.length >= settings.webhookBatchSize) {
      await queueBatch(batch);
      batch = [];
    }
  }

  rl.close();
  if (batch.length) {
    await queueBatch(batch);
  }
  await Promise.all(inflight);
}

function buildSummary(settings, stats, outputFiles) {
  const endedAt = Date.now();
  const elapsedMs = endedAt - stats.startedAt;
  return {
    safety: {
      description: 'Local-only processing of user-provided entries.',
      externalDiscovery: false,
      randomGeneration: false,
      liveVerification: false,
    },
    settings: {
      input: settings.input,
      outputDir: outputFiles.outputDir,
      profile: settings.profile,
      format: settings.format,
      resolvedFormat: stats.inputFormatResolved,
      delimiter: settings.delimiter,
      csvColumn: settings.column,
      csvColumnResolved: stats.csvColumnResolved,
      header: settings.header,
      workers: settings.workers,
      chunkSize: settings.chunkSize,
      buckets: settings.buckets,
      webhookEnabled: Boolean(settings.webhookUrl),
      webhookConcurrency: settings.webhookConcurrency,
      webhookBatchSize: settings.webhookBatchSize,
      keepTemp: settings.keepTemp,
    },
    files: outputFiles,
    stats: {
      inputLines: stats.inputLines,
      totalRows: stats.totalRows,
      processed: stats.processed,
      phaseOneValidCandidates: stats.phaseOneValidCandidates,
      validUnique: stats.validUnique,
      duplicates: stats.duplicates,
      invalid: stats.invalid,
      webhookDeliveries: stats.webhookDeliveries,
      webhookFailures: stats.webhookFailures,
      elapsedMs,
      elapsedHuman: humanDuration(elapsedMs),
      averageRowsPerMinute: rowsPerMinute(stats.processed, stats.startedAt),
    },
  };
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  if (rawArgs.help) {
    printHelp();
    return;
  }

  const settings = resolveSettings(rawArgs);
  const logger = createLogger(settings.quiet);
  logger.quiet = settings.quiet;

  const inputStat = await fsp.stat(settings.input);
  if (!inputStat.isFile()) {
    throw new Error('Input path must be a regular file');
  }

  await ensureDir(settings.outputDir);

  const outputFiles = {
    outputDir: settings.outputDir,
    valid: path.join(settings.outputDir, 'valid.txt'),
    duplicates: path.join(settings.outputDir, 'duplicates.txt'),
    invalid: path.join(settings.outputDir, 'invalid.txt'),
    summary: path.join(settings.outputDir, 'summary.json'),
  };

  const stats = {
    startedAt: Date.now(),
    inputLines: 0,
    totalRows: 0,
    processed: 0,
    phaseOneValidCandidates: 0,
    validUnique: 0,
    duplicates: 0,
    invalid: 0,
    webhookDeliveries: 0,
    webhookFailures: 0,
    inputFormatResolved: 'lines',
    csvColumnResolved: 0,
    csvHeaders: [],
  };

  logger.info(`input: ${settings.input}`);
  logger.info(`size: ${inputStat.size.toLocaleString()} bytes`);
  logger.info(`profile=${settings.profile} workers=${settings.workers} chunkSize=${settings.chunkSize} buckets=${settings.buckets}`);
  logger.info(`safety: local-only validation of your provided file; no generation or external probing`);

  const tempInfo = await phaseOnePartition(settings, logger, stats, outputFiles);
  await phaseTwoDedupe(settings, logger, stats, tempInfo, outputFiles);
  await phaseThreeWebhook(settings, logger, stats, outputFiles);

  const summary = buildSummary(settings, stats, outputFiles);
  await fsp.writeFile(outputFiles.summary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  logger.info(`done in ${summary.stats.elapsedHuman}`);
  logger.info(`processed=${summary.stats.processed.toLocaleString()} valid=${summary.stats.validUnique.toLocaleString()} duplicates=${summary.stats.duplicates.toLocaleString()} invalid=${summary.stats.invalid.toLocaleString()}`);
  logger.info(`average=${summary.stats.averageRowsPerMinute.toLocaleString()} rows/min`);
  logger.info(`outputs: ${outputFiles.outputDir}`);
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
