import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
mkdirSync('dist', { recursive: true });
for (const file of ['manifest.json', 'popup.html', 'popup.css']) cpSync(file, `dist/${file}`);
// JSZip is bundled locally; extension pages do not depend on a CDN.
const jszip = require.resolve('jszip/dist/jszip.min.js');
cpSync(jszip, 'dist/jszip.min.js');
// TypeScript emits ES modules; scripts are loaded as ordinary browser scripts.
// This prototype intentionally avoids imports between source files.
