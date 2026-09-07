import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function readIntArg(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number.parseInt(process.argv[index + 1], 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function makeCode(seed) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let n = seed + 1;
  let output = '';
  for (let index = 0; index < 16; index += 1) {
    n = (n * 1664525 + 1013904223) >>> 0;
    output += chars[n % chars.length];
  }
  return output;
}

function runOrThrow(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }

  return result;
}

const rows = readIntArg('--rows', 1_000_000);
const files = readIntArg('--files', 4);
const workers = readIntArg('--workers', Math.max(1, Math.min(16, os.availableParallelism?.() || os.cpus().length || 1)));
const profile = process.argv.includes('--profile')
  ? process.argv[process.argv.indexOf('--profile') + 1]
  : 'turbo';

const benchRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-gift-link-bench-'));
const inputDir = path.join(benchRoot, 'input-dir');
const singleInput = path.join(benchRoot, 'single.txt');
const singleOutput = path.join(benchRoot, 'single-out');
const batchInlineOutput = path.join(benchRoot, 'batch-inline-out');
const batchChildOutput = path.join(benchRoot, 'batch-child-out');
await fs.mkdir(inputDir, { recursive: true });

const rowsPerFile = Math.ceil(rows / files);
let singleBuffer = '';

for (let fileIndex = 0; fileIndex < files; fileIndex += 1) {
  let fileBuffer = '';
  const start = fileIndex * rowsPerFile;
  const end = Math.min(rows, start + rowsPerFile);
  for (let rowIndex = start; rowIndex < end; rowIndex += 1) {
    const line = `${makeCode(rowIndex)}\n`;
    fileBuffer += line;
    singleBuffer += line;
  }
  await fs.writeFile(path.join(inputDir, `part-${String(fileIndex + 1).padStart(2, '0')}.txt`), fileBuffer, 'utf8');
}

await fs.writeFile(singleInput, singleBuffer, 'utf8');

console.log(`Benchmark workspace: ${benchRoot}`);
console.log(`Rows: ${rows.toLocaleString()} | Files: ${files} | Workers: ${workers} | Profile: ${profile}`);

const benchmarkFileConcurrency = Math.min(files, workers);

runOrThrow(process.execPath, [
  'cli/owned-gift-link-checker.mjs',
  '--input', singleInput,
  '--output-dir', singleOutput,
  '--profile', profile,
  '--workers', String(workers),
  '--quiet',
]);

runOrThrow(process.execPath, [
  'cli/owned-gift-link-checker.mjs',
  '--input-dir', inputDir,
  '--output-dir', batchInlineOutput,
  '--profile', profile,
  '--workers', String(workers),
  '--file-concurrency', String(benchmarkFileConcurrency),
  '--process-mode', 'inline',
  '--quiet',
]);

runOrThrow(process.execPath, [
  'cli/owned-gift-link-checker.mjs',
  '--input-dir', inputDir,
  '--output-dir', batchChildOutput,
  '--profile', profile,
  '--workers', String(workers),
  '--file-concurrency', String(benchmarkFileConcurrency),
  '--process-mode', 'child',
  '--quiet',
]);

const singleSummary = JSON.parse(await fs.readFile(path.join(singleOutput, 'summary.json'), 'utf8'));
const batchInlineSummary = JSON.parse(await fs.readFile(path.join(batchInlineOutput, 'batch-summary.json'), 'utf8'));
const batchChildSummary = JSON.parse(await fs.readFile(path.join(batchChildOutput, 'batch-summary.json'), 'utf8'));

const results = {
  benchmarkRoot: benchRoot,
  single: {
    processed: singleSummary.stats.processed,
    elapsedMs: singleSummary.stats.elapsedMs,
    averageRowsPerMinute: singleSummary.stats.averageRowsPerMinute,
    phaseTimings: singleSummary.stats.phaseTimings,
  },
  batchInline: {
    processed: batchInlineSummary.totals.processed,
    elapsedMs: batchInlineSummary.elapsedMs,
    averageRowsPerMinute: batchInlineSummary.averageRowsPerMinute,
    fileConcurrency: batchInlineSummary.fileConcurrency,
    processMode: batchInlineSummary.processMode,
  },
  batchChild: {
    processed: batchChildSummary.totals.processed,
    elapsedMs: batchChildSummary.elapsedMs,
    averageRowsPerMinute: batchChildSummary.averageRowsPerMinute,
    fileConcurrency: batchChildSummary.fileConcurrency,
    processMode: batchChildSummary.processMode,
  },
};

const fastest = [
  ['single', results.single.averageRowsPerMinute],
  ['batchInline', results.batchInline.averageRowsPerMinute],
  ['batchChild', results.batchChild.averageRowsPerMinute],
].sort((a, b) => b[1] - a[1])[0];

results.fastestMode = {
  name: fastest[0],
  averageRowsPerMinute: fastest[1],
};

console.log(JSON.stringify(results, null, 2));
