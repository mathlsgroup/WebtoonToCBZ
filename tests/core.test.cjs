const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const JSZip = require('jszip');

function captureFixture() {
  let handler;
  const events = {};
  const document = {
    images: [], documentElement: {},
    addEventListener(name, callback) { events[name] = callback; },
    removeEventListener(name) { delete events[name]; },
  };
  const context = vm.createContext({
    crypto: require('node:crypto').webcrypto,
    document, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: callback => callback(),
    window: { addEventListener() {}, removeEventListener() {} },
    browser: { runtime: { onMessage: { addListener(callback) { handler = callback; } } } },
  });
  const source = fs.readFileSync('dist/content.js', 'utf8');
  vm.runInContext(source, context);
  function image(url, loaded = true, height = 1200, top = 0) {
    const node = {
      currentSrc: url, src: url, complete: loaded, naturalWidth: loaded ? 800 : 0,
      naturalHeight: loaded ? height : 0, isConnected: true,
      getBoundingClientRect: () => ({ width: 800, height, top, bottom: top + height, right: 800, left: 0 }),
      compareDocumentPosition(other) { return document.images.indexOf(node) < document.images.indexOf(other) ? 4 : 2; },
    };
    document.images.push(node);
    return node;
  }
  return { image, document, context, source, send: (action, extra = {}) => handler({ action, ...extra }) };
}

test('lazy completion preserves DOM order, short strips and URL deduplication', async () => {
  const f = captureFixture();
  const first = f.image('https://test/1', false);
  f.image('https://test/2');
  f.image('https://test/strip', true, 150);
  f.image('https://test/2');
  f.image('https://test/offscreen', true, 100, 900);
  await f.send('start');
  first.complete = true; first.naturalWidth = 800; first.naturalHeight = 1200;
  const state = await f.send('images');
  assert.deepEqual(Array.from(state.entries, e => e.url), ['https://test/1', 'https://test/2', 'https://test/strip']);
  assert.equal(state.missing, 0);
});

test('broken images are reported; exclusions, title and manual order survive reinjection', async () => {
  const f = captureFixture();
  f.image('https://test/broken', false);
  f.image('https://test/a'); f.image('https://test/b');
  await f.send('start');
  await f.send('select', { url: 'https://test/a', selected: false });
  await f.send('title', { title: 'Series - 0280' });
  await f.send('reorder', { urls: ['https://test/b', 'https://test/a'] });
  vm.runInContext(f.source, f.context);
  const state = await f.send('stop');
  assert.equal(state.missing, 1);
  assert.equal(state.title, 'Series - 0280');
  assert.equal(state.entries[0].url, 'https://test/b');
  assert.equal(state.entries[1].selected, false);
  const next = await f.send('start');
  assert.notEqual(next.generation, state.generation);
  assert.equal(next.entries.find(e => e.url === 'https://test/a').selected, true);
});

test('replaced images remain available and inserted images follow DOM order', async () => {
  const f = captureFixture();
  const first = f.image('https://test/a');
  f.image('https://test/c');
  await f.send('start');
  const inserted = f.image('https://test/b');
  f.document.images.splice(2, 1);
  f.document.images.splice(1, 0, inserted);
  assert.deepEqual(Array.from((await f.send('images')).entries, e => e.url),
    ['https://test/a', 'https://test/b', 'https://test/c']);
  first.currentSrc = first.src = 'https://test/replacement';
  assert.equal((await f.send('images')).entries.length, 4);
});

test('new documents have distinct capture identifiers', async () => {
  const first = captureFixture();
  const second = captureFixture();
  assert.notEqual((await first.send('start')).generation, (await second.send('start')).generation);
});

function exporterFixture(responses, downloadState = 'complete') {
  const saved = [];
  let archive;
  const browser = { downloads: {
    async download() { saved.push(archive); return 7; },
    onChanged: { addListener() {}, removeListener() {} },
    async search() { return [{ state: downloadState }]; },
  } };
  class Zip {
    constructor() { this.zip = new JSZip(); }
    file(name, bytes) { this.zip.file(name, bytes); }
    async generateAsync() { return new Blob([await this.zip.generateAsync({ type: 'uint8array', compression: 'STORE' })]); }
  }
  const context = vm.createContext({
    JSZip: Zip, Uint8Array, DataView, Blob, AbortSignal, browser,
    URL: { createObjectURL(blob) { archive = blob; return 'blob:test'; }, revokeObjectURL() {} },
    fetch: async url => responses[url],
  });
  vm.runInContext(fs.readFileSync('dist/export.js', 'utf8'), context);
  return { context, saved };
}

test('signature validation and Windows filenames', () => {
  const { context } = exporterFixture({});
  for (const [bytes, extension] of [
    [[255,216,255,0], 'jpg'], [[137,80,78,71,13,10,26,10], 'png'],
    [Array.from(Buffer.from('GIF89a')), 'gif'],
    [Array.from(Buffer.from('RIFF0000WEBP')), 'webp'],
    [[0,0,0,20,...Buffer.from('ftypavif'),0,0,0,0,...Buffer.from('mif1')], 'avif'],
  ]) assert.equal(context.imageExtension(Uint8Array.from(bytes)), extension);
  assert.throws(() => context.imageExtension(Buffer.from('<html>challenge</html>')));
  assert.equal(context.archiveFilename('CON.cbz'), '_CON.cbz');
  assert.equal(context.archiveFilename('../Series: 01. '), '.._Series_ 01.cbz');
  assert.equal(context.archiveFilename('...'), 'chapter.cbz');
});

test('CBZ retains exact bytes and sequential names; HTTP and invalid data abort export', async () => {
  const first = Uint8Array.from([255,216,255,23]);
  const second = Uint8Array.from([137,80,78,71,13,10,26,10,42]);
  const response = bytes => ({ ok: true, arrayBuffer: async () => bytes.buffer });
  const f = exporterFixture({ a: response(first), b: response(second) });
  const reports = [];
  await f.context.exportArchive(['a','b'], 'Chapter', text => reports.push(text));
  const zip = await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files), ['0001.jpg', '0002.png']);
  assert.deepEqual(await zip.file('0001.jpg').async('uint8array'), first);
  assert.deepEqual(await zip.file('0002.png').async('uint8array'), second);
  assert.match(reports.at(-1), /^Saved /);
  const failed = exporterFixture({ a: response(first), b: { ok: false, status: 403 } });
  await assert.rejects(failed.context.exportArchive(['a','b'], 'Chapter', () => {}), /HTTP 403/);
  assert.equal(failed.saved.length, 0);
  const challenge = exporterFixture({ a: response(Buffer.from('<html>challenge</html>')) });
  await assert.rejects(challenge.context.exportArchive(['a'], 'Chapter', () => {}), /invalid data/);
  assert.equal(challenge.saved.length, 0);
});

test('bundled JSZip builds ZIP archives with dynamic code generation disabled', async () => {
  const context = vm.createContext({ setTimeout, clearTimeout, Uint8Array, ArrayBuffer, DataView },
    { codeGeneration: { strings: false, wasm: false } });
  context.self = context;
  vm.runInContext(fs.readFileSync('dist/jszip.min.js', 'utf8'), context);
  const zip = new context.JSZip();
  zip.file('0001.jpg', Uint8Array.from([255,216,255]));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const loaded = await JSZip.loadAsync(bytes);
  assert.equal(await loaded.file('0001.jpg').async('base64'), '/9j/');
});

test('interrupted downloads never report successful saving', async () => {
  const bytes = Uint8Array.from([255,216,255]);
  const f = exporterFixture({ a: { ok: true, arrayBuffer: async () => bytes.buffer } }, 'interrupted');
  const reports = [];
  await assert.rejects(f.context.exportArchive(['a'], 'Chapter', message => reports.push(message)), /interrupted/);
  assert.equal(reports.some(message => message.startsWith('Saved ')), false);
});
