#!/usr/bin/env node

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const SCRIPT_FILE = fileURLToPath(import.meta.url);
const __dirname = path.dirname(SCRIPT_FILE);
const DEFAULT_WORKERS = Math.max(1, Math.min(32, os.availableParallelism?.() || os.cpus().length || 1));
const DEFAULT_BUCKETS = 128;
const CHECKPOINT_VERSION = 2;
const DEDUPE_FLUSH_SIZE = 20_000;
const PHASE_ONE_QUEUE_MULTIPLIER = 4;
const PROFILES = {
  normal: { workers: 1, chunkSize: 4_000, webhookConcurrency: 1, webhookBatchSize: 10, buckets: 64 },
  fast: { workers: Math.min(4, DEFAULT_WORKERS), chunkSize: 16_000, webhookConcurrency: 2, webhookBatchSize: 25, buckets: 256 },
  turbo: { workers: DEFAULT_WORKERS, chunkSize: 50_000, webhookConcurrency: 8, webhookBatchSize: 100, buckets: 512 },
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
  node cli/owned-gift-link-checker.mjs --input-dir ./incoming [options]
  cat ./codes.txt | node cli/owned-gift-link-checker.mjs --stdin [options]
  npm run check:file -- --input ./codes.txt [options]

Required:
  --input, -i <path>               Path to input file
  --input-dir <path>               Process all regular files in a directory tree
  --stdin                          Read input from stdin instead of a file

Optional:
  --output-dir, -o <path>          Output directory (default: ./output)
  --profile <normal|fast|turbo>    Performance profile (default: fast)
  --format <auto|lines|csv>        Input format (default: auto)
  --delimiter <auto|,|;|tab|pipe>  CSV delimiter (default: auto)
  --column <auto|index|name>       CSV column to inspect (default: auto)
  --header <true|false>            CSV first row is header (default: true)
  --gzip <auto|true|false>         Gzip input handling (default: auto)
  --gzip-output <true|false>       Compress result outputs as .gz (default: false)
  --output-format <txt|jsonl|both> Result output format(s) (default: txt)
  --include <glob[,glob...]>       Directory mode include glob(s)
  --exclude <glob[,glob...]>       Directory mode exclude glob(s)
  --file-concurrency <n>           Directory mode parallel files (default from profile)
  --process-mode <auto|inline|child>
                                   Directory mode execution strategy (default: auto)
  --workers <n>                    Worker thread budget (single file) or total worker budget (directory mode)
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
  <output-dir>/valid*.txt or valid*.jsonl (optionally .gz)
  <output-dir>/duplicates*.txt or duplicates*.jsonl (optionally .gz)
  <output-dir>/invalid*.txt or invalid*.jsonl (optionally .gz)
  <output-dir>/summary.json
  <output-dir>/checkpoint.json
  <output-dir>/batch-summary.json (directory mode)
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
    gzipOutput: false,
    outputFormat: 'txt',
    outputDir: path.resolve(process.cwd(), 'output'),
    checkpointFile: null,
    resume: false,
    stdin: false,
    inputDir: null,
    include: [],
    exclude: [],
    fileConcurrency: null,
    processMode: 'auto',
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
      case '--input-dir':
        args.inputDir = path.resolve(process.cwd(), next);
        index += 1;
        break;
      case '--include':
        args.include.push(...String(next || '').split(',').map((value) => value.trim()).filter(Boolean));
        index += 1;
        break;
      case '--exclude':
        args.exclude.push(...String(next || '').split(',').map((value) => value.trim()).filter(Boolean));
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
      case '--gzip':
        args.gzip = next;
        index += 1;
        break;
      case '--gzip-output':
        args.gzipOutput = parseBoolean(next, false);
        index += 1;
        break;
      case '--output-format':
        args.outputFormat = next;
        index += 1;
        break;
      case '--file-concurrency':
        args.fileConcurrency = Number.parseInt(next, 10);
        index += 1;
        break;
      case '--process-mode':
        args.processMode = next;
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
  const inputDir = rawArgs.inputDir ? path.resolve(process.cwd(), rawArgs.inputDir) : null;
  const input = stdin ? null : rawArgs.input ? path.resolve(process.cwd(), rawArgs.input) : undefined;
  const checkpointFile = rawArgs.checkpointFile || path.join(rawArgs.outputDir, 'checkpoint.json');
  const defaultFileConcurrency = inputDir ? Math.max(1, Math.min(4, profile.workers)) : 1;
  const settings = {
    ...rawArgs,
    stdin,
    inputDir,
    input,
    inputLabel: stdin ? 'stdin' : inputDir || input,
    checkpointFile,
    gzip: resolveGzipMode(rawArgs.gzip),
    workers: clampInt(rawArgs.workers, 1, 64, profile.workers),
    fileConcurrency: clampInt(rawArgs.fileConcurrency, 1, 16, defaultFileConcurrency),
    processMode: rawArgs.processMode || 'auto',
    chunkSize: clampInt(rawArgs.chunkSize, 100, 500_000, profile.chunkSize),
    webhookConcurrency: clampInt(rawArgs.webhookConcurrency, 1, 32, profile.webhookConcurrency),
    webhookBatchSize: clampInt(rawArgs.webhookBatchSize, 1, 5_000, profile.webhookBatchSize),
    buckets: clampInt(rawArgs.buckets, 8, 1_024, profile.buckets || DEFAULT_BUCKETS),
    shardSize: clampInt(rawArgs.shardSize, 0, 5_000_000, 0),
  };

  if ([settings.stdin, Boolean(settings.input), Boolean(settings.inputDir)].filter(Boolean).length !== 1) {
    throw new Error('Use exactly one of --input, --input-dir, or --stdin');
  }

  if (!['auto', 'lines', 'csv'].includes(settings.format)) {
    throw new Error(`Invalid --format: ${settings.format}`);
  }

  if (!['auto', ',', ';', 'tab', 'pipe'].includes(settings.delimiter)) {
    throw new Error(`Invalid --delimiter: ${settings.delimiter}`);
  }

  if (!['txt', 'jsonl', 'both'].includes(settings.outputFormat)) {
    throw new Error(`Invalid --output-format: ${settings.outputFormat}`);
  }

  if (!['auto', 'inline', 'child'].includes(settings.processMode)) {
    throw new Error(`Invalid --process-mode: ${settings.processMode}`);
  }

  if (settings.resume && settings.stdin) {
    throw new Error('--resume is not supported with --stdin');
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
  const useProgress = !quiet && Boolean(process.stdout.isTTY);
  let hasProgressLine = false;

  function clearProgress() {
    if (!useProgress || !hasProgressLine) return;
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    hasProgressLine = false;
  }

  function printLine(method, prefix, message, always = false) {
    clearProgress();
    if (always || !quiet) {
      method(`${prefix} ${message}`);
    }
  }

  return {
    quiet,
    useProgress,
    info(message) {
      printLine(console.log, '[info]', message);
    },
    warn(message) {
      printLine(console.warn, '[warn]', message, true);
    },
    error(message) {
      printLine(console.error, '[error]', message, true);
    },
    progress(message) {
      if (!useProgress) return;
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
      process.stdout.write(message);
      hasProgressLine = true;
    },
    stopProgress(finalMessage = '') {
      if (!useProgress) return;
      clearProgress();
      if (finalMessage) {
        console.log(finalMessage);
      }
    },
    clearProgress,
  };
}

function renderProgressBar(current, total, label, extra = '') {
  const safeTotal = Math.max(1, total || 1);
  const ratio = Math.max(0, Math.min(1, current / safeTotal));
  const width = 26;
  const filled = Math.round(ratio * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
  const percent = `${(ratio * 100).toFixed(1)}%`;
  const detail = extra ? ` | ${extra}` : '';
  return `${label} [${bar}] ${percent} (${current}/${safeTotal})${detail}`;
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

function beginPhase(stats, phaseKey) {
  stats.phaseStarts = stats.phaseStarts || {};
  stats.phaseStarts[phaseKey] = Date.now();
}

function endPhase(stats, phaseKey) {
  const startedAt = stats.phaseStarts?.[phaseKey];
  if (!startedAt) return 0;
  const elapsed = Date.now() - startedAt;
  stats.phaseTimings = stats.phaseTimings || {};
  stats.phaseTimings[phaseKey] = (stats.phaseTimings[phaseKey] || 0) + elapsed;
  delete stats.phaseStarts[phaseKey];
  return elapsed;
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
  constructor(outputDir, baseName, shardSize = 0, options = {}) {
    this.outputDir = outputDir;
    this.baseName = baseName;
    this.shardSize = shardSize;
    this.extension = options.extension || 'txt';
    this.gzipOutput = Boolean(options.gzipOutput);
    this.serializer = options.serializer || ((value) => String(value));
    this.files = [];
    this.currentStream = null;
    this.currentFileStream = null;
    this.currentLines = 0;
    this.currentIndex = 0;
  }

  nextFilePath() {
    const suffix = this.shardSize ? `-${String(this.currentIndex + 1).padStart(4, '0')}` : '';
    const fileName = `${this.baseName}${suffix}.${this.extension}`;
    return path.join(this.outputDir, this.gzipOutput ? `${fileName}.gz` : fileName);
  }

  async ensureStream() {
    if (this.currentStream) return;
    const filePath = this.nextFilePath();
    const fileStream = fs.createWriteStream(filePath, { flags: 'w' });
    fileStream.setMaxListeners(0);

    if (this.gzipOutput) {
      const gzipStream = zlib.createGzip();
      gzipStream.setMaxListeners(0);
      gzipStream.pipe(fileStream);
      this.currentStream = gzipStream;
      this.currentFileStream = fileStream;
    } else {
      this.currentStream = fileStream;
      this.currentFileStream = fileStream;
    }

    this.files.push(filePath);
    this.currentIndex += 1;
    this.currentLines = 0;
  }

  async closeCurrentStream() {
    if (!this.currentStream) return;
    const writable = this.currentStream;
    const fileStream = this.currentFileStream;
    this.currentStream = null;
    this.currentFileStream = null;

    await new Promise((resolve, reject) => {
      writable.once('error', reject);
      writable.end();
      if (fileStream && fileStream !== writable) {
        fileStream.once('error', reject);
        fileStream.once('close', resolve);
      } else {
        writable.once('close', resolve);
      }
    });
  }

  async rotateIfNeeded() {
    if (!this.shardSize || this.currentLines < this.shardSize) return;
    await this.closeCurrentStream();
  }

  async writeLines(lines) {
    if (!lines.length) return;

    if (!this.shardSize) {
      await this.ensureStream();
      this.currentLines += lines.length;
      await writeLines(this.currentStream, lines.map(this.serializer));
      return;
    }

    let offset = 0;
    while (offset < lines.length) {
      await this.ensureStream();
      const remaining = this.shardSize - this.currentLines;
      const slice = lines.slice(offset, offset + remaining);
      this.currentLines += slice.length;
      offset += slice.length;
      await writeLines(this.currentStream, slice.map(this.serializer));
      await this.rotateIfNeeded();
    }
  }

  async close() {
    await this.closeCurrentStream();
  }
}

function escapeJsonLineEntry(value) {
  return JSON.stringify({ entry: value });
}

function createCategoryWriters(settings, outputDir, baseName) {
  const writers = [];
  if (settings.outputFormat === 'txt' || settings.outputFormat === 'both') {
    writers.push(new ShardedLineWriter(outputDir, baseName, settings.shardSize, {
      extension: 'txt',
      gzipOutput: settings.gzipOutput,
      serializer: (value) => String(value),
    }));
  }
  if (settings.outputFormat === 'jsonl' || settings.outputFormat === 'both') {
    writers.push(new ShardedLineWriter(outputDir, baseName, settings.shardSize, {
      extension: 'jsonl',
      gzipOutput: settings.gzipOutput,
      serializer: escapeJsonLineEntry,
    }));
  }
  return writers;
}

async function writeToAllWriters(writers, lines) {
  await Promise.all(writers.map((writer) => writer.writeLines(lines)));
}

async function closeAllWriters(writers) {
  await Promise.all(writers.map((writer) => writer.close()));
}

function getWriterFileGroups(writers) {
  const output = {};
  for (const writer of writers) {
    const key = writer.extension === 'txt' ? 'txtFiles' : `${writer.extension}Files`;
    output[key] = writer.files.slice();
  }
  return output;
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

function createTextReadStream(filePath) {
  const rawStream = fs.createReadStream(filePath);
  const stream = filePath.toLowerCase().endsWith('.gz')
    ? rawStream.pipe(zlib.createGunzip())
    : rawStream;

  if (typeof stream.setEncoding === 'function') {
    stream.setEncoding('utf8');
  }

  return stream;
}

function createInputStream(settings) {
  if (settings.stdin) {
    const shouldGunzip = settings.gzip === true;
    const stream = shouldGunzip
      ? process.stdin.pipe(zlib.createGunzip())
      : process.stdin;
    if (typeof stream.setEncoding === 'function') {
      stream.setEncoding('utf8');
    }
    return {
      stream,
      progressBytesReader: null,
      totalBytes: null,
    };
  }

  const rawStream = fs.createReadStream(settings.input);
  const shouldGunzip = settings.gzip === true
    || (settings.gzip === 'auto' && settings.input.toLowerCase().endsWith('.gz'));

  const stream = shouldGunzip
    ? rawStream.pipe(zlib.createGunzip())
    : rawStream;

  if (typeof stream.setEncoding === 'function') {
    stream.setEncoding('utf8');
  }

  return {
    stream,
    progressBytesReader: () => rawStream.bytesRead || 0,
    totalBytes: settings.inputSize || null,
  };
}

function buildOutputFiles(settings) {
  return {
    outputDir: settings.outputDir,
    summary: path.join(settings.outputDir, 'summary.json'),
    checkpoint: settings.checkpointFile,
    batchSummary: path.join(settings.outputDir, 'batch-summary.json'),
    valid: null,
    duplicates: null,
    invalid: null,
    validFiles: [],
    duplicateFiles: [],
    invalidFiles: [],
    validTxtFiles: [],
    validJsonlFiles: [],
    duplicateTxtFiles: [],
    duplicateJsonlFiles: [],
    invalidTxtFiles: [],
    invalidJsonlFiles: [],
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
      inputDir: settings.inputDir,
      include: settings.include,
      exclude: settings.exclude,
      profile: settings.profile,
      format: settings.format,
      delimiter: settings.delimiter,
      column: settings.column,
      header: settings.header,
      gzip: settings.gzip,
      gzipOutput: settings.gzipOutput,
      outputFormat: settings.outputFormat,
      workers: settings.workers,
      fileConcurrency: settings.fileConcurrency,
      processMode: settings.processMode,
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
  stats.phaseStarts = {};
  stats.phaseTimings = stats.phaseTimings || { partitionMs: 0, dedupeMs: 0, webhookMs: 0 };

  if (phase === 'phase1-complete') {
    stats.validUnique = 0;
    stats.duplicates = 0;
    stats.webhookDeliveries = 0;
    stats.webhookFailures = 0;
    outputFiles.valid = null;
    outputFiles.duplicates = null;
    outputFiles.validFiles = [];
    outputFiles.duplicateFiles = [];
    outputFiles.validTxtFiles = [];
    outputFiles.validJsonlFiles = [];
    outputFiles.duplicateTxtFiles = [];
    outputFiles.duplicateJsonlFiles = [];
  } else if (phase === 'phase2-complete') {
    stats.webhookDeliveries = 0;
    stats.webhookFailures = 0;
  }
}

async function phaseOnePartition(settings, logger, stats, outputFiles) {
  const tempDir = path.join(outputFiles.outputDir, `.tmp-${Date.now()}`);
  stats.tempDir = tempDir;
  await ensureDir(tempDir);

  const invalidWriters = createCategoryWriters(settings, outputFiles.outputDir, 'invalid');
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

  const inputHandle = createInputStream(settings);
  const rl = readline.createInterface({
    input: inputHandle.stream,
    crlfDelay: Infinity,
  });

  const inflight = new Set();
  let candidateChunk = [];

  const processWorkerResult = async (result) => {
    stats.processed += Number(result.processed || 0);
    stats.phaseOneValidCandidates += Array.isArray(result.valid) ? result.valid.length : 0;
    stats.invalid += Array.isArray(result.invalid) ? result.invalid.length : 0;

    if (Array.isArray(result.invalid) && result.invalid.length) {
      await writeToAllWriters(invalidWriters, result.invalid);
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

    if (inflight.size >= Math.max(2, settings.workers * PHASE_ONE_QUEUE_MULTIPLIER)) {
      await Promise.race(inflight);
    }
  };

  const progressTimer = settings.quiet
    ? null
    : setInterval(() => {
        const rpm = rowsPerMinute(stats.processed, stats).toLocaleString();
        const bytesRead = inputHandle.progressBytesReader ? inputHandle.progressBytesReader() : 0;
        if (inputHandle.totalBytes) {
          const ratio = Math.max(0, Math.min(1, bytesRead / inputHandle.totalBytes));
          const elapsedMs = getElapsedMs(stats);
          const etaMs = ratio > 0 ? Math.max(0, Math.round((elapsedMs / ratio) - elapsedMs)) : 0;
          const extra = `${stats.processed.toLocaleString()} rows | ~${rpm}/min | eta ${humanDuration(etaMs)}`;
          if (logger.useProgress) {
            logger.progress(renderProgressBar(bytesRead, inputHandle.totalBytes, 'phase1', extra));
          } else {
            logger.info(`phase 1: processed ${stats.processed.toLocaleString()} rows at ~${rpm} rows/min | ${(ratio * 100).toFixed(1)}% input read | eta ${humanDuration(etaMs)}`);
          }
        } else if (logger.useProgress) {
          logger.progress(`phase1 | ${stats.processed.toLocaleString()} rows | ~${rpm}/min`);
        } else {
          logger.info(`phase 1: processed ${stats.processed.toLocaleString()} rows at ~${rpm} rows/min`);
        }
      }, logger.useProgress ? 250 : 5000);

  try {
    for await (const line of rl) {
      stats.inputLines += 1;
      const resolved = resolver(line);
      if (!resolved || resolved.skip) continue;

      if (resolved.invalid) {
        stats.totalRows += 1;
        stats.processed += 1;
        stats.invalid += 1;
        await writeToAllWriters(invalidWriters, [resolved.invalid]);
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
    logger.stopProgress();
    rl.close();
    await pool.destroy();
    await closeAllWriters(invalidWriters);
    for (const bucket of bucketStreams) {
      await endStream(bucket.stream);
    }
  }

  const invalidGroups = getWriterFileGroups(invalidWriters);
  outputFiles.invalidTxtFiles = invalidGroups.txtFiles || [];
  outputFiles.invalidJsonlFiles = invalidGroups.jsonlFiles || [];
  outputFiles.invalidFiles = [...outputFiles.invalidTxtFiles, ...outputFiles.invalidJsonlFiles];
  if (outputFiles.invalidTxtFiles[0]) outputFiles.invalid = outputFiles.invalidTxtFiles[0];
  else if (outputFiles.invalidJsonlFiles[0]) outputFiles.invalid = outputFiles.invalidJsonlFiles[0];

  return {
    tempDir,
    bucketFiles: bucketStreams.map((entry) => entry.path),
    invalidFiles: outputFiles.invalidFiles.slice(),
  };
}

async function phaseTwoDedupe(settings, logger, stats, tempInfo, outputFiles) {
  const validWriters = createCategoryWriters(settings, outputFiles.outputDir, 'valid');
  const duplicateWriters = createCategoryWriters(settings, outputFiles.outputDir, 'duplicates');
  let completedPartitions = 0;
  const totalPartitions = tempInfo.bucketFiles.length;
  const progressTimer = settings.quiet
    ? null
    : setInterval(() => {
        const extra = `${completedPartitions}/${totalPartitions} partitions | valid ${stats.validUnique.toLocaleString()} | dup ${stats.duplicates.toLocaleString()}`;
        if (logger.useProgress) {
          logger.progress(renderProgressBar(completedPartitions, totalPartitions, 'phase2', extra));
        } else {
          logger.info(`phase 2: deduped ${completedPartitions}/${totalPartitions} partitions | valid ${stats.validUnique.toLocaleString()} | dup ${stats.duplicates.toLocaleString()}`);
        }
      }, logger.useProgress ? 250 : 5000);

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
        if (force || validBatch.length >= DEDUPE_FLUSH_SIZE) {
          await writeToAllWriters(validWriters, validBatch.splice(0, validBatch.length));
        }
        if (force || duplicateBatch.length >= DEDUPE_FLUSH_SIZE) {
          await writeToAllWriters(duplicateWriters, duplicateBatch.splice(0, duplicateBatch.length));
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
      completedPartitions += 1;

      if (!settings.keepTemp) {
        await fsp.rm(bucketFile, { force: true });
      }

      if (!logger.useProgress && (index + 1) % Math.max(1, Math.ceil(tempInfo.bucketFiles.length / 8)) === 0) {
        logger.info(`phase 2: deduped ${index + 1}/${tempInfo.bucketFiles.length} partitions`);
      }
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    logger.stopProgress();
    await closeAllWriters(validWriters);
    await closeAllWriters(duplicateWriters);
    if (!settings.keepTemp) {
      await fsp.rm(tempInfo.tempDir, { recursive: true, force: true });
    }
  }

  const validGroups = getWriterFileGroups(validWriters);
  const duplicateGroups = getWriterFileGroups(duplicateWriters);
  outputFiles.validTxtFiles = validGroups.txtFiles || [];
  outputFiles.validJsonlFiles = validGroups.jsonlFiles || [];
  outputFiles.duplicateTxtFiles = duplicateGroups.txtFiles || [];
  outputFiles.duplicateJsonlFiles = duplicateGroups.jsonlFiles || [];
  outputFiles.validFiles = [...outputFiles.validTxtFiles, ...outputFiles.validJsonlFiles];
  outputFiles.duplicateFiles = [...outputFiles.duplicateTxtFiles, ...outputFiles.duplicateJsonlFiles];
  if (outputFiles.validTxtFiles[0]) outputFiles.valid = outputFiles.validTxtFiles[0];
  else if (outputFiles.validJsonlFiles[0]) outputFiles.valid = outputFiles.validJsonlFiles[0];
  if (outputFiles.duplicateTxtFiles[0]) outputFiles.duplicates = outputFiles.duplicateTxtFiles[0];
  else if (outputFiles.duplicateJsonlFiles[0]) outputFiles.duplicates = outputFiles.duplicateJsonlFiles[0];

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

  const validTextFiles = outputFiles.validTxtFiles.length ? outputFiles.validTxtFiles : (outputFiles.valid && outputFiles.valid.endsWith('.txt') ? [outputFiles.valid] : []);
  const validJsonlFiles = outputFiles.validJsonlFiles || [];
  if (!validTextFiles.length && !validJsonlFiles.length) {
    logger.warn('webhook skipped: valid output files were not found');
    return;
  }

  const totalBatches = Math.ceil(stats.validUnique / settings.webhookBatchSize);
  logger.info(`phase 3: sending ${stats.validUnique.toLocaleString()} valid entries in ${totalBatches.toLocaleString()} webhook batch(es)`);

  const inflight = new Set();
  let batch = [];
  let batchIndex = 0;
  let completedBatches = 0;
  const progressTimer = settings.quiet
    ? null
    : setInterval(() => {
        const extra = `${completedBatches}/${totalBatches} batches | ok ${stats.webhookDeliveries} | failed ${stats.webhookFailures}`;
        if (logger.useProgress) {
          logger.progress(renderProgressBar(completedBatches, totalBatches, 'phase3', extra));
        } else {
          logger.info(`phase 3: ${completedBatches}/${totalBatches} webhook batches finished | ok ${stats.webhookDeliveries} | failed ${stats.webhookFailures}`);
        }
      }, logger.useProgress ? 250 : 5000);

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
    } finally {
      completedBatches += 1;
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

  for (const filePath of validTextFiles) {
    const rl = readline.createInterface({
      input: createTextReadStream(filePath),
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

  if (!validTextFiles.length) {
    for (const filePath of validJsonlFiles) {
      const rl = readline.createInterface({
        input: createTextReadStream(filePath),
        crlfDelay: Infinity,
      });

      for await (const line of rl) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (typeof parsed?.entry === 'string' && parsed.entry) {
            batch.push(parsed.entry);
          }
        } catch {
          // ignore malformed JSONL lines in webhook phase
        }
        if (batch.length >= settings.webhookBatchSize) {
          await queueBatch(batch);
          batch = [];
        }
      }

      rl.close();
    }
  }

  try {
    if (batch.length) {
      await queueBatch(batch);
    }
    await Promise.all(inflight);
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    logger.stopProgress();
  }
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
      inputDir: settings.inputDir,
      inputLabel: settings.inputLabel,
      stdin: settings.stdin,
      gzip: settings.gzip,
      gzipOutput: settings.gzipOutput,
      outputFormat: settings.outputFormat,
      outputDir: outputFiles.outputDir,
      include: settings.include,
      exclude: settings.exclude,
      profile: settings.profile,
      format: settings.format,
      resolvedFormat: stats.inputFormatResolved,
      delimiter: settings.delimiter,
      csvColumn: settings.column,
      csvColumnResolved: stats.csvColumnResolved,
      header: settings.header,
      workers: settings.workers,
      fileConcurrency: settings.fileConcurrency,
      processMode: settings.processMode,
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
      phaseTimings: {
        partitionMs: stats.phaseTimings?.partitionMs || 0,
        partitionHuman: humanDuration(stats.phaseTimings?.partitionMs || 0),
        dedupeMs: stats.phaseTimings?.dedupeMs || 0,
        dedupeHuman: humanDuration(stats.phaseTimings?.dedupeMs || 0),
        webhookMs: stats.phaseTimings?.webhookMs || 0,
        webhookHuman: humanDuration(stats.phaseTimings?.webhookMs || 0),
      },
    },
  };
}

function createInitialStats() {
  return {
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
    phaseTimings: {
      partitionMs: 0,
      dedupeMs: 0,
      webhookMs: 0,
    },
    phaseStarts: {},
  };
}

function sanitizeOutputSegment(value) {
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.+/g, '')
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^\/|\/$/g, '')
    || 'input';
}

function stripKnownExtensions(filePath) {
  const lower = filePath.toLowerCase();
  const known = ['.csv.gz', '.txt.gz', '.log.gz', '.gz', '.csv', '.txt', '.log'];
  for (const ext of known) {
    if (lower.endsWith(ext)) {
      return filePath.slice(0, -ext.length);
    }
  }
  return filePath.replace(/\.[^.]+$/, '');
}

function globToRegExp(pattern) {
  const normalized = String(pattern || '').replace(/\\/g, '/');
  let regex = '^';

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    const nextTwo = normalized[index + 2];

    if (char === '*') {
      if (next === '*' && nextTwo === '/') {
        regex += '(?:.*\/)?';
        index += 2;
      } else if (next === '*') {
        regex += '.*';
        index += 1;
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else {
      regex += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }

  regex += '$';
  return new RegExp(regex);
}

function normalizeGlobPatterns(patterns = []) {
  return patterns
    .flatMap((pattern) => String(pattern || '').split(','))
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => ({ pattern, regex: globToRegExp(pattern) }));
}

function matchesAnyGlob(relativePath, compiledPatterns) {
  if (!compiledPatterns.length) return false;
  const normalizedPath = relativePath.split(path.sep).join('/');
  return compiledPatterns.some(({ regex }) => regex.test(normalizedPath));
}

function escapeCsvValue(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildBatchSummaryCsv(batchSummary) {
  const rows = [
    [
      'input',
      'outputDir',
      'processed',
      'validUnique',
      'duplicates',
      'invalid',
      'averageRowsPerMinute',
      'elapsedHuman',
      'partitionHuman',
      'dedupeHuman',
      'webhookHuman',
      'summary',
    ].join(','),
  ];

  for (const file of batchSummary.files) {
    rows.push([
      escapeCsvValue(file.input),
      escapeCsvValue(file.outputDir),
      file.processed,
      file.validUnique,
      file.duplicates,
      file.invalid,
      file.averageRowsPerMinute,
      escapeCsvValue(file.elapsedHuman),
      escapeCsvValue(file.phaseTimings?.partitionHuman || '0s'),
      escapeCsvValue(file.phaseTimings?.dedupeHuman || '0s'),
      escapeCsvValue(file.phaseTimings?.webhookHuman || '0s'),
      escapeCsvValue(file.summary),
    ].join(','));
  }

  return `${rows.join('\n')}\n`;
}

async function collectFilesRecursive(directory) {
  const output = [];
  const entries = await fsp.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFilesRecursive(fullPath);
      output.push(...nested);
    } else if (entry.isFile()) {
      output.push(fullPath);
    }
  }
  output.sort();
  return output;
}

function filterFilesForDirectoryMode(files, inputDir, includePatterns, excludePatterns) {
  const compiledIncludes = normalizeGlobPatterns(includePatterns);
  const compiledExcludes = normalizeGlobPatterns(excludePatterns);

  return files.filter((filePath) => {
    const relative = path.relative(inputDir, filePath).split(path.sep).join('/');
    const included = !compiledIncludes.length || matchesAnyGlob(relative, compiledIncludes);
    const excluded = compiledExcludes.length && matchesAnyGlob(relative, compiledExcludes);
    return included && !excluded;
  });
}

function deriveJobOutputDir(baseOutputDir, inputDir, filePath) {
  const relative = path.relative(inputDir, filePath);
  const withoutExt = stripKnownExtensions(relative);
  return path.join(baseOutputDir, sanitizeOutputSegment(withoutExt));
}

function shouldUseChildProcessMode(settings) {
  if (!settings.inputDir) return false;
  if (settings.processMode === 'child') return true;
  if (settings.processMode === 'inline') return false;
  return settings.fileConcurrency > 1;
}

function buildChildArgs(jobSettings) {
  const args = [
    SCRIPT_FILE,
    '--input', jobSettings.input,
    '--output-dir', jobSettings.outputDir,
    '--profile', jobSettings.profile,
    '--format', jobSettings.format,
    '--delimiter', jobSettings.delimiter,
    '--column', String(jobSettings.column),
    '--header', String(jobSettings.header),
    '--gzip', String(jobSettings.gzip),
    '--gzip-output', String(jobSettings.gzipOutput),
    '--output-format', jobSettings.outputFormat,
    '--workers', String(jobSettings.workers),
    '--chunk-size', String(jobSettings.chunkSize),
    '--buckets', String(jobSettings.buckets),
    '--shard-size', String(jobSettings.shardSize),
    '--checkpoint-file', jobSettings.checkpointFile,
    '--webhook-concurrency', String(jobSettings.webhookConcurrency),
    '--webhook-batch-size', String(jobSettings.webhookBatchSize),
  ];

  if (jobSettings.webhookUrl) {
    args.push('--webhook-url', jobSettings.webhookUrl);
  }
  if (jobSettings.resume) {
    args.push('--resume');
  }
  if (jobSettings.keepTemp) {
    args.push('--keep-temp');
  }
  if (jobSettings.quiet) {
    args.push('--quiet');
  }

  return args;
}

async function runChildSingleInput(jobSettings) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, buildChildArgs(jobSettings), {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutTail = '';
    let stderrTail = '';
    const appendTail = (current, chunk) => `${current}${chunk}`.slice(-8000);

    child.stdout.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, String(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = appendTail(stderrTail, String(chunk));
    });
    child.on('error', reject);
    child.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Child process failed for ${jobSettings.input}: ${stderrTail || stdoutTail || `exit ${code}`}`));
        return;
      }

      try {
        const summaryText = await fsp.readFile(path.join(jobSettings.outputDir, 'summary.json'), 'utf8');
        resolve(JSON.parse(summaryText));
      } catch (error) {
        reject(new Error(`Child process finished but summary.json could not be read for ${jobSettings.input}: ${error.message}`));
      }
    });
  });
}

async function processSingleInput(settings) {
  const logger = createLogger(settings.quiet);
  await ensureDir(settings.outputDir);

  const outputFiles = buildOutputFiles(settings);
  const stats = createInitialStats();

  let inputStat = null;
  if (!settings.stdin) {
    inputStat = await fsp.stat(settings.input);
    if (!inputStat.isFile()) {
      throw new Error('Input path must be a regular file');
    }
    settings.inputSize = inputStat.size;
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
  logger.info(`profile=${settings.profile} workers=${settings.workers} chunkSize=${settings.chunkSize} buckets=${settings.buckets} shardSize=${settings.shardSize || 0} outputFormat=${settings.outputFormat} gzipOutput=${settings.gzipOutput}`);
  logger.info(`safety: local-only validation of your provided input; no generation or external probing`);

  let tempInfo = checkpoint?.tempInfo || null;

  if (!checkpoint || checkpoint.phase === 'new') {
    beginPhase(stats, 'partitionMs');
    tempInfo = await phaseOnePartition(settings, logger, stats, outputFiles);
    const phaseElapsed = endPhase(stats, 'partitionMs');
    await saveCheckpoint(settings.checkpointFile, buildCheckpointPayload('phase1-complete', settings, stats, outputFiles, { tempInfo }));
    logger.info(`checkpoint saved after phase 1 (${humanDuration(phaseElapsed)})`);
  }

  if (!checkpoint || checkpoint.phase === 'phase1-complete' || checkpoint.phase === 'new') {
    beginPhase(stats, 'dedupeMs');
    await phaseTwoDedupe(settings, logger, stats, tempInfo, outputFiles);
    const phaseElapsed = endPhase(stats, 'dedupeMs');
    await saveCheckpoint(settings.checkpointFile, buildCheckpointPayload('phase2-complete', settings, stats, outputFiles, { tempInfo }));
    logger.info(`checkpoint saved after phase 2 (${humanDuration(phaseElapsed)})`);
  }

  if (!checkpoint || checkpoint.phase === 'phase2-complete' || checkpoint.phase === 'phase1-complete' || checkpoint.phase === 'new') {
    beginPhase(stats, 'webhookMs');
    await phaseThreeWebhook(settings, logger, stats, outputFiles);
    const phaseElapsed = endPhase(stats, 'webhookMs');
    if (settings.webhookUrl) {
      logger.info(`webhook phase finished in ${humanDuration(phaseElapsed)}`);
    }
  }

  const summary = buildSummary(settings, stats, outputFiles);
  await fsp.writeFile(outputFiles.summary, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  await saveCheckpoint(settings.checkpointFile, buildCheckpointPayload('complete', settings, stats, outputFiles, { tempInfo }));

  logger.info(`done in ${summary.stats.elapsedHuman}`);
  logger.info(`processed=${summary.stats.processed.toLocaleString()} valid=${summary.stats.validUnique.toLocaleString()} duplicates=${summary.stats.duplicates.toLocaleString()} invalid=${summary.stats.invalid.toLocaleString()}`);
  logger.info(`average=${summary.stats.averageRowsPerMinute.toLocaleString()} rows/min`);
  logger.info(`phase timings: partition=${summary.stats.phaseTimings.partitionHuman}, dedupe=${summary.stats.phaseTimings.dedupeHuman}, webhook=${summary.stats.phaseTimings.webhookHuman}`);
  logger.info(`outputs: ${outputFiles.outputDir}`);
  return summary;
}

async function processDirectory(settings) {
  const logger = createLogger(settings.quiet);
  const discoveredFiles = await collectFilesRecursive(settings.inputDir);
  const files = filterFilesForDirectoryMode(discoveredFiles, settings.inputDir, settings.include, settings.exclude);
  if (!files.length) {
    throw new Error('Input directory does not contain any matching regular files');
  }

  await ensureDir(settings.outputDir);
  const batchStartedAt = Date.now();
  const summaries = new Array(files.length);
  let batchProcessed = 0;
  let batchValid = 0;
  let batchDuplicates = 0;
  let batchInvalid = 0;
  let completedFiles = 0;
  let nextIndex = 0;
  const processModeResolved = shouldUseChildProcessMode(settings) ? 'child' : 'inline';

  const effectiveFileConcurrency = Math.max(1, Math.min(settings.fileConcurrency, files.length, settings.workers));
  const workerAllocation = Array.from({ length: effectiveFileConcurrency }, (_, slot) => (
    Math.floor(settings.workers / effectiveFileConcurrency) + (slot < (settings.workers % effectiveFileConcurrency) ? 1 : 0)
  ));

  logger.info(`directory mode: found ${discoveredFiles.length.toLocaleString()} file(s), matched ${files.length.toLocaleString()} after filters`);
  logger.info(`directory mode: fileConcurrency=${effectiveFileConcurrency}, totalWorkerBudget=${settings.workers}, perSlotWorkers=${workerAllocation.join(',')}, processMode=${processModeResolved}`);
  if (settings.include.length) logger.info(`include filters: ${settings.include.join(', ')}`);
  if (settings.exclude.length) logger.info(`exclude filters: ${settings.exclude.join(', ')}`);

  const progressTimer = settings.quiet
    ? null
    : setInterval(() => {
        const elapsedMs = Date.now() - batchStartedAt;
        const fileRate = completedFiles / Math.max(elapsedMs, 1);
        const remaining = files.length - completedFiles;
        const etaMs = remaining > 0 && fileRate > 0 ? Math.round(remaining / fileRate) : 0;
        const extra = `${completedFiles}/${files.length} files | ${batchProcessed.toLocaleString()} rows | eta ${humanDuration(etaMs)}`;
        if (logger.useProgress) {
          logger.progress(renderProgressBar(completedFiles, files.length, 'batch', extra));
        } else {
          logger.info(`directory progress: ${completedFiles}/${files.length} files complete | ${batchProcessed.toLocaleString()} rows processed | eta ${humanDuration(etaMs)}`);
        }
      }, logger.useProgress ? 250 : 5000);

  const runSingleJob = async (jobSettings) => {
    return processModeResolved === 'child'
      ? runChildSingleInput({ ...jobSettings, quiet: true })
      : processSingleInput(jobSettings);
  };

  const runSlot = async (slot) => {
    const slotWorkers = Math.max(1, workerAllocation[slot] || 1);

    while (nextIndex < files.length) {
      const index = nextIndex;
      nextIndex += 1;
      const filePath = files[index];
      const jobOutputDir = deriveJobOutputDir(settings.outputDir, settings.inputDir, filePath);
      const jobSettings = {
        ...settings,
        input: filePath,
        stdin: false,
        inputDir: null,
        include: [],
        exclude: [],
        inputLabel: filePath,
        outputDir: jobOutputDir,
        checkpointFile: path.join(jobOutputDir, path.basename(settings.checkpointFile)),
        resume: settings.resume,
        workers: slotWorkers,
        fileConcurrency: 1,
        processMode: 'inline',
      };

      logger.info(`batch ${index + 1}/${files.length} [slot ${slot + 1}/${effectiveFileConcurrency}, workers ${slotWorkers}]: ${filePath}`);
      const summary = await runSingleJob(jobSettings);
      summaries[index] = summary;
      completedFiles += 1;
      batchProcessed += summary.stats.processed;
      batchValid += summary.stats.validUnique;
      batchDuplicates += summary.stats.duplicates;
      batchInvalid += summary.stats.invalid;
    }
  };

  try {
    await Promise.all(Array.from({ length: effectiveFileConcurrency }, (_, slot) => runSlot(slot)));
  } finally {
    if (progressTimer) clearInterval(progressTimer);
    logger.stopProgress();
  }

  const elapsedMs = Date.now() - batchStartedAt;
  const batchSummary = {
    safety: {
      description: 'Local-only batch processing of user-provided files.',
      externalDiscovery: false,
      randomGeneration: false,
      liveVerification: false,
    },
    inputDir: settings.inputDir,
    outputDir: settings.outputDir,
    include: settings.include,
    exclude: settings.exclude,
    processMode: processModeResolved,
    fileConcurrency: effectiveFileConcurrency,
    totalWorkerBudget: settings.workers,
    fileCount: files.length,
    elapsedMs,
    elapsedHuman: humanDuration(elapsedMs),
    averageRowsPerMinute: elapsedMs > 0 ? Math.round((batchProcessed / elapsedMs) * 60000) : 0,
    totals: {
      processed: batchProcessed,
      validUnique: batchValid,
      duplicates: batchDuplicates,
      invalid: batchInvalid,
    },
    summaryFiles: {
      json: path.join(settings.outputDir, 'batch-summary.json'),
      csv: path.join(settings.outputDir, 'batch-summary.csv'),
    },
    files: summaries.map((summary) => ({
      input: summary.settings.inputLabel,
      outputDir: summary.files.outputDir,
      processed: summary.stats.processed,
      validUnique: summary.stats.validUnique,
      duplicates: summary.stats.duplicates,
      invalid: summary.stats.invalid,
      averageRowsPerMinute: summary.stats.averageRowsPerMinute,
      elapsedHuman: summary.stats.elapsedHuman,
      phaseTimings: summary.stats.phaseTimings,
      summary: summary.files.summary,
    })),
  };

  const batchSummaryPath = path.join(settings.outputDir, 'batch-summary.json');
  const batchSummaryCsvPath = path.join(settings.outputDir, 'batch-summary.csv');
  await fsp.writeFile(batchSummaryPath, `${JSON.stringify(batchSummary, null, 2)}\n`, 'utf8');
  await fsp.writeFile(batchSummaryCsvPath, buildBatchSummaryCsv(batchSummary), 'utf8');
  logger.info(`batch complete in ${batchSummary.elapsedHuman}`);
  logger.info(`batch processed=${batchProcessed.toLocaleString()} valid=${batchValid.toLocaleString()} duplicates=${batchDuplicates.toLocaleString()} invalid=${batchInvalid.toLocaleString()}`);
  logger.info(`batch average=${batchSummary.averageRowsPerMinute.toLocaleString()} rows/min`);
  logger.info(`batch summaries: ${batchSummaryPath}, ${batchSummaryCsvPath}`);
}

async function main() {
  const rawArgs = parseArgs(process.argv.slice(2));
  if (rawArgs.help) {
    printHelp();
    return;
  }

  const settings = resolveSettings(rawArgs);

  if (settings.inputDir) {
    await processDirectory(settings);
  } else {
    await processSingleInput(settings);
  }
}

main().catch((error) => {
  console.error(`[fatal] ${error.message}`);
  process.exitCode = 1;
});
