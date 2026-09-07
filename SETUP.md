# Setup and Usage

This project ships as:
- a browser app in `index.html`
- a Node.js CLI in `cli/`

Both versions now generate a fixed synthetic fixture by themselves and check it immediately. The browser UI no longer asks the user to upload, paste, or share a file.

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

1. Open the browser app.
2. The app automatically generates a fixed fake fixture.
3. The generated fixture is checked immediately.
4. The app verifies expected valid, duplicate, and malformed counts.
5. Click **Generate & self-check now** or **Re-run generated check** to run it again.
6. Export generated results if needed.

No user file upload, paste, or external service check is required.

## CLI setup and usage

From the repository root, run the generated check with no input:

```bash
npm run generate-and-check
```

Equivalent explicit self-test:

```bash
npm run self-test
```

Direct Node command:

```bash
node cli/owned-gift-link-checker.mjs --self-test
```

Generated local self-test output is written under `output/self-test` by default. The fixture is generated in memory, then these files are written:
- `run/valid.txt`
- `run/duplicates.txt`
- `run/invalid.txt`
- `run/summary.json`
- `self-test-report.json`

The CLI exits non-zero if expected counts or output files do not match.

Show CLI help:

```bash
npm run check:file:help
```

Detailed CLI guide:
- `cli/README.md`

## Validation

Run syntax, sanity, and generated self-checks:

```bash
npm run check:cli
npm run check:browser
npm run check:all
npm run self-test
```

## Optional benchmark helper

```bash
npm run benchmark:cli -- --rows 1000000 --files 4 --workers 8 --profile turbo
```

The benchmark helper creates deterministic temporary input and compares CLI processing modes. It is optional and separate from the generated self-check workflow.

## Safety boundary

This repo is intentionally limited to:
- fixed local synthetic fixture generation for self-checking
- local normalization
- format validation
- deduplication
- local export

It does not include:
- random or redeemable code generation
- brute-force scanning
- service probing
- claiming or redemption flows
- browser user file upload/paste flow

The generated fixture is fake and deterministic; it is only for local validation of this checker.
