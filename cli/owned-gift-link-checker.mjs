#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKERS = Math.max(1, Math.min(8, os.cpus().length || 1));
const DEFAULT_BUCKETS = 128;
const CHECKPOINT_VERSION = 2;
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
  node cli/owned-gift-link-checker.mjs --input ./codes.txt.gz --gzip auto [options]
  cat ./codes.txt | node cli/owned-gift-link-checker.mjs --stdin [options]
  npm run check:file -- --input ./codes.txt [options]

Required:
  --input, -i <path>               Path to input file
  --stdin                          Read input from stdin instead of a file

Optional:
  --output-dir, -o <path>          Output directory (default: ./output)
  --profile <normal|fast|turbo>    Performance profile (default: fast)
  --format <auto|lines|csv>        Input format (default: auto)
  --delimiter <auto|,|;|tab|pipe>  CSV delimiter (default: auto)
  --column <auto|index|name>       CSV column to inspect (default: auto)
  --header <true|false>            CSV first row is header (default: true)
  --gzip <auto|true|false>         Gzip input handling (default: auto)
  --workers <n>                    Worker threads (default from profile)
  --chunk-size <n>                 Rows per worker batch (default from profile)
  --buckets <n>                    Temp dedupe partitions (default from profile)
  --shard-size <n>                 Max lines per output shard, 0=single file (default: 0)
  --checkpoint-file <path>         Checkpoint file path (default: <output-dir>/checkpoint.json)
  --resume                         Resume from an existing checkpoint
  --webhook-url <https-url>        Optional webhook URL for your provided valid entries only
  --webhook-concurrency <n>        Concurrent webhook requests (default from profile)
  --webhook-batch-size <n>         Entries per webhook batch (default from profile)
  --quiet                          Less console output
  --keep-temp                      Keep temp partition files
  --help                           Show this help

Outputs:
  <output-dir>/valid.txt or valid-0001.txt, valid-0002.txt, ...
  <output-dir>/duplicates.txt or duplicates-0001.txt, duplicates-0002.txt, ...
  <output-dir>/invalid.txt or invalid-0001.txt, invalid-0002.txt, ...
  <output-dir>/summary.json
  <output-dir>/checkpoint.json
`);
}

function parseArgs(argv) {
  const args = {
    profile: 'fast',
    format: 'auto',
    delimiter: 'auto',
    column: 'auto',
    header: true,
    gzip: 'auto',
    outputDir: path.resolve(process.cwd(), 'output'),
    checkpointFile: null,
    resume: false,
    stdin: false,
    shardSize: 0,
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
      case '--stdin':
        args.stdin = true;
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
      case '--gzip':
        args.gzip = next;
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
      case '--shard-size':
        args.shardSize = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--checkpoint-file':
        args.checkpointFile = path.resolve(process.cwd(), next);
        index += 1;
        break;
      case '--resume':
        args.resume = true;
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
  if (typeof value === 'boolean') return value;
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

function resolveGzipMode(value) {
  if (value === true || value === false) return value;
  if (typeof value !== 'string') return 'auto';
  const normalized = value.toLowerCase();
  if (normalized === 'auto') return 'auto';
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid --gzip: ${value}`);
}

function resolveSettings(rawArgs) {
  if (!(rawArgs.profile in PROFILES)) {
    throw new Error(`Invalid profile: ${rawArgs.profile}`);
  }

  const profile = PROFILES[rawArgs.profile];
  const stdin = rawArgs.stdin || rawArgs.input === '-';
  const input = stdin ? null : rawArgs.input ? path.resolve(process.cwd(), rawArgs.input) : undefined;
  const checkpointFile = rawArgs.checkpointFile || path.join(rawArgs.outputDir, 'checkpoint.json');
  const settings = {
    ...rawArgs,
    stdin,
    input,
    inputLabel: stdin ? 'stdin' : input,
    checkpointFile,
    gzip: resolveGzipMode(rawArgs.gzip),
    workers: clampInt(rawArgs.workers, 1, 32, profile.workers),
    chunkSize: clampInt(rawArgs.chunkSize, 100, 250_000, profile.chunkSize),
    webhookConcurrency: clampInt(rawArgs.webhookConcurrency, 1, 32, profile.webhookConcurrency),
    webhookBatchSize: clampInt(rawArgs.webhookBatchSize, 1, 5_000, profile.webhookBatchSize),
    buckets: clampInt(rawArgs.buckets, 8, 1_024, profile.buckets || DEFAULT_BUCKETS),
    shardSize: clampInt(rawArgs.shardSize, 0, 5_000_000, 0),
  };

  if (!settings.stdin && !settings.input) {
    throw new Error('Missing required --input path or --stdin');
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
    quiet,
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

function chooseFormat(settings) {
  if (settings.format !== 'auto') return settings.format;
  if (!settings.stdin && settings.input.toLowerCase().endsWith('.csv')) return 'csv';
  if (!settings.stdin && settings.input.toLowerCase().endsWith('.csv.gz')) return 'csv';
  return 'lines';
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

function getElapsedMs(stats) {
  return Math.max(0, (Date.now() - stats.startedAt) + (stats.previousElapsedMs || 0));
}

function rowsPerMinute(processedRows, stats) {
  const elapsedMs = getElapsedMs(stats);
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

async function writeContent(stream, content) {
  if (!content) return;
  if (!stream.write(content)) {
    await new Promise((resolve, reject) => {
      stream.once('drain', resolve);
      stream.once('error', reject);
    });
  }
}

async function writeLines(stream, lines) {
  if (!lines.length) return;
  await writeContent(stream, `${lines.join('\n')}\n`);
}

async function endStream(stream) {
  await new Promise((resolve, reject) => {
    stream.end(() => resolve());
    stream.once('error', reject);
  });
}

class ShardedLineWriter {
  constructor(outputDir, baseName, shardSize = 0) {
    this.outputDir = outputDir;
    this.baseName = baseName;
    this.shardSize = shardSize;
    this.files = [];
    this.currentStream = null;
    this.currentLines = 0;
    this.currentIndex = 0;
  }

  nextFilePath() {
    if (!this.shardSize) {
      return path.join(this.outputDir, `${this.baseName}.txt`);
    }
    const suffix = String(this.currentIndex + 1).padStart(4, '0');
    return path.join(this.outputDir, `${this.baseName}-${suffix}.txt`);
  }

  async ensureStream() {
    if (this.currentStream) return;
    const filePath = this.nextFilePath();
    const stream = fs.createWriteStream(filePath, { flags: 'w' });
    stream.setMaxListeners(0);
    this.currentStream = stream;
    this.files.push(filePath);
    this.currentIndex += 1;
    this.currentLines = 0;
  }

  async rotateIfNeeded() {
    if (!this.shardSize || this.currentLines < this.shardSize) return;
    await endStream(this.currentStream);
    this.currentStream = null;
  }

  async writeLines(lines) {
    if (!lines.length) return;

    if (!this.shardSize) {
      await this.ensureStream();
      this.currentLines += lines.length;
      await writeLines(this.currentStream, lines);
      return;
    }

    let offset = 0;
    while (offset < lines.length) {
      await this.ensureStream();
      const remaining = this.shardSize - this.currentLines;
      const slice = lines.slice(offset, offset + remaining);
      this.currentLines += slice.length;
      offset += slice.length;
      await writeLines(this.currentStream, slice);
      await this.rotateIfNeeded();
    }
  }

  async close() {
    if (!this.currentStream) return;
    await endStream(this.currentStream);
    this.currentStream = null;
  }
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

function createInputStream(settings) {
  const rawStream = settings.stdin
    ? process.stdin
    : fs.createReadStream(settings.input);

  const shouldGunzip = settings.gzip === true
    || (settings.gzip === 'auto' && !settings.stdin && settings.input.toLowerCase().endsWith('.gz'));

  const stream = shouldGunzip
    ? rawStream.pipe(zlib.createGunzip())
    : rawStream;

  if (typeof stream.setEncoding === 'function') {
    stream.setEncoding('utf8');
  }

  return stream;
}

function buildOutputFiles(settings) {
  return {
    outputDir: settings.outputDir,
    summary: path.join(settings.outputDir, 'summary.json'),
    checkpoint: settings.checkpointFile,
    valid: path.join(settings.outputDir, settings.shardSize ? 'valid-0001.txt' : 'valid.txt'),
    duplicates: path.join(settings.outputDir, settings.shardSize ? 'duplicates-0001.txt' : 'duplicates.txt'),
    invalid: path.join(settings.outputDir, settings.shardSize ? 'invalid-0001.txt' : 'invalid.txt'),
    validFiles: [],
    duplicateFiles: [],
    invalidFiles: [],
  };
}

async function saveCheckpoint(checkpointFile, payload) {
  await ensureDir(path.dirname(checkpointFile));
  const tempFile = `${checkpointFile}.tmp`;
  await fsp.writeFile(tempFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fsp.rename(tempFile, checkpointFile);
}

async function loadCheckpoint(checkpointFile) {
  const content = await fsp.readFile(checkpointFile, 'utf8');
  return JSON.parse(content);
}

function buildCheckpointPayload(phase, settings, stats, outputFiles, extra = {}) {
  return {
    version: CHECKPOINT_VERSION,
    phase,
    updatedAt: new Date().toISOString(),
    settings: {
      inputLabel: settings.inputLabel,
      stdin: settings.stdin,
      profile: settings.profile,
      format: settings.format,
      delimiter: settings.delimiter,
      column: settings.column,
      header: settings.header,
      gzip: settings.gzip,
      workers: settings.workers,
      chunkSize: settings.chunkSize,
      buckets: settings.buckets,
      shardSize: settings.shardSize,
      webhookEnabled: Boolean(settings.webhookUrl),
      webhookConcurrency: settings.webhookConcurrency,
      webhookBatchSize: settings.webhookBatchSize,
      keepTemp: settings.keepTemp,
    },
    stats: {
      ...stats,
      previousElapsedMs: getElapsedMs(stats),
      startedAt: Date.now(),
    },
    outputFiles,
    ...extra,
  };
}

function validateResumeCompatibility(settings, checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    throw new Error('Checkpoint file is invalid');
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    throw new Error(`Checkpoint version mismatch: expected ${CHECKPOINT_VERSION}, got ${checkpoint.version}`);
  }
  if (!checkpoint.settings || checkpoint.settings.inputLabel !== settings.inputLabel) {
    throw new Error('Checkpoint input does not match current input source');
  }
}

function normalizeResumedState(checkpoint, stats, outputFiles) {
  const phase = checkpoint.phase;

  if (phase === 'phase1-complete') {
    stats.validUnique = 0;
    stats.duplicates = 0;
    stats.webhookDeliveries = 0;
    stats.webhookFailures = 0;
    outputFiles.validFiles = [];
    outputFiles.duplicateFiles = [];
    outputFiles.valid = path.join(outputFiles.outputDir, checkpoint.settings.shardSize ? 'valid-0001.txt' : 'valid.txt');
    outputFiles.duplicates = path.join(outputFiles.outputDir, checkpoint.settings.shardSize ? 'duplicates-0001.txt' : 'duplicates.txt');
  } else if (phase === 'phase2-complete') {
    stats.webhookDeliveries = 0;
    stats.webhookFailures = 0;
  }
}

async function phaseOnePartition(settings, logger, stats, outputFiles) {
  const tempDir = path.join(outputFiles.outputDir, `.tmp-${Date.now()}`);
  stats.tempDir = tempDir;
  await ensureDir(tempDir);

  const invalidWriter = new ShardedLineWriter(outputFiles.outputDir, 'invalid', settings.shardSize);
  const bucketStreams = Array.from({ length: settings.buckets }, (_, index) => {
    const bucketPath = path.join(tempDir, `bucket-${String(index).padStart(4, '0')}.txt`);
    const stream = fs.createWriteStream(bucketPath, { flags: 'w' });
    stream.setMaxListeners(0);
    return { index, path: bucketPath, stream };
  });

  const resolver = createRowResolver(settings, stats);
  const workerFile = path.join(__dirname, 'owned-gift-link-worker.mjs');
  const pool = new WorkerPool(workerFile, settings.workers);
  await pool.init();

  const rl = readline.createInterface({
    input: createInputStream(settings),
    crlfDelay: Infinity,
  });

  const inflight = new Set();
  let candidateChunk = [];

  const processWorkerResult = async (result) => {
    stats.processed += Number(result.processed || 0);
    stats.phaseOneValidCandidates += Array.isArray(result.valid) ? result.valid.length : 0;
    stats.invalid += Array.isArray(result.invalid) ? result.invalid.length : 0;

    if (Array.isArray(result.invalid) && result.invalid.length) {
      await invalidWriter.writeLines(result.invalid);
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
    let task;
    task = pool.run(rows)
      .then(processWorkerResult)
      .finally(() => inflight.delete(task));
    inflight.add(task);

    if (inflight.size >= settings.workers * 2) {
      await Promise.race(inflight);
    }
  };

  const progressTimer = settings.quiet
    ? null
    : setInterval(() => {
        logger.info(`phase 1: processed ${stats.processed.toLocaleString()} rows at ~${rowsPerMinute(stats.processed, stats).toLocaleString()} rows/min`);
      }, 5000);

  try {
    for await (const line of rl) {
      stats.inputLines += 1;
      const resolved = resolver(line);
      if (!resolved || resolved.skip) continue;

      if (resolved.invalid) {
        stats.totalRows += 1;
        stats.processed += 1;
        stats.invalid += 1;
        await invalidWriter.writeLines([resolved.invalid]);
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
    if (progressTimer) clearInterval(progressTimer);
    rl.close();
    await pool.destroy();
    await invalidWriter.close();
    for (const bucket of bucketStreams) {
      await endStream(bucket.stream);
    }
  }

  outputFiles.invalidFiles = invalidWriter.files.slice();
  if (outputFiles.invalidFiles[0]) outputFiles.invalid = outputFiles.invalidFiles[0];

  return {
    tempDir,
    bucketFiles: bucketStreams.map((entry) => entry.path),
    invalidFiles: outputFiles.invalidFiles.slice(),
  };
}

async function phaseTwoDedupe(settings, logger, stats, tempInfo, outputFiles) {
  const validWriter = new ShardedLineWriter(outputFiles.outputDir, 'valid', settings.shardSize);
  const duplicateWriter = new ShardedLineWriter(outputFiles.outputDir, 'duplicates', settings.shardSize);

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
          await validWriter.writeLines(validBatch.splice(0, validBatch.length));
        }
        if (force || duplicateBatch.length >= 5000) {
          await duplicateWriter.writeLines(duplicateBatch.splice(0, duplicateBatch.length));
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
    await validWriter.close();
    await duplicateWriter.close();
    if (!settings.keepTemp) {
      await fsp.rm(tempInfo.tempDir, { recursive: true, force: true });
    }
  }

  outputFiles.validFiles = validWriter.files.slice();
  outputFiles.duplicateFiles = duplicateWriter.files.slice();
  if (outputFiles.validFiles[0]) outputFiles.valid = outputFiles.validFiles[0];
  if (outputFiles.duplicateFiles[0]) outputFiles.duplicates = outputFiles.duplicateFiles[0];

  return {
    validFiles: outputFiles.validFiles.slice(),
    duplicateFiles: outputFiles.duplicateFiles.slice(),
  };
}

async function phaseThreeWebhook(settings, logger, stats, outputFiles) {
  if (!settings.webhookUrl) return;
  if (stats.validUnique === 0) {
    logger.warn('webhook skipped: no format-valid entries found');
    return;
  }

  const validFiles = outputFiles.validFiles.length ? outputFiles.validFiles : outputFiles.valid ? [outputFiles.valid] : [];
  if (!validFiles.length) {
    logger.warn('webhook skipped: valid output files were not found');
    return;
  }

  const totalBatches = Math.ceil(stats.validUnique / settings.webhookBatchSize);
  logger.info(`phase 3: sending ${stats.validUnique.toLocaleString()} valid entries in ${totalBatches.toLocaleString()} webhook batch(es)`);

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
    let task;
    task = sendBatch(entries, batchIndex).finally(() => inflight.delete(task));
    inflight.add(task);
    if (inflight.size >= settings.webhookConcurrency) {
      await Promise.race(inflight);
    }
  };

  for (const filePath of validFiles) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line) continue;
      batch.push(line);
      if (batch.length >= settings.webhookBatchSize) {
        await queueBatch(batch);
        batch = [];
      }
    }

    rl.close();
  }

  if (batch.length) {
    await queueBatch(batch);
  }
  await Promise.all(inflight);
}

function buildSummary(settings, stats, outputFiles) {
  const elapsedMs = getElapsedMs(stats);
  return {
    safety: {
      description: 'Local-only processing of user-provided entries.',
      externalDiscovery: false,
      randomGeneration: false,
      liveVerification: false,
    },
    settings: {
      input: settings.input,
      inputLabel: settings.inputLabel,
      stdin: settings.stdin,
      gzip: settings.gzip,
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
      shardSize: settings.shardSize,
      webhookEnabled: Boolean(settings.webhookUrl),
      webhookConcurrency: settings.webhookConcurrency,
      webhookBatchSize: settings.webhookBatchSize,
      keepTemp: settings.keepTemp,
      resume: settings.resume,
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
      averageRowsPerMinute: rowsPerMinute(stats.processed, stats),
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
  await ensureDir(settings.outputDir);

  const outputFiles = buildOutputFiles(settings);
  const stats = {
    startedAt: Date.now(),
    previousElapsedMs: 0,
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

  let inputStat = null;
  if (!settings.stdin) {
    inputStat = await fsp.stat(settings.input);
    if (!inputStat.isFile()) {
      throw new Error('Input path must be a regular file');
    }
  }

  let checkpoint = null;
  if (settings.resume) {
    checkpoint = await loadCheckpoint(settings.checkpointFile);
    validateResumeCompatibility(settings, checkpoint);
    Object.assign(stats, checkpoint.stats || {});
    stats.startedAt = Date.now();
    stats.previousElapsedMs = checkpoint.stats?.previousElapsedMs || checkpoint.stats?.elapsedMs || 0;
    if (checkpoint.outputFiles) {
      Object.assign(outputFiles, checkpoint.outputFiles);
    }
    normalizeResumedState(checkpoint, stats, outputFiles);
    logger.info(`resuming from checkpoint phase: ${checkpoint.phase}`);
  }

  logger.info(`input: ${settings.inputLabel}`);
  if (inputStat) logger.info(`size: ${inputStat.size.toLocaleString()} bytes`);
  logger.info(`profile=${settings.profile} workers=${settings.workers} chunkSize=${settings.chunkSize} buckets=${settings.buckets} shardSize=${settings.shardSize || 0}`);
  logger.info(`safety: local-only validation of your provided input; no generation or external probing`);

  let tempInfo = checkpoint?.tempInfo || null;

  if (!checkpoint || checkpoint.phase === 'new') {
    tempInfo = await phaseOnePartition(settings, logger, stats, outputFiles);
    await saveCheckpoint(settings.checkpointFile, buildCheckpointPayload('phase1-complete', settings, stats, outputFiles, { tempInfo }));
    logger.info('checkpoint saved after phase 1');
  }

  if (!checkpoint || checkpoint.phase === 'phase1-complete' || checkpoint.phase === 'new') {
    await phaseTwoDedupe(settings, logger, stats, tempInfo, outputFiles);
    await saveCheckpoint(settings.checkpointFile, buildCheckpointPayload('phase2-complete', settings, stats, outputFiles, { tempInfo }));
    logger.info('checkpoint saved after phase 2');
  }

  if (!checkpoint || checkpoint.phase === 'phase2-complete' || checkpoint.phase === 'phase1-complete' || checkpoint.phase === 'new') {
    await phaseThreeWebhook(settings, logger, stats, outputFiles);
  }

  const summary = buildSummary(settings, stats, outputFiles);
  await fsp.writeFile(outputFiles.summary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await saveCheckpoint(settings.checkpointFile, buildCheckpointPayload('complete', settings, stats, outputFiles, { tempInfo }));

  logger.info(`done in ${summary.stats.elapsedHuman}`);
  logger.info(`processed=${summary.stats.processed.toLocaleString()} valid=${summary.stats.validUnique.toLocaleString()} duplicates=${summary.stats.duplicates.toLocaleString()} invalid=${summary.stats.invalid.toLocaleString()}`);
  logger.info(`average=${summary.stats.averageRowsPerMinute.toLocaleString()} rows/min`);
  logger.info(`outputs: ${outputFiles.outputDir}`);
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
