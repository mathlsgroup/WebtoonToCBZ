'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const CHUNK = 256 * 1024;
const MAX_MESSAGE = 400 * 1024;
const MAX_OUTPUT = 128 * 1024 * 1024;

function createHost(magick) {
  if (!path.isAbsolute(magick) || !fs.statSync(magick).isFile()) throw new Error('Configured ImageMagick executable is unavailable.');
  let input, output, width, height, offset = 0, child;
  return {
    dispose() { child?.kill(); input = output = undefined; },
    async handle(message) {
      switch (message.action) {
        case 'ping': {
          const version = execFileSync(magick, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
          if (!version.startsWith('Version: ImageMagick 7')) throw new Error('ImageMagick 7 is required.');
          return { ok: true, protocol: 1, quality: 97, sampling: '4:4:4', version: version.split(/\r?\n/)[0] };
        }
        case 'begin': {
          width = message.width; height = message.height;
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
            || width > 32767 || height > 32767 || width * height > 64 * 1024 * 1024) throw new Error('Invalid image dimensions.');
          input = Buffer.alloc(width * height * 4); output = undefined; offset = 0;
          return { ok: true };
        }
        case 'write': {
          if (!input || message.offset !== offset || typeof message.base64 !== 'string'
            || message.base64.length > 350000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.base64)) throw new Error('Invalid image chunk.');
          const bytes = Buffer.from(message.base64, 'base64');
          if (!bytes.length || bytes.length !== Math.min(CHUNK, input.length - offset)) throw new Error('Incomplete image chunk.');
          bytes.copy(input, offset); offset += bytes.length; return { ok: true };
        }
        case 'encode': {
          if (!input || offset !== input.length) throw new Error('Image transfer is incomplete.');
          const pixels = input; input = undefined; output = undefined;
          // Fixed argv only. No shell, URLs, file paths, delegates or user options
          // are accepted from Firefox; input is raw RGBA and output is stdout JPEG.
          output = await new Promise((resolve, reject) => {
            const args = ['-limit','memory','512MiB','-limit','map','512MiB','-limit','disk','0',
              '-size',width+'x'+height,'-depth','8','rgba:-','-background','white','-alpha','remove','-alpha','off',
              '-type','TrueColor','-colorspace','sRGB','-sampling-factor','1x1,1x1,1x1',
              '-quality','97','-interlace','none','jpeg:-'];
            child = spawn(magick, args, { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
            const timer = setTimeout(() => { child?.kill(); reject(new Error('ImageMagick conversion timed out.')); },120000);
            const chunks = []; let length = 0, stderr = '';
            child.stdout.on('data', bytes => {
              length += bytes.length;
              if (length > MAX_OUTPUT) { child.kill(); reject(new Error('ImageMagick output exceeds 128 MiB.')); }
              else chunks.push(bytes);
            });
            child.stderr.on('data', bytes => { if (stderr.length < 4096) stderr += bytes.toString('utf8').slice(0,4096-stderr.length); });
            child.stdin.on('error', () => {});
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.on('close', code => {
              clearTimeout(timer); child = undefined;
              if (code !== 0) reject(new Error('ImageMagick failed: '+stderr));
              else if (!length) reject(new Error('ImageMagick returned no JPEG data.'));
              else resolve(Buffer.concat(chunks));
            });
            child.stdin.end(pixels);
          });
          return { ok: true, total: output.length };
        }
        case 'read': {
          if (!output || !Number.isSafeInteger(message.offset) || message.offset < 0 || message.offset >= output.length) throw new Error('Invalid JPEG offset.');
          return { ok: true, offset: message.offset, total: output.length,
            base64: output.subarray(message.offset, message.offset + CHUNK).toString('base64') };
        }
        default: throw new Error('Unsupported native command.');
      }
    },
  };
}

function run() {
  const configIndex = process.argv.indexOf('--config');
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : path.join(__dirname,'config.json');
  const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
  const host = createHost(config.magick);
  let buffer = Buffer.alloc(0), queue = Promise.resolve(), queued = 0, closed = false;
  function send(message) {
    const bytes = Buffer.from(JSON.stringify(message),'utf8');
    if (bytes.length > MAX_MESSAGE) throw new Error('Native response too large.');
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    process.stdout.write(header); process.stdout.write(bytes);
  }
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer,chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (!length || length > MAX_MESSAGE || queued > 4) { host.dispose(); process.exit(1); return; }
      if (buffer.length < length + 4) return;
      let message;
      try { message = JSON.parse(buffer.subarray(4,4+length).toString('utf8')); }
      catch { host.dispose(); process.exit(1); return; }
      buffer = buffer.subarray(4+length); queued++;
      queue = queue.then(async () => {
        if(closed){queued--;return;}
        try {
          if (!Number.isSafeInteger(message.id) || message.id < 1) throw new Error('Invalid request id.');
          send({ id: message.id, ...await host.handle(message) });
        } catch (error) { send({ id: message.id, error: String(error) }); }
        finally { queued--; }
      }).catch(() => { host.dispose(); process.exitCode = 1; process.stdin.destroy(); });
    }
  });
  process.stdin.on('end', () => { closed=true;host.dispose(); });
  process.stdout.on('error', () => { closed=true;host.dispose();process.stdin.destroy(); });
  process.on('exit', () => host.dispose());
}

module.exports = { createHost, CHUNK };
if (require.main === module) {
  try { run(); } catch (error) { process.stderr.write(String(error)+'\n'); process.exitCode = 1; }
}
