import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const staging = resolve(root, '.build-stage');
const output = resolve(root, 'dist');
// Both cleanup targets are fixed children of this project, never external paths.
if (dirname(staging) !== resolve(root) || dirname(output) !== resolve(root)) {
  throw new Error('Build paths must stay inside the project.');
}
rmSync(staging, { recursive: true, force: true });
try {
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--outDir', staging],
    { cwd: root, stdio: 'inherit' });
  mkdirSync(staging, { recursive: true });
  for (const file of ['manifest.json', 'popup.html', 'popup.css', 'review.html', 'icons']) {
    cpSync(resolve(root, file), resolve(staging, file), { recursive: true });
  }
  cpSync(require.resolve('jpeg-js/lib/encoder.js'), resolve(staging, 'jpeg-encoder.js'));
  // JSZip's bundled setImmediate shim accepts string callbacks through dynamic
  // code generation. Extension CSP forbids that API; allow function callbacks only.
  const vendor = readFileSync(require.resolve('jszip/dist/jszip.min.js'), 'utf8');
  const unsafeCallback = 'new Function(""+e)';
  if (vendor.split(unsafeCallback).length !== 2) {
    throw new Error('JSZip shim changed: review the CSP hardening before building.');
  }
  writeFileSync(resolve(staging, 'jszip.min.js'), vendor.replace(unsafeCallback,
    '(()=>{throw new TypeError("String callbacks are disabled by extension CSP")})()'));
  rmSync(output, { recursive: true, force: true });
  renameSync(staging, output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

