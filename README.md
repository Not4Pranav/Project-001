# Generated Gift Link Format Self-Checker

Safe local-only tooling that generates a fixed synthetic fixture and checks it immediately.

The project includes two versions:
- a **browser UI** in `index.html`
- a **CLI** in `cli/`

Both versions now work without user file sharing:
- they generate a small, deterministic synthetic fixture by themselves
- they immediately run local format validation and deduplication
- they verify expected valid, duplicate, and malformed counts
- they write/show local results and a self-test report
- they do **not** generate random or redeemable gift links
- they do **not** brute-force, discover, probe services, call Discord APIs, claim, or redeem anything

## Included versions

### 1) Browser UI
Single-file app in `index.html`.

Highlights:
- no visible file upload or paste flow
- automatically generates a fixed fake fixture on page load
- checks it immediately with browser workers
- verifies expected valid, duplicate, and malformed results
- provides a **Generate & self-check now** button to rerun the generated check
- result copy/download buttons for the generated output

### 2) CLI
Main entry point: `cli/owned-gift-link-checker.mjs`.

Highlights:
- running with no input now defaults to generated self-check mode
- `--self-test` explicitly runs the same generated self-check
- streams the generated fixture in memory, then writes checker outputs, `summary.json`, and `self-test-report.json`
- exits non-zero if expected counts/files do not match
- keeps all checking local and skips webhooks in self-test mode

## Speed safeguards

The generated self-check path is designed to stay fast:
- the CLI fixture is streamed from memory, so there is no extra generated input-file read
- browser self-check skips upload parsing and webhook/network work
- the tiny generated fixture uses lightweight worker/chunk settings instead of heavy large-file defaults
- existing worker-based normalization, dedupe, and output code paths are still exercised

## Quick start

### Browser UI
Open `index.html` directly in a browser, or serve the repo locally:

```bash
python3 -m http.server 4173 --bind 0.0.0.0
```

Then open:
- `http://127.0.0.1:4173`

The browser version generates and checks its fixture automatically on load. Click **Generate & self-check now** or **Re-run generated check** to run it again.

### CLI
Generate and check immediately:

```bash
npm run generate-and-check
```

Equivalent explicit self-test command:

```bash
npm run self-test
```

Or directly:

```bash
node cli/owned-gift-link-checker.mjs --self-test
```

By default, generated self-test output is written under:

```text
output/self-test/
```

## Validation commands

```bash
npm run check:cli
npm run check:browser
npm run check:all
npm run self-test
```

What they do:
- `check:cli` parses both CLI `.mjs` files with Node
- `check:browser` parses the inline browser script and verifies referenced element IDs exist in `index.html`
- `check:all` runs syntax/sanity checks and the generated CLI self-test
- `self-test` generates the synthetic fixture, runs the CLI, and verifies expected outputs

## Documentation
- `SETUP.md` — setup and usage notes
- `cli/README.md` — detailed CLI options, including the generated self-check mode

## Repo layout
- `index.html` — browser UI with automatic generated self-check
- `cli/owned-gift-link-checker.mjs` — CLI coordinator and self-test runner
- `cli/owned-gift-link-worker.mjs` — worker-thread normalizer
- `scripts/check-browser.mjs` — browser sanity checker
- `scripts/benchmark-cli.mjs` — optional CLI benchmark helper
- `package.json` — npm scripts for validation and generated checking

## Safety boundary

The only generation feature is a fixed synthetic test fixture for local validation of this checker. It is not a real gift-link generator and it is not used to discover, probe, claim, redeem, or verify real gift links.
