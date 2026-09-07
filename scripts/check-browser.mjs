import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const rootDir = process.cwd();
const htmlPath = path.join(rootDir, 'index.html');
const html = await fs.readFile(htmlPath, 'utf8');

const scriptMatch = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/i);
if (!scriptMatch) {
  throw new Error('Could not find the inline <script> block in index.html');
}

const scriptSource = scriptMatch[1];
new vm.Script(scriptSource, {
  filename: 'index.inline.js',
  displayErrors: true,
});

const htmlIds = new Set(Array.from(html.matchAll(/id="([^"]+)"/g), (match) => match[1]));
const jsIdReferences = Array.from(scriptSource.matchAll(/document\.getElementById\('([^']+)'\)/g), (match) => match[1]);
const missingIds = [...new Set(jsIdReferences.filter((id) => !htmlIds.has(id)))];

if (missingIds.length) {
  throw new Error(`index.html is missing element id(s) referenced by JS: ${missingIds.join(', ')}`);
}

console.log(`Browser check passed: inline script parses and ${jsIdReferences.length} getElementById reference(s) resolve in index.html.`);
