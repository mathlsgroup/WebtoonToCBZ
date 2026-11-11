const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const JSZip = require('jszip');

function captureFixture(options = {}) {
  let handler;
  const events = {};
  const document = {
    images: [], documentElement: {}, reader: null,
    querySelector(selector) { return selector === '#container.img_lel[data-nbpage]' ? this.reader : this.challenge ?? null; },
    addEventListener(name, callback) { events[name] = callback; },
    removeEventListener(name) { delete events[name]; },
  };
  const context = vm.createContext({
    crypto: require('node:crypto').webcrypto,
    location: { hostname: options.hostname ?? 'test', origin: options.origin ?? 'https://test' },
    URL, Uint8Array, AbortSignal, btoa, atob, setTimeout,
    fetch: options.fetch ?? (async () => { throw new Error('No blob response configured'); }),
    document, innerWidth: 1000, innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    MutationObserver: class { constructor(callback) { events.mutation=callback; } observe() {} disconnect() {} },
    requestAnimationFrame: callback => callback(),
    window: { addEventListener(name, callback) { events['window:' + name] = callback; }, removeEventListener(name) { delete events['window:' + name]; } },
    browser: { runtime: { sendMessage: options.sendMessage ?? (async () => { throw new Error('Page-context reader unavailable in fixture'); }), onMessage: { addListener(callback) { handler = callback; } } } },
  });
  const source = fs.readFileSync('dist/content.js', 'utf8');
  vm.runInContext(fs.readFileSync('dist/imageInfo.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('dist/navigationScope.js', 'utf8'), context);
  vm.runInContext(source, context);
  function image(url, loaded = true, height = 1200, top = 0) {
    const node = {
      currentSrc: url, src: url, complete: loaded, naturalWidth: loaded ? 800 : 0,
      top, closest() { return node.slot ?? null; },
      naturalHeight: loaded ? height : 0, isConnected: true,
      getBoundingClientRect: () => ({ width: 800, height, top:node.top, bottom:node.top + height, right: 800, left: 0 }),
      compareDocumentPosition(other) { return document.images.indexOf(node) < document.images.indexOf(other) ? 4 : 2; },
    };
    document.images.push(node);
    return node;
  }
  return { image, document, context, source, events, send: (action, extra = {}) => handler({ action, ...extra }) };
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
  const workerCalls=[], workerClosed=[];
  const browser = { runtime: { getURL: path => path }, downloads: {
    async download() { saved.push(archive); return 7; },
    onChanged: { addListener() {}, removeListener() {} },
    async search() { return [{ state: downloadState }]; },
  } };
  class Zip {
    constructor() { this.zip = new JSZip(); }
    file(name, bytes) { this.zip.file(name, bytes); }
    async generateAsync() { return new Blob([await this.zip.generateAsync({ type: 'uint8array', compression: 'STORE' })]); }
  }
  class CodecWorker {
    constructor(url) {
      assert.equal(url,'jpegWorker.js');
      const owner=this;
      this.context=vm.createContext({Uint8Array,ArrayBuffer,btoa,
        importScripts(file){vm.runInContext(fs.readFileSync('dist/'+file,'utf8'),owner.context);},
        postMessage(message,transfer){const data=structuredClone(message,{transfer});queueMicrotask(()=>owner.onmessage({data}));},
      },{codeGeneration:{strings:false,wasm:false}});
      vm.runInContext(fs.readFileSync('dist/jpegWorker.js','utf8'),this.context);
    }
    postMessage(message,transfer){
      workerCalls.push({width:message.width,height:message.height});
      const data=structuredClone(message,{transfer});
      queueMicrotask(()=>this.context.onmessage({data}));
    }
    terminate(){workerClosed.push(true);}
  }
  const context = vm.createContext({
    JSZip: Zip, Uint8Array, DataView, Blob, AbortSignal, browser, atob, btoa, Worker:CodecWorker,setTimeout,clearTimeout,
    URL: { createObjectURL(blob) { archive = blob; return 'blob:test'; }, revokeObjectURL() {} },
    fetch: async url => responses[url],
  });
  vm.runInContext(fs.readFileSync('dist/imageInfo.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('dist/jpegEncoder.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('dist/imageMagick.js', 'utf8'), context);
  vm.runInContext(fs.readFileSync('dist/export.js', 'utf8'), context);
  return { context, saved, workerCalls, workerClosed };
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
  const response = bytes => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
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

function mergerFixture(options = {}) {
  const draws = [], closed = [];
  let index = 0;
  const jpg = Uint8Array.from([255,216,255,23]);
  const png = Uint8Array.from([137,80,78,71,13,10,26,10,42]);
  const f = exporterFixture({});
  Object.assign(f.context, {
    Set, Error,
    createImageBitmap: async () => {
      if (options.decodeError) throw new Error('decode failed');
      const size = (options.sizes || [[800,200],[600,300],[800,250]])[index++];
      return { width: size[0], height: size[1], close() { closed.push(size); } };
    },
    document: { createElement() { return {
      getContext() { return options.noContext ? null : {
        fillRect(...args) { draws.push(['white', ...args]); },
        drawImage(image, x, y) { draws.push([x,y,image.width,image.height]); },
        getImageData(_x,_y,width,height) {
          if(options.pixelError)throw new Error('Pixel read failed');
          return {data:new Uint8ClampedArray(width*height*4).fill(255)};
        },
      }; },
      toBlob(callback, type, quality) {
        draws.push([type,quality]);
        callback(options.noBlob ? null : new Blob([type === 'image/jpeg' ? jpg : png]));
      },
    }; } },
  });
  vm.runInContext(fs.readFileSync('dist/imageMerger.js','utf8'),f.context);
  vm.runInContext(fs.readFileSync('dist/capturedBlobs.js','utf8'),f.context);
  const page = (url, bytes = jpg) => ({url, order:0, width:800, height:200, selected:true, bytes});
  return { ...f, draws, closed, page, jpg, png };
}

test('Canvas merges two JPEGs at quality .95, centers unequal widths and releases bitmaps', async () => {
  const f = mergerFixture();
  const a=f.page('a'), b=f.page('b');
  const merged=await f.context.mergeImagesVertically([a,b]);
  assert.equal(merged.width,800); assert.equal(merged.height,500);
  assert.deepEqual(f.draws, [['white',0,0,800,500],[0,0,800,200],[100,200,600,300],['image/jpeg',.95]]);
  assert.equal(f.closed.length,2);
  assert.equal(merged.sources[0],a);
  assert.equal(a.bytes,f.jpg);
});

test('three mixed strips use PNG and preserve complete pages, order and exact CBZ bytes', async () => {
  const f=mergerFixture();
  const sources=[f.page('a'),f.page('b',f.png),f.page('c')];
  const complete=f.page('complete');
  const merged=await f.context.mergeImagesVertically(sources);
  assert.equal(merged.height,750);
  assert.equal(f.draws.at(-1)[0],'image/png');
  const pages=f.context.replaceMergedPages([...sources,complete],sources,merged);
  assert.equal(pages[1],complete); assert.equal(complete.bytes,f.jpg);
  await f.context.exportArchive(pages,'merged',()=>{});
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.png','0002.jpg']);
  assert.deepEqual(await zip.file('0001.png').async('uint8array'),f.png);
  assert.deepEqual(await zip.file('0002.jpg').async('uint8array'),f.jpg);
});

test('selection rejects gaps, empty, single and excluded pages', () => {
  const f=mergerFixture(), pages=['a','b','c'].map(url=>f.page(url));
  for (const ids of [[],['a'],['a','c'],['a','missing']]) {
    assert.throws(()=>f.context.mergeSelection(pages,new Set(ids)),/consecutive/);
  }
  assert.equal(f.context.mergeSelection(pages,new Set(['b','a']))[0],pages[0]);
  pages[1].selected=false;
  assert.throws(()=>f.context.mergeSelection(pages,new Set(['a','b'])),/Include/);
});

test('independent and nested undo restores original identities, formats, bytes and order', () => {
  const f=mergerFixture(), originals=['a','b','c','d'].map(url=>f.page(url));
  originals[1].bytes=f.png;
  const first={...f.page('merged1'),sources:originals.slice(0,2)};
  const second={...f.page('merged2'),sources:originals.slice(2)};
  let pages=f.context.replaceMergedPages(originals,first.sources,first);
  pages=f.context.replaceMergedPages(pages,second.sources,second);
  const nested={...f.page('nested'),sources:pages};
  pages=f.context.undoMergedPage([nested],nested);
  pages=f.context.undoMergedPage(pages,first);
  pages=f.context.undoMergedPage(pages,second);
  assert.equal(pages.length,4);
  pages.forEach((page,index)=>assert.equal(page,originals[index]));
  assert.equal(pages[1].bytes,f.png);
});

test('merge failures leave pages in place and close decoded resources', async () => {
  for (const options of [{decodeError:true},{noContext:true},{noBlob:true},{sizes:[[800,20000],[800,20000]]}]) {
    const f=mergerFixture(options), pages=[f.page('a'),f.page('b')];
    await assert.rejects(f.context.mergeImagesVertically(pages),/Merge failed/);
    assert.deepEqual(pages.map(page=>page.url),['a','b']);
    if (!options.decodeError) assert.equal(f.closed.length,2);
  }
});

test('excluding a nested merge also excludes restored intermediate pages', () => {
  const f=mergerFixture();
  const a=f.page('a'), b=f.page('b'), c=f.page('c');
  const first={...f.page('first'),sources:[a,b]};
  const outer={...f.page('outer'),sources:[first,c]};
  f.context.includeReviewPage(outer,false);
  const restored=f.context.undoMergedPage([outer],outer);
  assert.equal(restored[0].selected,false);
  assert.equal(a.selected,false);
  assert.equal(b.selected,false);
  assert.equal(c.selected,false);
});

function groupingFixture(options = {}) {
  const f = mergerFixture(options);
  vm.runInContext(fs.readFileSync('dist/pageGrouping.js', 'utf8'), f.context);
  vm.runInContext(fs.readFileSync('dist/autoGrouping.js', 'utf8'), f.context);
  return f;
}

function edge(width, height, topWhite = false, bottomWhite = false) {
  return { width, height, topWhite, bottomWhite };
}

function suggestions(f, descriptions) {
  const pages = descriptions.map((description, index) => ({ ...f.page(String(index)), selected: description.selected ?? true }));
  const edges = new Map(descriptions.flatMap((description, index) => description.edge ? [[String(index), description.edge]] : []));
  return { pages, result: f.context.suggestPageNumbers(pages, edges) };
}

test('white borders tolerate JPEG gray and sparse noise, but reject content rows', () => {
  const { context } = groupingFixture();
  const pixels = new Uint8ClampedArray(100 * 4).fill(247);
  for (let x = 0; x < 100; x++) pixels[x * 4 + 3] = 255;
  pixels[0] = 0;
  assert.equal(context.hasWhiteEdge(pixels,100),true);
  for (let x = 0; x < 10; x++) pixels[x * 4] = 0;
  assert.equal(context.hasWhiteEdge(pixels,100),false);
  assert.equal(context.hasWhiteEdge(new Uint8ClampedArray(400),100),true); // Transparency over white.
  assert.equal(context.hasWhiteEdge(new Uint8ClampedArray(),100),false);
  assert.equal(context.hasWhiteEdge(new Uint8ClampedArray(400),0),false);
});

test('suggestions number complete portrait pages and two/three-strip groups without modifying pages', () => {
  const f = groupingFixture();
  const { pages, result } = suggestions(f, [
    {edge:edge(800,1200,true,true)},
    {edge:edge(800,500,true,false)}, {edge:edge(800,500,false,true)},
    {edge:edge(800,400,true,false)}, {edge:edge(800,400)}, {edge:edge(800,400,false,true)},
    {edge:edge(800,1200)},
  ]);
  assert.deepEqual(Array.from(result,s=>s.pageNumber),[1,2,2,3,3,3,4]);
  assert.equal(pages[1].pageNumber,undefined);
  result.forEach(s=>s.page.pageNumber=s.pageNumber);
  const groups = f.context.numberedPageGroups(pages);
  assert.deepEqual(Array.from(groups,g=>Array.from(g,p=>p.url)),[['1','2'],['3','4','5']]);
});

test('ambiguous borders, complete landscapes, short groups, missing analysis and width changes stay separate', () => {
  const f = groupingFixture();
  for (const descriptions of [
    [{edge:edge(800,500)}, {edge:edge(800,500,false,true)}],
    [{edge:edge(800,500,true)}, {edge:edge(800,500)}],
    [{edge:edge(800,500,true,true)}, {edge:edge(800,500,false,true)}],
    [{edge:edge(800,500,true)}, {edge:edge(800,500,true,true)}],
    [{edge:edge(800,200,true)}, {edge:edge(800,200,false,true)}],
    [{edge:edge(800,500,true)}, {}, {edge:edge(800,500,false,true)}],
    [{edge:edge(800,500,true)}, {edge:edge(600,500,false,true)}],
  ]) {
    const {result} = suggestions(f,descriptions);
    assert.deepEqual(Array.from(result,s=>s.pageNumber),descriptions.map((_,i)=>i+1));
  }
});

test('detection skips exclusions, respects included portrait boundaries and finds later groups', () => {
  const f = groupingFixture();
  const {result} = suggestions(f,[
    {edge:edge(800,500,true)}, {edge:edge(800,100),selected:false}, {edge:edge(800,500,false,true)},
    {edge:edge(800,500,true)}, {edge:edge(800,1200)}, {edge:edge(800,500,false,true)},
    {edge:edge(800,500,true)}, {edge:edge(790,500,false,true)}, {edge:edge(800,1200)},
  ]);
  assert.deepEqual(Array.from(result,s=>s.pageNumber),[1,undefined,1,2,3,4,5,5,6]);
});

test('numbered groups reject invalid numbers and separated duplicates without changing reading order', () => {
  const f = groupingFixture();
  const pages = ['a','b','c'].map((url,index)=>({...f.page(url),pageNumber:index+1}));
  for (const number of [NaN,0,-1,1.5,Infinity,undefined]) {
    pages[0].pageNumber=number;
    assert.throws(()=>f.context.numberedPageGroups(pages),/positive whole/);
  }
  pages[0].pageNumber=1; pages[2].pageNumber=1;
  assert.throws(()=>f.context.numberedPageGroups(pages),/consecutive/);
  pages[1].selected=false;
  assert.deepEqual(Array.from(f.context.numberedPageGroups(pages)[0],p=>p.url),['a','c']);
  pages[1].selected=true; pages[1].pageNumber=1;
  const groups=f.context.numberedPageGroups(pages);
  assert.deepEqual(Array.from(groups[0],p=>p.url),['a','b','c']);
});

test('edge analysis samples only the first/last native rows, caches bytes and closes resources', async () => {
  const f = groupingFixture();
  const calls=[];
  const white=new Uint8ClampedArray(800*3*4).fill(255);
  const black=new Uint8ClampedArray(800*3*4);
  for(let i=3;i<black.length;i+=4) black[i]=255;
  const canvas={
    getContext() { return {
      fillRect(){}, drawImage(...args){calls.push(args.slice(1));},
      getImageData(x,y){return {data:y===0?white:black};},
    }; },
  };
  f.context.document.createElement=()=>canvas;
  const page=f.page('a');
  const observed=await f.context.inspectPageEdges(page);
  assert.equal(observed.topWhite,true); assert.equal(observed.bottomWhite,false);
  assert.deepEqual(calls,[[0,0,800,3,0,0,800,3],[0,197,800,3,0,3,800,3]]);
  assert.equal(canvas.width,0); assert.equal(canvas.height,0);
  assert.equal(f.closed.length,1); assert.equal(page.bytes,f.jpg);
  const failed=groupingFixture({noContext:true});
  await assert.rejects(failed.context.inspectPageEdges(failed.page('a')),/allocate/);
  assert.equal(failed.closed.length,1);
});

test('suggested groups merge to expected CBZ pages, retain single-page bytes and undo numbering', async () => {
  const f=groupingFixture({sizes:[[800,500],[800,500],[800,400],[800,400],[800,400]]});
  const {pages,result}=suggestions(f,[
    {edge:edge(800,500,true)}, {edge:edge(800,500,false,true)},
    {edge:edge(800,1200)},
    {edge:edge(800,400,true)}, {edge:edge(800,400)}, {edge:edge(800,400,false,true)},
    {edge:edge(800,1200)},
  ]);
  result.forEach(s=>s.page.pageNumber=s.pageNumber);
  const groups=f.context.numberedPageGroups(pages);
  let current=pages;
  const merged=[];
  for(const sources of groups) {
    const page=await f.context.mergeImagesVertically(sources);
    merged.push(page); current=f.context.replaceMergedPages(current,sources,page);
  }
  assert.deepEqual(Array.from(current,p=>p.pageNumber),[1,2,3,4]);
  assert.equal(current[1],pages[2]);
  await f.context.exportArchive(current,'numbered',()=>{});
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.jpg','0002.jpg','0003.jpg','0004.jpg']);
  assert.deepEqual(await zip.file('0002.jpg').async('uint8array'),pages[2].bytes);
  for(const page of merged) current=f.context.undoMergedPage(current,page);
  current.forEach((page,i)=>assert.equal(page,pages[i]));
  assert.deepEqual(Array.from(current,p=>p.pageNumber),[1,1,2,3,3,3,4]);
});

async function reviewFixture(options = {}) {
  const f=groupingFixture(options);
  class Element {
    constructor(tag='div') { this.tagName=tag; this.children=[]; this.disabled=false; this.textContent=''; this.className=''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children=children; }
    setAttribute() {}
    get classList() { return { toggle: (name,enabled)=> {
      const classes=new Set(this.className.split(' ').filter(Boolean));
      if(enabled) classes.add(name); else classes.delete(name);
      this.className=[...classes].join(' ');
    } }; }
  }
  const ids=new Map();
  for(const id of ['status','list','title','export','merge','undo','merge-numbered','detect','selection','numbering','start','stop','refresh','close-preview','hide-excluded','target-height','detect-height','height-tolerance','minimum-width','exclude-narrow','auto-analyze','auto-ratio','auto-tolerance','review-excluded','auto-summary']) {
    ids.set(id,new Element(['title','hide-excluded','target-height','height-tolerance','minimum-width','auto-ratio','auto-tolerance'].includes(id)?'input':id==='status'||id==='list'||id==='selection'||id==='numbering'?'div':'button'));
  }
  ids.get('height-tolerance').valueAsNumber=1;
  if(options.automaticNavigation) {
    const automatic = new Element('input'); automatic.checked = true;
    ids.set('auto-continue', automatic);
  }
  if(options.imageOptions) {
    for(const id of ['show-image-info','convert-jpeg']) ids.set(id,new Element('input'));
    ids.get('show-image-info').checked=false;ids.get('convert-jpeg').checked=false;
    ids.set('image-info',new Element('p'));ids.set('measure-files',new Element('button'));
  }
  if(options.nativeOptions){
    const engine=new Element('select');engine.value='auto';ids.set('jpeg-engine',engine);
    ids.set('check-imagemagick',new Element('button'));ids.set('jpeg-engine-status',new Element('p'));
  }
  ids.get('auto-tolerance').valueAsNumber=10;
  function controls() {
    const found=new Set();
    function visit(element) {
      if(typeof element!=='object'||found.has(element)) return;
      found.add(element); element.children.forEach(visit);
    }
    ids.forEach(visit);
    return [...found].filter(element=>['button','input'].includes(element.tagName));
  }
  const source=options.pages ? options.pages.map(page=>({...f.page(page.url),...page})) : ['a','b','c','d'].map(url=>f.page(url));
  const revoked=[], permissions=[], previewBlobs=[], uiEvents={}, thumbnailSizes=[];
  let objectId=0;
  Object.assign(f.context,{
    URL:class extends URL {
      static createObjectURL(blob){previewBlobs.push(blob);return 'blob:review/'+(++objectId);}
      static revokeObjectURL(url){revoked.push(url);}
    },
    URLSearchParams,location:{search:options.popup?'':'?tab=1'},window:{addEventListener(name,callback){uiEvents[name]=callback;}},setTimeout,
  });
  const createCanvas=f.context.document.createElement;
  f.context.document={
    getElementById:id=>ids.get(id),
    createElement:tag=>{
      if(tag!=='canvas')return new Element(tag);
      const canvas=createCanvas();
      if(options.thumbnailCanvas)canvas.toDataURL=()=>{
        thumbnailSizes.push([canvas.width,canvas.height]);
        return 'data:image/png;base64,'+Buffer.from(f.png).toString('base64');
      };
      return canvas;
    },
    querySelectorAll:()=>controls(),
  };
  f.context.browser.permissions={request:async request=>{permissions.push(request);return options.permission!==false;}};
  if (options.archive) f.context.browser.runtime = { ...f.context.browser.runtime, sendMessage: options.archive };
  if (options.popup) { ids.delete('merge'); ids.delete('undo'); }
  f.context.browser.scripting={executeScript:async()=>[]};
  f.context.browser.tabs={sendMessage:async (_,message)=>{
    if(options.capture)return options.capture.send(message.action,message);
    if(message.action==='select') source.find(page=>page.url===message.url).selected=message.selected;
    return {capturing:false,generation:'fixture',entries:source.map(page=>({...page})),missing:0,title:'Chapter'};
  },query:async()=>[{id:1,url:'https://www.scan-manga.com/chapter'}]};
  vm.runInContext(fs.readFileSync('dist/popup.js','utf8'),f.context);
  await new Promise(setImmediate);
  const rows=()=>ids.get('list').children;
  const numbers=()=>rows().map(row=>row.children.find(child=>child.className==='page-number').children[1]);
  const setNumbers=values=>values.forEach((value,index)=>{
    const input=numbers()[index]; input.valueAsNumber=value; input.oninput();
  });
  const idle=async()=>{
    for(let i=0;i<200;i++) {
      await new Promise(resolve=>setTimeout(resolve,2));
      if(!ids.get('review-excluded').disabled && ids.get('status').textContent)return;
    }
    throw new Error('Review operation did not finish');
  };
  return {...f,ids,rows,numbers,setNumbers,idle,revoked,permissions,previewBlobs,uiEvents,thumbnailSizes};
}

test('review column merges all numbered groups and supports independent undo after selection changes', async () => {
  const f=await reviewFixture({sizes:[[800,500],[800,500],[800,500],[800,500]]});
  assert.deepEqual(f.numbers().map(input=>input.value),['1','2','3','4']);
  f.setNumbers([1,1,2,2]);
  assert.equal(f.ids.get('merge-numbered').disabled,false);
  f.ids.get('merge-numbered').onclick(); await f.idle();
  assert.equal(f.rows().length,2);
  assert.deepEqual(f.numbers().map(input=>input.value),['1','2']);
  assert.equal(f.ids.get('merge-numbered').disabled,true);
  const selection=f.rows()[0].children.find(child=>child.children?.[1]==='Merge').children[0];
  selection.checked=true; selection.onchange();
  const restore=f.rows()[0].children.find(child=>child.textContent==='Undo merge');
  restore.onclick();
  assert.equal(f.rows().length,3);
  f.ids.get('undo').onclick();
  assert.equal(f.rows().length,4);
  assert.deepEqual(f.numbers().map(input=>input.value),['1','1','2','2']);
  assert.equal(f.revoked.length,2);
});

test('failed numbered batch leaves every row intact and revokes provisional output', async () => {
  const f=await reviewFixture({sizes:[[800,500],[800,500]]});
  const decode=f.context.createImageBitmap;
  let count=0;
  f.context.createImageBitmap=async blob=>{if(++count>2)throw new Error('bad image');return decode(blob);};
  f.setNumbers([1,1,2,2]);
  f.ids.get('merge-numbered').onclick(); await f.idle();
  assert.equal(f.rows().length,4);
  assert.deepEqual(f.numbers().map(input=>input.value),['1','1','2','2']);
  assert.match(f.ids.get('status').textContent,/bad image/);
  assert.equal(f.revoked.length,1);
  assert.equal(f.ids.get('undo').disabled,true);
});

test('review refuses export while numbered groups remain unapplied or numbers are invalid', async () => {
  const f=await reviewFixture();
  f.setNumbers([1,1,2,3]);
  f.ids.get('export').onclick();
  assert.match(f.ids.get('status').textContent,/Merge numbered pages/);
  assert.equal(f.permissions.length,0);
  f.setNumbers([NaN,1,2,3]);
  f.ids.get('export').onclick();
  assert.match(f.ids.get('status').textContent,/positive whole/);
  assert.equal(f.permissions.length,0);
});

test('review suggestions fill the column without merging, and permission denial preserves edits', async () => {
  const f=await reviewFixture();
  const edges=[edge(800,500,true),edge(800,500,false,true),edge(800,1200),edge(800,1200)];
  let next=0;
  f.context.inspectPageEdges=async()=>edges[next++];
  f.ids.get('detect').onclick(); await f.idle();
  assert.equal(f.rows().length,4);
  assert.deepEqual(f.numbers().map(input=>input.value),['1','1','2','3']);
  assert.match(f.ids.get('status').textContent,/Page numbers suggested/);
  const denied=await reviewFixture({permission:false,pages:['a','b','c','d'].map(url=>({url:'https://test/'+url,bytes:undefined}))});
  denied.setNumbers([1,1,2,2]);
  denied.ids.get('detect').onclick(); await denied.idle();
  assert.deepEqual(denied.numbers().map(input=>input.value),['1','1','2','2']);
  assert.match(denied.ids.get('status').textContent,/not granted/);
});

test('automatic grouping checks merged ratio against consistent included portrait references', () => {
  const f=groupingFixture();
  const refs=[{edge:edge(800,1200)},{edge:edge(800,1200)}];
  const valid=suggestions(f,[{edge:edge(800,600,true)},{edge:edge(800,600,false,true)},...refs]);
  assert.deepEqual(Array.from(valid.result,s=>s.pageNumber),[1,1,2,3]);
  for(const height of [450,750]) {
    const invalid=suggestions(f,[{edge:edge(800,height,true)},{edge:edge(800,height,false,true)},...refs]);
    assert.deepEqual(Array.from(invalid.result,s=>s.pageNumber),[1,2,3,4]);
    assert.match(invalid.result[0].note,/ratio differs/);
  }
  // A disabled low-resolution preview must not bias the reference or split the group.
  const skipped=suggestions(f,[
    {edge:edge(800,600,true)}, {edge:edge(100,500,true,true),selected:false},
    {edge:edge(800,600,false,true)},...refs,
  ]);
  assert.deepEqual(Array.from(skipped.result,s=>s.pageNumber),[1,undefined,1,2,3]);
});

test('missing or inconsistent portrait references require manual assignment; median resists one outlier', () => {
  const f=groupingFixture();
  const strips=[{edge:edge(800,600,true)},{edge:edge(800,600,false,true)}];
  for(const refs of [[],[{edge:edge(800,1200)}],[{edge:edge(800,900)},{edge:edge(800,4000)}]]) {
    const {result}=suggestions(f,[...strips,...refs]);
    assert.notEqual(result[0].pageNumber,result[1].pageNumber);
    assert.match(result[0].note,/No consistent ratio reference/);
  }
  const {result}=suggestions(f,[...strips,{edge:edge(800,1200)},{edge:edge(800,1200)},{edge:edge(800,4000)}]);
  assert.equal(result[0].pageNumber,result[1].pageNumber);
});

test('merging across excluded previews preserves bytes, export order and exact undo layout', async () => {
  const f=groupingFixture({sizes:[[800,600],[800,600]]});
  const a={...f.page('a'),pageNumber:1};
  const preview={...f.page('preview',f.png),selected:false,pageNumber:99};
  const b={...f.page('b'),pageNumber:1};
  const c={...f.page('c'),pageNumber:2};
  const pages=[a,preview,b,c];
  const sources=f.context.numberedPageGroups(pages)[0];
  assert.deepEqual(Array.from(f.context.mergeSelection(pages,new Set(['a','b'])),page=>page.url),['a','b']);
  const merged=await f.context.mergeImagesVertically(sources);
  const current=f.context.replaceMergedPages(pages,sources,merged);
  assert.deepEqual(Array.from(current,page=>page.url),[merged.url,'preview','c']);
  assert.equal(current[1].selected,false);
  assert.equal(current[1].bytes,f.png);
  await f.context.exportArchive(current.filter(page=>page.selected),'skip previews',()=>{});
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.jpg','0002.jpg']);
  assert.deepEqual(await zip.file('0002.jpg').async('uint8array'),c.bytes);
  const restored=f.context.undoMergedPage(current,merged);
  restored.forEach((page,index)=>assert.equal(page,pages[index]));
  assert.equal(restored.length,4);
  assert.throws(()=>f.context.replaceMergedPages([a,{...preview,selected:true},b,c],sources,merged),/order changed/);
});

test('nested and independent merges across multiple excluded rows restore original order without duplicates', () => {
  const f=groupingFixture();
  const [a,x,b,c,y,d]=['a','x','b','c','y','d'].map(url=>f.page(url));
  x.selected=false; y.selected=false;
  const original=[a,x,b,c,y,d];
  const first={...f.page('first'),sources:[a,b]};
  const second={...f.page('second'),sources:[c,d]};
  let current=f.context.replaceMergedPages(original,first.sources,first);
  current=f.context.replaceMergedPages(current,second.sources,second);
  const outer={...f.page('outer'),sources:[first,second]};
  current=f.context.replaceMergedPages(current,outer.sources,outer);
  current=f.context.undoMergedPage(current,outer);
  current=f.context.undoMergedPage(current,second);
  current=f.context.undoMergedPage(current,first);
  assert.equal(current.length,original.length);
  current.forEach((page,index)=>assert.equal(page,original[index]));
});

test('review hides disabled images reversibly and merges numbered strips across them', async () => {
  const f=await reviewFixture({sizes:[[800,600],[800,600]]});
  const excluded=f.rows()[1].children[0];
  excluded.checked=false; excluded.onchange();
  await new Promise(setImmediate);
  f.setNumbers([1,99,1,2]);
  assert.equal(f.ids.get('merge-numbered').disabled,false);
  const hide=f.ids.get('hide-excluded');
  hide.checked=true; hide.onchange();
  assert.deepEqual(f.rows().map(row=>row.hidden),[false,true,false,false]);
  f.ids.get('merge-numbered').onclick(); await f.idle();
  assert.equal(f.rows().length,3);
  assert.deepEqual(f.rows().map(row=>row.hidden),[false,true,false]);
  f.ids.get('undo').onclick();
  assert.deepEqual(f.numbers().map(input=>input.value),['1','99','1','2']);
  assert.deepEqual(f.rows().map(row=>row.hidden),[false,true,false,false]);
  hide.checked=false; hide.onchange();
  assert.equal(f.rows().some(row=>row.hidden),false);
  const include=f.rows()[1].children[0];
  include.checked=true; include.onchange();
  assert.equal(f.ids.get('merge-numbered').disabled,true);
});

function heightStrips(f, heights, width=1280) {
  return heights.map((height,index)=>({...f.page('strip-'+index),width,height}));
}

test('height fallback groups the supplied six-strip example into exactly 1813 px without reference pages', async () => {
  const heights=[302,302,302,303,302,302];
  const f=groupingFixture({sizes:heights.map(height=>[1280,height])});
  const pages=heightStrips(f,heights);
  const suggested=f.context.suggestPagesByHeight(pages,1813);
  assert.deepEqual(Array.from(suggested,s=>s.pageNumber),[1,1,1,1,1,1]);
  assert.equal(pages[0].pageNumber,undefined); // Suggestions do not mutate input.
  suggested.forEach(s=>s.page.pageNumber=s.pageNumber);
  const sources=f.context.numberedPageGroups(pages)[0];
  const merged=await f.context.mergeImagesVertically(sources);
  assert.equal(merged.width,1280); assert.equal(merged.height,1813);
  const current=f.context.replaceMergedPages(pages,sources,merged);
  assert.equal(current.length,1);
  await f.context.exportArchive(current,'height example',()=>{});
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.jpg']);
  const restored=f.context.undoMergedPage(current,merged);
  restored.forEach((page,index)=>assert.equal(page,pages[index]));
});

test('height fallback resynchronizes after unmatched strips, skips excluded previews and preserves complete pages', () => {
  const f=groupingFixture();
  const heights=[302,302,302,303,302,302];
  const first=heightStrips(f,heights);
  const second=heightStrips(f,heights).map(page=>({...page,url:page.url+'-second'}));
  const excluded={...f.page('preview'),selected:false,width:100,height:70};
  const full={...f.page('full'),width:1280,height:1813};
  const orphan={...f.page('orphan'),width:1280,height:50};
  const tail={...f.page('tail'),width:1280,height:302};
  const pages=[orphan,...first.slice(0,2),excluded,...first.slice(2),full,...second,tail];
  const suggested=f.context.suggestPagesByHeight(pages,1813);
  assert.deepEqual(Array.from(suggested,s=>s.pageNumber),[1,2,2,undefined,2,2,2,2,3,4,4,4,4,4,4,5]);
  assert.match(suggested[0].note,/No group within/);
  assert.match(suggested[8].note,/Already at target/);
  assert.match(suggested.at(-1).note,/No group within/);
  suggested.forEach(s=>s.page.pageNumber=s.pageNumber);
  assert.equal(f.context.numberedPageGroups(pages).length,2);
  assert.equal(full.bytes,f.jpg);
});

test('height fallback rejects invalid targets and never merges overshoots, width mismatches or existing merges', () => {
  const f=groupingFixture();
  for(const target of [0,-1,NaN,Infinity,1813.5,32768]) {
    assert.throws(()=>f.context.suggestPagesByHeight([],target),/whole target height/);
  }
  for(const pages of [
    heightStrips(f,[900,914]),
    heightStrips(f,[900,913]).map((page,index)=>({...page,width:index?600:1280})),
    heightStrips(f,[900,913]).map((page,index)=>index?{...page,sources:[f.page('original')]}:page),
    heightStrips(f,[900,913]).map((page,index)=>({...page,height:index?NaN:900})),
  ]) {
    const result=f.context.suggestPagesByHeight(pages,1813,0);
    assert.deepEqual(Array.from(result,s=>s.pageNumber),[1,2]);
  }
});

test('review height button proposes groups, validates target without changing edits, and retains merge/undo workflow', async () => {
  const heights=[302,302,302,303,302,302];
  const f=await reviewFixture({
    sizes:heights.map(height=>[1280,height]),
    pages:heights.map((height,index)=>({url:'image-'+index,width:1280,height})),
  });
  f.ids.get('target-height').valueAsNumber=1813;
  f.ids.get('detect-height').onclick();
  assert.equal(f.rows().length,6);
  assert.deepEqual(f.numbers().map(input=>input.value),['1','1','1','1','1','1']);
  assert.match(f.ids.get('status').textContent,/1 group\(s\) suggested near 1813 px/);
  assert.equal(f.permissions.length,0); // Captured dimensions need no network access.
  f.ids.get('target-height').valueAsNumber=0;
  f.ids.get('detect-height').onclick();
  assert.match(f.ids.get('status').textContent,/whole target height/);
  assert.deepEqual(f.numbers().map(input=>input.value),['1','1','1','1','1','1']);
  f.ids.get('merge-numbered').onclick(); await f.idle();
  assert.equal(f.rows().length,1);
  assert.match(f.rows()[0].children[2].textContent,/1280.*1813/);
  f.ids.get('undo').onclick();
  assert.equal(f.rows().length,6);
});

test('height tolerance accepts both bounds, rejects outside values and chooses the closest total', () => {
  const f=groupingFixture();
  for(const height of [490,510]) {
    const result=f.context.suggestPagesByHeight(heightStrips(f,[500,height]),1000,1);
    assert.deepEqual(Array.from(result,s=>s.pageNumber),[1,1]);
    assert.match(result[0].note,new RegExp('total height '+(500+height)+' px'));
  }
  for(const height of [489,511]) {
    const result=f.context.suggestPagesByHeight(heightStrips(f,[500,height]),1000,1);
    assert.deepEqual(Array.from(result,s=>s.pageNumber),[1,2]);
  }
  const closest=f.context.suggestPagesByHeight(heightStrips(f,[500,490,10]),1000,1);
  assert.deepEqual(Array.from(closest,s=>s.pageNumber),[1,1,1]);
  assert.match(closest[0].note,/total height 1000 px/);
  const full=f.context.suggestPagesByHeight(heightStrips(f,[995,5]),1000,1);
  assert.deepEqual(Array.from(full,s=>s.pageNumber),[1,2]);
  for(const tolerance of [-1,NaN,Infinity,11]) {
    assert.throws(()=>f.context.suggestPagesByHeight([],1000,tolerance),/height tolerance/);
  }
});

test('review forwards adjustable height tolerance, including exact matching at zero', async () => {
  const f=await reviewFixture({pages:[{url:'a',width:800,height:500},{url:'b',width:800,height:495}]});
  f.ids.get('target-height').valueAsNumber=1000;
  f.ids.get('height-tolerance').valueAsNumber=1;
  f.ids.get('detect-height').onclick();
  assert.deepEqual(f.numbers().map(input=>input.value),['1','1']);
  f.ids.get('height-tolerance').valueAsNumber=0;
  f.ids.get('detect-height').onclick();
  assert.deepEqual(f.numbers().map(input=>input.value),['1','2']);
});

test('minimum width excludes previews, preserves threshold/unknown widths and retains exclusions across refresh', async () => {
  const f=await reviewFixture({pages:[
    {url:'a',width:1280,height:500}, {url:'preview',width:320,height:320},
    {url:'b',width:1280,height:500}, {url:'equal',width:321,height:500},
    {url:'unknown',width:0,height:0}, {url:'excluded',width:1280,height:500,selected:false},
  ]});
  f.setNumbers([1,99,1,2,3,4]);
  assert.equal(f.ids.get('merge-numbered').disabled,true);
  f.ids.get('minimum-width').valueAsNumber=321;
  f.ids.get('exclude-narrow').onclick(); await f.idle();
  assert.deepEqual(f.rows().map(row=>row.children[0].checked),[true,false,true,true,true,false]);
  assert.equal(f.ids.get('merge-numbered').disabled,false);
  assert.match(f.ids.get('status').textContent,/1 image\(s\) narrower than 321 px excluded/);
  assert.equal(f.permissions.length,0);
  await f.ids.get('refresh').onclick();
  assert.equal(f.rows()[1].children[0].checked,false);
  f.ids.get('minimum-width').valueAsNumber=100;
  f.ids.get('exclude-narrow').onclick(); await f.idle();
  assert.equal(f.rows()[1].children[0].checked,false);
  const hide=f.ids.get('hide-excluded'); hide.checked=true; hide.onchange();
  assert.equal(f.rows()[1].hidden,true);
  hide.checked=false; hide.onchange();
  const include=f.rows()[1].children[0]; include.checked=true; include.onchange();
  assert.equal(f.rows()[1].children[0].checked,true);
});

test('minimum width rejects empty, fractional and invalid thresholds without changing inclusion', async () => {
  const f=await reviewFixture({pages:[{url:'preview',width:320,height:320}]});
  for(const minimum of [NaN,0,-1,320.5,Infinity]) {
    f.ids.get('minimum-width').valueAsNumber=minimum;
    f.ids.get('exclude-narrow').onclick();
    assert.match(f.ids.get('status').textContent,/positive whole minimum width/);
    assert.equal(f.rows()[0].children[0].checked,true);
  }
});

function automaticChapter(f) {
  const page=(url,width,height,extra={})=>({...f.page(url),width,height,...extra});
  return [
    page('reference-a',1000,1500),
    page('a1',1000,400),page('thumb',320,320),page('a2',1000,500),page('a3',1000,600),
    page('b1',1200,600),page('b2',1200,600),page('b3',1200,600),
    page('c1',800,300),page('c2',800,400),page('c3',800,500),
    page('double',2000,1400),page('reference-b',1200,1800),
  ];
}

test('automatic ratio analysis finds three different page heights and excludes an interleaved thumbnail and double page', () => {
  const f=groupingFixture(), pages=automaticChapter(f);
  const plan=f.context.suggestPagesAutomatically(pages,{tolerancePercent:10});
  assert.equal(plan.ratio,1.5);
  const mapped=new Map(Array.from(plan.suggestions,s=>[s.page.url,s]));
  assert.equal(mapped.get('thumb').selected,false);
  assert.equal(mapped.get('double').selected,false);
  for(const prefix of ['a','b','c']) {
    assert.equal(mapped.get(prefix+'1').pageNumber,mapped.get(prefix+'3').pageNumber);
    assert.equal(mapped.get(prefix+'2').selected,true);
  }
  assert.equal(mapped.get('reference-a').selected,true);
  assert.equal(mapped.get('reference-b').selected,true);
  assert.equal(pages.every(page=>page.selected),true); // The planner is non-mutating.
  const projected=plan.suggestions.map(s=>({...s.page,selected:s.selected,pageNumber:s.pageNumber}));
  assert.equal(f.context.numberedPageGroups(projected).length,3);
});

test('automatic ratio analysis respects exclusions, restored exceptions, existing merges and unknown dimensions', () => {
  const f=groupingFixture(),pages=automaticChapter(f);
  pages.find(page=>page.url==='double').keepSeparate=true;
  pages.find(page=>page.url==='thumb').selected=false;
  pages.push({...f.page('unknown'),width:0,height:0});
  pages.push({...f.page('merged'),width:900,height:2500,sources:[f.page('old')]});
  const plan=f.context.suggestPagesAutomatically(pages,{tolerancePercent:10,minimumWidth:400});
  const mapped=new Map(Array.from(plan.suggestions,s=>[s.page.url,s]));
  assert.equal(mapped.get('thumb').selected,false);
  for(const url of ['double','unknown','merged'])assert.equal(mapped.get(url).selected,true);
  assert.match(mapped.get('unknown').note,/manual review/);
  assert.match(mapped.get('double').note,/Exception/);
});

test('automatic ratio analysis fails safely without reference and supports an explicit reference', () => {
  const f=groupingFixture(),pages=heightStrips(f,[500,500,500],1000);
  assert.throws(()=>f.context.suggestPagesAutomatically(pages,{tolerancePercent:10}),/No reliable portrait ratio/);
  const result=f.context.suggestPagesAutomatically(pages,{ratio:1.5,tolerancePercent:10});
  assert.deepEqual(Array.from(result.suggestions,s=>s.pageNumber),[1,1,1]);
  for(const options of [{ratio:1},{ratio:NaN},{tolerancePercent:21},{minimumWidth:-1}]) {
    assert.throws(()=>f.context.suggestPagesAutomatically(pages,{ratio:1.5,tolerancePercent:10,...options}));
  }
  assert.equal(pages.every(page=>page.selected),true);
});

test('automatic grouping preserves complete low-resolution pages unless a minimum width is explicitly provided', () => {
  const f=groupingFixture(),pages=automaticChapter(f);
  pages.splice(1,0,{...f.page('small-portrait'),width:320,height:480});
  let plan=f.context.suggestPagesAutomatically(pages,{tolerancePercent:10});
  assert.equal(plan.suggestions.find(s=>s.page.url==='small-portrait').selected,true);
  plan=f.context.suggestPagesAutomatically(pages,{tolerancePercent:10,minimumWidth:400});
  assert.equal(plan.suggestions.find(s=>s.page.url==='small-portrait').selected,false);
});

test('automatic review handles all groups once, exposes exclusions, protects restored exceptions and preserves undo/export order', async () => {
  const f=await reviewFixture({
    pages:automaticChapter(groupingFixture()),
    sizes:[[1000,400],[1000,500],[1000,600],[1200,600],[1200,600],[1200,600],[800,300],[800,400],[800,500]],
  });
  f.ids.get('auto-analyze').onclick(); await f.idle();
  assert.match(f.ids.get('auto-summary').textContent,/3 group\(s\) ready to merge, 2 excluded/);
  assert.equal(f.permissions.length,0);
  assert.equal(f.rows()[2].children[0].checked,false);
  assert.equal(f.rows()[2].hidden,true);
  f.ids.get('review-excluded').onclick();
  assert.deepEqual(f.rows().flatMap((row,index)=>!row.hidden?[index]:[]),[2,11]);
  const restore=f.rows()[11].children.find(child=>child.textContent==='Restore as page');
  restore.onclick(); await f.idle();
  assert.equal(f.rows()[11].children[0].checked,true);
  f.ids.get('review-excluded').onclick();
  f.ids.get('auto-analyze').onclick(); await f.idle();
  assert.equal(f.rows()[11].children[0].checked,true);
  assert.match(f.ids.get('auto-summary').textContent,/3 group\(s\) ready to merge, 1 excluded/);
  await f.ids.get('refresh').onclick();
  assert.equal(f.rows()[2].children[0].checked,false);
  f.ids.get('merge-numbered').onclick(); await f.idle();
  assert.equal(f.rows().length,7); // Two references, three merged pages, thumbnail, double page.
  assert.equal(f.rows().filter(row=>row.children[0].checked).length,6);
  const captions=f.rows().map(row=>row.children[2].textContent);
  assert.match(captions[1],/1000.*1500/);
  assert.match(captions[3],/1200.*1800/);
  assert.match(captions[4],/800.*1200/);
  f.ids.get('undo').onclick();
  assert.equal(f.rows().length,9);
  f.ids.get('undo').onclick(); f.ids.get('undo').onclick();
  assert.equal(f.rows().length,13);
  assert.equal(f.rows()[2].children[0].checked,false);
});

test('automatic review leaves inclusion and numbering unchanged when no ratio can be estimated', async () => {
  const f=await reviewFixture({pages:[{url:'a',width:1000,height:500},{url:'b',width:1000,height:500}]});
  const before=f.numbers().map(input=>input.value);
  f.ids.get('auto-analyze').onclick();
  assert.match(f.ids.get('auto-summary').textContent,/Nothing was changed/);
  assert.deepEqual(f.numbers().map(input=>input.value),before);
  assert.equal(f.rows().every(row=>row.children[0].checked),true);
  f.ids.get('auto-ratio').value='1.5'; f.ids.get('auto-ratio').valueAsNumber=1.5;
  f.ids.get('auto-analyze').onclick(); await f.idle();
  assert.equal(f.rows().every(row=>!row.children[0].checked),true); // Missing third strip: reviewable exclusions.
  f.ids.get('review-excluded').onclick();
  assert.equal(f.rows().every(row=>!row.hidden),true);
});

test('automatic multi-height groups export once in reading order with exact unmodified reference bytes', async () => {
  const f=groupingFixture({sizes:[[1000,400],[1000,500],[1000,600],[1200,600],[1200,600],[1200,600],[800,300],[800,400],[800,500]]});
  const original=automaticChapter(f);
  original.at(-1).bytes=f.png;
  const plan=f.context.suggestPagesAutomatically(original,{tolerancePercent:10});
  plan.suggestions.forEach(s=>{s.page.selected=s.selected;s.page.pageNumber=s.pageNumber;});
  const groups=f.context.numberedPageGroups(original);
  let current=original;
  for(const sources of groups) {
    const merged=await f.context.mergeImagesVertically(sources);
    current=f.context.replaceMergedPages(current,sources,merged);
  }
  const included=current.filter(page=>page.selected);
  assert.deepEqual(Array.from(included,page=>[page.width,page.height]),[[1000,1500],[1000,1500],[1200,1800],[800,1200],[1200,1800]]);
  await f.context.exportArchive(included,'Automatic chapter',()=>{});
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.jpg','0002.jpg','0003.jpg','0004.jpg','0005.png']);
  assert.deepEqual(await zip.file('0001.jpg').async('uint8array'),original[0].bytes);
  assert.deepEqual(await zip.file('0005.png').async('uint8array'),original.at(-1).bytes);
});

test('automatic analysis reports source communication failure without committing the proposal', async () => {
  const f=await reviewFixture({pages:automaticChapter(groupingFixture())});
  const previous=f.numbers().map(input=>input.value);
  f.context.browser.tabs.sendMessage=async()=>{throw new Error('tab closed');};
  f.ids.get('auto-analyze').onclick(); await f.idle();
  assert.match(f.ids.get('status').textContent,/source tab was closed or navigated/);
  assert.deepEqual(f.numbers().map(input=>input.value),previous);
  assert.equal(f.rows().every(row=>row.children[0].checked),true);
});

function scanMangaFixture(count, data = Uint8Array.from([255,216,255,42])) {
  const fetched=[];
  const f=captureFixture({hostname:'www.scan-manga.com',origin:'https://www.scan-manga.com',fetch:async url=>{
    fetched.push(url);return {ok:true,arrayBuffer:async()=>data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength)};
  }});
  f.document.reader={dataset:{nbpage:String(count)},querySelectorAll:()=>f.document.images.filter(img=>img.slot)};
  const page=(number,top=0,url='blob:https://www.scan-manga.com/page-'+number)=>{
    const image=f.image(url,true,1982,top);
    image.naturalWidth=1400;image.slot={dataset:{page:String(number)}};
    return image;
  };
  return {...f,page,fetched,data};
}

test('same-origin blobs are cached immediately and transferred in chunks after URL revocation', async () => {
  const data=new Uint8Array(600000).fill(37);data.set([255,216,255]);
  const f=scanMangaFixture(1,data);
  const image=f.page(1);
  const state=await f.send('start');
  assert.equal(state.entries.length,1);
  assert.equal(f.fetched.length,1);
  f.context.fetch=async()=>{throw new Error('Blob was revoked');};
  const fexport=groupingFixture();
  fexport.context.browser.tabs={sendMessage:(_,message)=>f.send(message.action,message)};
  const bytes=await fexport.context.readCapturedBlob(1,state.generation,image.src);
  assert.deepEqual(bytes,data);
  assert.equal(f.fetched.length,1);
  assert.match((await f.send('blob-data',{url:image.src,generation:'stale'})).error,/Capture changed/);
  assert.match((await f.send('blob-data',{url:'blob:https://www.scan-manga.com/not-captured',generation:state.generation})).error,/not captured/);
  assert.match((await f.send('blob-data',{url:image.src,generation:state.generation,offset:-1})).error,/Invalid blob offset/);
});

test('provided Scan-Manga layout reports 10 unread pages, skips UI assets and follows declared page order', async () => {
  const f=scanMangaFixture(12);
  f.image('https://test/logo');
  f.page(2);f.page(1);
  const state=await f.send('start');
  assert.deepEqual(Array.from(state.entries,page=>page.url),['blob:https://www.scan-manga.com/page-1','blob:https://www.scan-manga.com/page-2']);
  assert.equal(state.missing,10);
  const third=f.page(3,12000);
  f.events.mutation();
  assert.equal((await f.send('images')).entries.length,2);
  third.top=0;f.events.scroll();
  assert.equal((await f.send('images')).entries.length,3);
  for(let page=4;page<=12;page++)f.page(page);
  const complete=await f.send('images');
  assert.equal(complete.entries.length,12);assert.equal(complete.missing,0);
});

test('Scan-Manga does not duplicate regenerated blobs for an already captured page; new capture clears bytes', async () => {
  const f=scanMangaFixture(1);
  const image=f.page(1);
  const first=await f.send('start');
  image.src=image.currentSrc='blob:https://www.scan-manga.com/replacement';
  assert.equal((await f.send('images')).entries.length,1);
  assert.equal(f.fetched.length,1);
  const next=await f.send('start');
  assert.notEqual(next.generation,first.generation);
  assert.equal(next.entries[0].url,image.src);
  assert.equal(f.fetched.length,2);
  assert.match((await f.send('blob-data',{url:first.entries[0].url,generation:next.generation})).error,/not captured/);
});

test('unreadable blobs fail explicitly and foreign-origin blobs are never fetched', async () => {
  const f=scanMangaFixture(2);
  const first=f.page(1);
  f.page(2,0,'blob:https://other.example/private');
  f.context.fetch=async()=>{throw new Error('Unavailable blob');};
  const state=await f.send('start');
  assert.equal(state.entries.length,1);
  assert.equal(state.missing,1);
  const response=await f.send('blob-data',{url:first.src,generation:state.generation});
  assert.match(response.error,/could not be read/);
  assert.equal(f.fetched.length,0);
});

test('generic HTTP readers also capture same-origin blobs without the Scan-Manga adapter', async () => {
  const f=captureFixture({fetch:async()=>({ok:true,arrayBuffer:async()=>Uint8Array.from([255,216,255]).buffer})});
  f.image('https://test/one');f.image('blob:https://test/two');
  const state=await f.send('start');
  assert.deepEqual(Array.from(state.entries,page=>page.url),['https://test/one','blob:https://test/two']);
  assert.equal(state.missing,0);
});

test('review creates local blob previews, keeps original bytes and blocks an incomplete Scan-Manga chapter', async () => {
  const captured=scanMangaFixture(12);
  captured.page(1);captured.page(2);
  await captured.send('start');
  const f=await reviewFixture({capture:captured});await f.idle();
  assert.equal(f.rows().length,2);
  assert.match(f.rows()[0].children[1].src,/^blob:review\//);
  assert.match(f.ids.get('status').textContent,/10 chapter\/viewed image\(s\) missing/);
  f.ids.get('export').onclick();await f.idle();
  assert.match(f.ids.get('status').textContent,/10 chapter\/viewed image\(s\) missing/);
  assert.equal(f.saved.length,0);
  assert.equal(f.permissions.length,0);
  const before=f.rows()[0].children[1].src;
  await f.ids.get('refresh').onclick();await f.idle();
  assert.equal(f.rows()[0].children[1].src,before); // Reuse the already hydrated bytes/preview.
});

test('captured blob bytes export exactly without refetching the page object URL', async () => {
  const captured=scanMangaFixture(1);
  const page=captured.page(1);const state=await captured.send('start');
  const f=groupingFixture();
  f.context.browser.tabs={sendMessage:(_,message)=>captured.send(message.action,message)};
  const bytes=await f.context.readCapturedBlob(1,state.generation,page.src);
  await f.context.exportArchive([{url:page.src,bytes}],'blob chapter',()=>{});
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.jpg']);
  assert.deepEqual(await zip.file('0001.jpg').async('uint8array'),captured.data);
  const missing=exporterFixture({});
  await assert.rejects(missing.context.exportArchive([page.src],'bad blob',()=>{}),/Captured blob bytes unavailable/);
  assert.equal(missing.saved.length,0);
});

test('blob transfer rejects truncated, stale and unsupported data rather than exporting partial bytes', async () => {
  const f=groupingFixture();
  for(const chunk of [
    {generation:'gen',offset:0,total:4,base64:btoa('abc')},
    {generation:'old',offset:0,total:3,base64:btoa('abc')},
    {generation:'gen',offset:0,total:3,base64:btoa('abc')},
  ]) {
    f.context.browser.tabs={sendMessage:async()=>chunk};
    await assert.rejects(f.context.readCapturedBlob(1,'gen','blob:https://test/local'));
  }
});

function pageBlobReaderFixture({ url = 'blob:https://test/image', revoked = false, loaded = true } = {}) {
  let listener;
  let executions = 0;
  const data = Uint8Array.from([255,216,255,42]);
  const page = vm.createContext({
    URL, Uint8Array, AbortSignal, btoa, location: { origin: 'https://test' },
    document: { images: loaded ? [{ src: url, complete: true, naturalWidth: 1400 }] : [] },
    fetch: async () => {
      if (revoked) throw new Error('NetworkError: revoked blob URL');
      return { ok: true, blob: async () => new Blob([data]) };
    },
  });
  const browser = {
    runtime: { id: 'extension', onMessage: { addListener(handler) { listener = handler; } } },
    scripting: { executeScript: async details => {
      executions++;
      assert.equal(details.world, 'MAIN');
      assert.equal(details.target.tabId, 1);
      page.sourceUrl = details.args[0];
      const result = await vm.runInContext('(' + details.func.toString() + ')(sourceUrl)', page);
      return [{ result }];
    } },
  };
  vm.runInNewContext(fs.readFileSync('dist/background.js', 'utf8'), { browser, URL });
  const sender = { id: 'extension', frameId: 0, tab: { id: 1 }, url: 'https://test/chapter' };
  return { data, executions: () => executions,
    send: (message, source = sender) => listener(message, source) };
}

test('isolated-context blob failure falls back to page-context bytes and creates a review preview', async () => {
  const bridge = pageBlobReaderFixture();
  const capture = captureFixture({ sendMessage: message => bridge.send(message) });
  const image = capture.image('blob:https://test/image');
  await capture.send('start');
  const f = await reviewFixture({ capture });
  await f.idle();
  assert.equal(bridge.executions(), 1);
  assert.match(f.rows()[0].children[1].src, /^blob:review\//);
  assert.equal(f.ids.get('status').textContent.includes('could not be read'), false);
  const state = await capture.send('status');
  const transfer = await capture.send('blob-data', { url: image.src, generation: state.generation });
  assert.deepEqual(Buffer.from(transfer.base64, 'base64'), Buffer.from(bridge.data));
  f.ids.get('title').value = 'Blob fallback chapter';
  let archive;
  f.context.URL.createObjectURL = blob => { archive = blob; return 'blob:export'; };
  f.context.browser.downloads.download = async () => { f.saved.push(archive); return 7; };
  f.ids.get('export').onclick(); await f.idle();
  assert.equal(f.saved.length, 1, f.ids.get('status').textContent);
  const zip = await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(await zip.file('0001.jpg').async('uint8array'), bridge.data);
});

test('page-context reader rejects unrelated senders, foreign blobs and images absent from the DOM', async () => {
  const bridge = pageBlobReaderFixture({ loaded: false });
  const request = { action: 'read-displayed-blob', url: 'blob:https://test/image' };
  for (const sender of [
    { id: 'other', frameId: 0, tab: { id: 1 }, url: 'https://test/chapter' },
    { id: 'extension', frameId: 2, tab: { id: 1 }, url: 'https://test/chapter' },
    { id: 'extension', frameId: 0, tab: { id: 1 }, url: 'https://other/chapter' },
  ]) assert.ok((await bridge.send(request, sender)).error);
  assert.equal(bridge.executions(), 0);
  assert.match((await bridge.send(request)).error, /no longer loaded/);
  assert.equal(bridge.executions(), 1);
});

test('revoked blobs report the page-context failure instead of implying export success', async () => {
  const bridge = pageBlobReaderFixture({ revoked: true });
  const result = await bridge.send({ action: 'read-displayed-blob', url: 'blob:https://test/image' });
  assert.match(result.error, /revoked blob URL/);
  assert.match(result.error, /Original bytes are unavailable/);
});

test('review retries failed blobs with the current replacement URL and then reuses successful bytes', async () => {
  let readable = false;
  const f = scanMangaFixture(1);
  const image = f.page(1);
  f.context.fetch = async () => {
    if (!readable) throw new Error('Temporary failure');
    return { ok: true, arrayBuffer: async () => f.data.buffer };
  };
  const state = await f.send('start');
  assert.ok((await f.send('blob-data', { url: image.src, generation: state.generation })).error);
  const originalUrl = image.src;
  image.src = image.currentSrc = 'blob:https://www.scan-manga.com/new-readable-image';
  readable = true;
  const result = await f.send('blob-data', { url: originalUrl, generation: state.generation });
  assert.deepEqual(Buffer.from(result.base64, 'base64'), Buffer.from(f.data));
  f.context.fetch = async () => { throw new Error('Must not refetch cached bytes'); };
  assert.equal((await f.send('blob-data', { url: originalUrl, generation: state.generation })).base64, result.base64);
});

test('load capture starts the blob fetch before the animation frame and target revocation', async () => {
  let revoked = false, calls = 0;
  const f = captureFixture({ fetch: async () => {
    calls++;
    if (revoked) throw new Error('revoked');
    return { ok: true, arrayBuffer: async () => Uint8Array.from([255,216,255]).buffer };
  } });
  f.context.requestAnimationFrame = () => { throw new Error('Must not wait for the next frame on load'); };
  const image = f.image('blob:https://test/loaded-later', false);
  const state = await f.send('start');
  assert.equal(calls, 0);
  image.complete = true; image.naturalWidth = 800; image.naturalHeight = 1200;
  f.events.load();
  revoked = true;
  assert.equal(calls, 1);
  const result = await f.send('blob-data', { generation: state.generation, url: image.src });
  assert.equal(result.base64, '/9j/');
});

function displayedPixelsFixture({ tainted = false, original = false } = {}) {
  const data = Uint8Array.from([137,80,78,71,13,10,26,10,42]);
  let draws = 0;
  const f = scanMangaFixture(1);
  const image = f.page(1);
  if (!original) f.context.fetch = async () => { throw new Error('revoked blob URL'); };
  const canvas = { width: 0, height: 0,
    getContext: () => ({ drawImage(node, x, y) {
      assert.equal(node, image); assert.equal(x, 0); assert.equal(y, 0); draws++;
      if (tainted) throw new Error('SecurityError: canvas is not origin-clean');
    } }),
    toBlob(callback, type) { assert.equal(type, 'image/png'); callback(new Blob([data])); },
  };
  f.context.document.createElement = name => { assert.equal(name, 'canvas'); return canvas; };
  return { ...f, image, data, canvas, draws: () => draws };
}

test('explicit PNG fallback for revoked blobs creates a preview and exports the re-encoded bytes', async () => {
  const capture = displayedPixelsFixture();
  await capture.send('start');
  const f = await reviewFixture({ capture }); await f.idle();
  assert.equal(capture.draws(), 0); // No implicit image conversion on capture/review.
  const button = f.rows()[0].children[2].children.find(child => child.textContent === 'Use displayed pixels (PNG)');
  assert.ok(button);
  button.onclick(); await f.idle();
  assert.equal(capture.draws(), 1);
  assert.match(f.rows()[0].children[1].src, /^blob:review\//);
  assert.match(f.ids.get('status').textContent, /re-encoded/);
  const state = await capture.send('status');
  assert.equal(state.entries[0].reencoded, true);
  const chunk = await capture.send('blob-data', { generation: state.generation, url: capture.image.src });
  assert.deepEqual(Buffer.from(chunk.base64, 'base64'), Buffer.from(capture.data));
  assert.equal(capture.canvas.width, 0); assert.equal(capture.canvas.height, 0);
  let archive;
  f.context.URL.createObjectURL = blob => { archive = blob; return 'blob:export'; };
  f.context.browser.downloads.download = async () => { f.saved.push(archive); return 7; };
  f.ids.get('title').value = 'Pixel fallback';
  f.ids.get('export').onclick(); await f.idle();
  assert.equal(f.saved.length, 1, f.ids.get('status').textContent);
  const zip = await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files), ['0001.png']);
  assert.deepEqual(await zip.file('0001.png').async('uint8array'), capture.data);
  f.ids.get('refresh').onclick(); await f.idle();
  assert.match(f.rows()[0].children[2].children.find(child => child.className === 'grouping-note').textContent, /re-encoded/);
});

test('PNG fallback never replaces available original bytes, ignores stale requests and enforces Canvas security', async () => {
  const original = displayedPixelsFixture({ original: true });
  const first = await original.send('start');
  const result = await original.send('capture-displayed-pixels', { generation: first.generation, url: original.image.src });
  assert.equal(result.reencoded, false); assert.equal(original.draws(), 0);
  const denied = displayedPixelsFixture({ tainted: true });
  const state = await denied.send('start');
  assert.match((await denied.send('capture-displayed-pixels', { generation: 'stale', url: denied.image.src })).error, /Capture changed/);
  const failure = await denied.send('capture-displayed-pixels', { generation: state.generation, url: denied.image.src });
  assert.match(failure.error, /SecurityError/);
  assert.equal((await denied.send('status')).entries[0].reencoded, undefined);
  assert.equal(denied.canvas.width, 0);
  denied.image.isConnected = false;
  assert.match((await denied.send('capture-displayed-pixels', { generation: state.generation, url: denied.image.src })).error, /no longer loaded/);
});

test('Firefox cross-context PNG bytes transfer without reading the typed-array constructor', async () => {
  const f = displayedPixelsFixture();
  f.context.Uint8Array = function WrappedBytes(value) {
    const bytes = new Uint8Array(value);
    Object.defineProperty(bytes, 'constructor', { get() {
      throw new Error('Permission denied to access property "constructor"');
    } });
    return bytes;
  };
  const state = await f.send('start');
  const converted = await f.send('capture-displayed-pixels', { generation: state.generation, url: f.image.src });
  assert.equal(converted.reencoded, true);
  const result = await f.send('blob-data', { generation: state.generation, url: f.image.src });
  assert.deepEqual(Buffer.from(result.base64, 'base64'), Buffer.from(f.data));
});

function archiveFixture() {
  const { IDBFactory } = require('fake-indexeddb');
  let listener, startup;
  const browser = { runtime: { id: 'extension', getURL: path => 'moz-extension://fixture/' + path,
    onMessage: { addListener(fn) { listener = fn; } },
    onStartup: { addListener(fn) { startup = fn; } },
  } };
  vm.runInNewContext(fs.readFileSync('dist/imageInfo.js', 'utf8') + '\n' + fs.readFileSync('dist/captureStore.js', 'utf8'), {
    browser, indexedDB: new IDBFactory(), Uint8Array, atob, btoa,
  });
  const source = { id: 'extension', frameId: 0, tab: { id: 1 }, url: 'https://test/chapter' };
  const review = { id: 'extension', url: 'moz-extension://fixture/review.html', tab: { id: 2 } };
  return {
    source: message => listener(structuredClone(message), source),
    review: message => listener({ tabId: 1, ...structuredClone(message) }, review),
    startup: () => startup(),
  };
}

async function waitForArchive(archive, generation, url) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const result = await archive.review({ action: 'archive-request', command: 'blob-data', generation, url });
    if (result && !result.error) return result;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('Image bytes were not saved');
}

test('automatic PNG fallback is opt-in at Start, stores marked bytes and survives source document destruction', async () => {
  const archive = archiveFixture();
  const captured = displayedPixelsFixture();
  captured.context.location.href = 'https://www.scan-manga.com/chapter-one';
  captured.context.browser.runtime.sendMessage = message => message.action.startsWith('archive-')
    ? archive.source(message) : Promise.resolve({ error: 'Original blob revoked' });
  const state = await captured.send('start', { autoPixels: true });
  const chunk = await waitForArchive(archive, state.generation, captured.image.src);
  assert.equal(captured.draws(), 1);
  assert.deepEqual(Buffer.from(chunk.base64, 'base64'), Buffer.from(captured.data));
  const stored = await archive.review({ action: 'archive-request', command: 'status' });
  assert.equal(stored.entries[0].reencoded, true);
  assert.equal(stored.archived, true);
  const unavailableSource = { send: async () => { throw new Error('document destroyed'); } };
  const f = await reviewFixture({ capture: unavailableSource, archive: message => archive.review(message) });
  await f.idle();
  assert.equal(f.rows().length, 1);
  assert.match(f.rows()[0].children[1].src, /^blob:review\//);
  assert.match(f.ids.get('status').textContent, /Saved capture/);
  let output;
  f.context.URL.createObjectURL = blob => { output = blob; return 'blob:export'; };
  f.context.browser.downloads.download = async () => { f.saved.push(output); return 7; };
  f.ids.get('title').value = 'Saved after navigation';
  f.ids.get('export').onclick(); await f.idle();
  assert.equal(f.saved.length, 1, f.ids.get('status').textContent);
  const zip = await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(await zip.file('0001.png').async('uint8array'), captured.data);
});

test('archived chunks enforce generations, preserve exclusions, and new capture deletes previous payloads', async () => {
  const archive = archiveFixture();
  const state = { generation: 'first', entries: [{ url: 'blob:https://test/a', selected: true, order: 0, width: 1, height: 1 }], missing: 0, title: 'A', capturing: false };
  await archive.source({ action: 'archive-reset', state });
  await archive.source({ action: 'archive-bytes', generation: 'first', url: state.entries[0].url, offset: 0, total: 3, base64: '/9j/' });
  assert.match((await archive.review({ action: 'archive-request', command: 'blob-data', generation: 'old', url: state.entries[0].url })).error, /Capture changed/);
  const changed = await archive.review({ action: 'archive-request', command: 'select', url: state.entries[0].url, selected: false });
  assert.equal(changed.entries[0].selected, false);
  await archive.source({ action: 'archive-reset', state: { ...state, generation: 'second' } });
  assert.match((await archive.review({ action: 'archive-request', command: 'blob-data', generation: 'second', url: state.entries[0].url })).error, /not saved/);
});

test('Continue retains the capture generation and appends a new document without mixing page order', async () => {
  const first = scanMangaFixture(1);
  first.context.location.href = 'https://www.scan-manga.com/chapter-one';
  first.page(1);
  const previous = await first.send('start');
  const next = scanMangaFixture(1);
  next.context.location.href = 'https://www.scan-manga.com/chapter-two';
  next.page(1, 0, 'blob:https://www.scan-manga.com/second-chapter');
  const resumed = await next.send('resume', { state: previous });
  assert.equal(resumed.generation, previous.generation);
  assert.deepEqual(Array.from(resumed.entries, page => page.url), [previous.entries[0].url, 'blob:https://www.scan-manga.com/second-chapter']);
  assert.equal(resumed.missing, 0);
});

test('automatic safety copy is discarded when original JPEG bytes are available', async () => {
  const archive = archiveFixture();
  const capture = displayedPixelsFixture({ original: true });
  capture.context.browser.runtime.sendMessage = message => archive.source(message);
  const state = await capture.send('start', { autoPixels: true });
  const chunk = await waitForArchive(archive, state.generation, capture.image.src);
  assert.equal(capture.draws(), 1); // A provisional copy is made immediately but never published over the original.
  assert.deepEqual(Buffer.from(chunk.base64, 'base64'), Buffer.from([255,216,255,42]));
  const stored = await archive.review({ action: 'archive-request', command: 'status' });
  assert.equal(stored.entries[0].reencoded, undefined);
});

test('saved images spanning multiple chunks remain byte-exact after navigation and new-capture generations reject stale checkpoints', async () => {
  const archive = archiveFixture();
  const bytes = new Uint8Array(600000).fill(31); bytes.set([255,216,255]);
  const capture = scanMangaFixture(1, bytes);
  capture.context.browser.runtime.sendMessage = message => archive.source(message);
  const image = capture.page(1);
  const state = await capture.send('start');
  await waitForArchive(archive, state.generation, image.src);
  const f = groupingFixture();
  f.context.browser.tabs = { sendMessage: async () => { throw new Error('document navigated'); } };
  f.context.browser.runtime = { sendMessage: message => archive.review(message) };
  let recovered;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { recovered = await f.context.readCapturedBlob(1, state.generation, image.src); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 2)); }
  }
  assert.deepEqual(recovered, bytes);
  await archive.source({ action: 'archive-reset', state: { ...state, generation: 'replacement', entries: [] } });
  assert.match((await archive.source({ action: 'archive-state', state })).error, /Capture changed/);
});

test('Continue on the same Scan-Manga chapter preserves prior page slots and counts remaining pages', async () => {
  const first = scanMangaFixture(3);
  first.context.location.href = 'https://www.scan-manga.com/same-chapter';
  first.page(1);
  const state = await first.send('start');
  const next = scanMangaFixture(3);
  next.context.location.href = first.context.location.href;
  next.page(1, 0, 'blob:https://www.scan-manga.com/reloaded-one');
  next.page(2, 0, 'blob:https://www.scan-manga.com/two');
  const resumed = await next.send('resume', { state });
  assert.equal(resumed.entries.length, 2);
  assert.equal(resumed.entries[0].url, state.entries[0].url);
  assert.equal(resumed.missing, 1);
});

test('automatic PNG safety copy freezes pixels before asynchronous original reads and reader arrow replacement', async () => {
  const capture = displayedPixelsFixture();
  let failOriginal;
  capture.context.fetch = () => new Promise((_, reject) => { failOriginal = reject; });
  const state = await capture.send('start', { autoPixels: true });
  assert.equal(capture.draws(), 1, 'Pixels must be copied synchronously at detection, before awaiting fetch');
  const originalUrl = capture.image.src;
  capture.image.src = capture.image.currentSrc = 'blob:https://www.scan-manga.com/next-image';
  failOriginal(new Error('URL revoked while awaiting original bytes'));
  const result = await capture.send('blob-data', { generation: state.generation, url: originalUrl });
  assert.deepEqual(Buffer.from(result.base64, 'base64'), Buffer.from(capture.data));
});

test('Continue retrieves previously re-encoded PNG bytes from the archive, not the emptied document cache', async () => {
  const archive = archiveFixture();
  const capture = displayedPixelsFixture();
  capture.context.location.href = 'https://www.scan-manga.com/chapter';
  capture.context.browser.runtime.sendMessage = message => message.action.startsWith('archive-')
    ? archive.source(message) : Promise.resolve({ error: 'revoked' });
  const state = await capture.send('start', { autoPixels: true });
  await waitForArchive(archive, state.generation, capture.image.src);
  const previous = await capture.send('status');
  assert.equal(previous.entries[0].reencoded, true);
  const resumed = await capture.send('resume', { state: previous, autoPixels: true });
  assert.equal(resumed.generation, previous.generation);
  const chunk = await capture.send('blob-data', { generation: resumed.generation, url: previous.entries[0].url });
  assert.equal(chunk.error, undefined);
  assert.deepEqual(Buffer.from(chunk.base64, 'base64'), Buffer.from(capture.data));
});

test('ready PNG is committed without waiting for a blocked original; unload warns only until saving completes', async () => {
  const archive = archiveFixture();
  const capture = displayedPixelsFixture();
  capture.context.fetch = () => new Promise(() => {}); // Original never returns.
  capture.context.browser.runtime.sendMessage = message => archive.source(message);
  const state = await capture.send('start', { autoPixels: true });
  let prevented = 0;
  const event = { preventDefault() { prevented++; }, returnValue: 'unchanged' };
  capture.events['window:beforeunload'](event);
  assert.equal(prevented, 1);
  const chunk = await waitForArchive(archive, state.generation, capture.image.src);
  assert.deepEqual(Buffer.from(chunk.base64, 'base64'), Buffer.from(capture.data));
  const stopped = await capture.send('stop');
  assert.equal(stopped.pendingSaves, 0);
  assert.equal(stopped.savedCount, 1);
  assert.equal(stopped.entries[0].saveState, 'saved');
  capture.events['window:beforeunload'](event);
  assert.equal(prevented, 1);
});

test('failed image writes are reported and never labelled Saved locally', async () => {
  const archive = archiveFixture();
  const capture = displayedPixelsFixture();
  capture.context.browser.runtime.sendMessage = message => message.action === 'archive-bytes'
    ? Promise.resolve({ error: 'QuotaExceededError: simulated storage failure' })
    : message.action.startsWith('archive-') ? archive.source(message) : Promise.resolve({ error: 'revoked' });
  await capture.send('start', { autoPixels: true });
  const stopped = await capture.send('stop');
  assert.equal(stopped.entries[0].reencoded, true); // Encoding is distinct from durable saving.
  assert.equal(stopped.entries[0].saveState, 'error');
  assert.match(stopped.entries[0].saveError, /QuotaExceededError/);
  assert.equal(stopped.savedCount, 0);
  const stored = await archive.review({ action: 'archive-request', command: 'status' });
  assert.equal(stored.savedCount, 0);
  const data = await archive.review({ action: 'archive-request', command: 'blob-data', generation: stopped.generation, url: capture.image.src });
  assert.match(data.error, /QuotaExceededError/);
});

test('revisiting a remembered Scan-Manga page repairs missing saved PNG data without duplicating its row', async () => {
  const archive = archiveFixture();
  const capture = displayedPixelsFixture();
  capture.context.location.href = 'https://www.scan-manga.com/chapter';
  const oldUrl = 'blob:https://www.scan-manga.com/lost-original-url';
  const state = { generation: 'repair', entries: [{ url: oldUrl, order: 0, width: 1400, height: 1982,
    selected: true, reencoded: true, saveState: 'pending', readerPage: 1, sourceUrl: capture.context.location.href }],
    title: 'Chapter', missing: 0, capturing: false };
  await archive.source({ action: 'archive-reset', state });
  capture.context.browser.runtime.sendMessage = message => message.action.startsWith('archive-')
    ? archive.source(message) : Promise.resolve({ error: 'revoked' });
  await capture.send('resume', { state, autoPixels: true });
  const data = await waitForArchive(archive, state.generation, oldUrl);
  assert.deepEqual(Buffer.from(data.base64, 'base64'), Buffer.from(capture.data));
  const stopped = await capture.send('stop');
  assert.equal(stopped.entries.length, 1);
  assert.equal(stopped.entries[0].url, oldUrl);
  assert.equal(stopped.entries[0].saveState, 'saved');
});

test('archive completion requires every chunk and survives stale pending metadata', async () => {
  const archive = archiveFixture();
  const url = 'blob:https://test/chunked';
  const state = { generation: 'chunks', entries: [{ url, selected: true, order: 0, width: 1, height: 1,
    reencoded: true, saveState: 'pending' }], title: 'Chapter', missing: 0, capturing: true };
  const total = 300000;
  await archive.source({ action: 'archive-reset', state });
  await archive.source({ action: 'archive-bytes', generation: 'chunks', url, total, offset: 0,
    base64: Buffer.alloc(256 * 1024).toString('base64') });
  assert.match((await archive.source({ action: 'archive-commit', generation: 'chunks', url, total })).error, /incomplete/);
  assert.equal((await archive.review({ action: 'archive-request', command: 'status' })).savedCount, 0);
  await archive.source({ action: 'archive-bytes', generation: 'chunks', url, total, offset: 256 * 1024,
    base64: Buffer.alloc(total - 256 * 1024).toString('base64') });
  assert.equal((await archive.source({ action: 'archive-commit', generation: 'chunks', url, total })).ok, true);
  await archive.source({ action: 'archive-state', state: { ...state, entries: [{ ...state.entries[0], reencoded: false }] } });
  const stored = await archive.review({ action: 'archive-request', command: 'status' });
  assert.equal(stored.entries[0].saveState, 'saved');
  assert.equal(stored.entries[0].reencoded, true);
});

test('popup displays captured blob bytes as real local previews, reuses them on refresh and releases URLs on close', async () => {
  const captured = scanMangaFixture(1);
  captured.page(1); await captured.send('start');
  const f = await reviewFixture({ popup: true, capture: captured }); await f.idle();
  assert.equal(f.rows().length, 1);
  const preview = f.rows()[0].children[1];
  assert.match(preview.src, /^blob:review\//);
  assert.equal(preview.alt, 'Page preview');
  assert.deepEqual(new Uint8Array(await f.previewBlobs[0].arrayBuffer()), captured.data);
  assert.equal(f.ids.get('export').disabled, false);
  const checkbox = f.rows()[0].children[0]; checkbox.checked = false; checkbox.onchange();
  await f.ids.get('refresh').onclick(); await f.idle();
  assert.equal(f.rows()[0].children[0].checked, false);
  assert.equal(f.rows()[0].children[1].src, preview.src);
  assert.equal(f.previewBlobs.length, 1);
  f.uiEvents.unload();
  assert.ok(f.revoked.includes(preview.src));
});

test('popup shows an explicit per-image error when local image data cannot be read', async () => {
  const captured = scanMangaFixture(1);
  captured.page(1); captured.context.fetch = async () => { throw new Error('Image no longer readable'); };
  await captured.send('start');
  const f = await reviewFixture({ popup: true, capture: captured }); await f.idle();
  assert.equal(f.rows()[0].children[1].src, undefined);
  assert.equal(f.rows()[0].children[1].alt, 'Preview unavailable');
  const note = f.rows()[0].children[2].children.find(child => child.className === 'grouping-note');
  assert.match(note.textContent, /could not be read/);
  assert.equal(f.previewBlobs.length, 0);
});

test('popup restores an archived PNG preview after the source document has navigated', async () => {
  const archive = archiveFixture();
  const captured = displayedPixelsFixture();
  captured.context.browser.runtime.sendMessage = message => message.action.startsWith('archive-')
    ? archive.source(message) : Promise.resolve({ error: 'revoked original' });
  const state = await captured.send('start', { autoPixels: true });
  await waitForArchive(archive, state.generation, captured.image.src);
  const f = await reviewFixture({ popup: true, capture: { send: async () => { throw new Error('navigated'); } },
    archive: message => archive.review(message) }); await f.idle();
  assert.match(f.rows()[0].children[1].src, /^blob:review\//);
  assert.deepEqual(new Uint8Array(await f.previewBlobs[0].arrayBuffer()), captured.data);
  assert.match(f.ids.get('status').textContent, /Saved locally: 1/);
});

async function cachedPopupFixture() {
  const archive = archiveFixture();
  const captured = scanMangaFixture(1);
  captured.context.browser.runtime.sendMessage = message => archive.source(message);
  const image = captured.page(1);
  const state = await captured.send('start');
  await waitForArchive(archive, state.generation, image.src);
  let fullReads = 0;
  const source = { send(action, message) { if (action === 'blob-data') fullReads++; return captured.send(action, message); } };
  const options = { popup: true, thumbnailCanvas: true, capture: source, archive: message => archive.review(message) };
  const first = await reviewFixture(options); await first.idle();
  return { archive, captured, image, state, source, first, options, fullReads: () => fullReads };
}

test('popup reopen reuses persisted thumbnails with zero full-image transfers or thumbnail recalculations', async () => {
  const f = await cachedPopupFixture();
  assert.ok(f.fullReads() > 0);
  assert.match(f.first.rows()[0].children[1].src, /^data:image\/png;base64,/);
  assert.equal(f.first.thumbnailSizes.length, 1);
  assert.ok(f.first.thumbnailSizes[0][0] <= 140 && f.first.thumbnailSizes[0][1] <= 180);
  const reads = f.fullReads();
  f.first.uiEvents.unload();
  const reopened = await reviewFixture(f.options); await reopened.idle();
  assert.equal(f.fullReads(), reads);
  assert.equal(reopened.thumbnailSizes.length, 0);
  assert.equal(reopened.previewBlobs.length, 0);
  assert.equal(reopened.rows()[0].children[1].src, f.first.rows()[0].children[1].src);
  assert.equal(reopened.ids.get('status').textContent.includes('bytes are unavailable'), false);
  assert.equal(reopened.ids.get('export').disabled, false);
});

test('Start clears derived thumbnails and rejects reads or writes from the prior capture generation', async () => {
  const f = await cachedPopupFixture();
  const old = await f.archive.review({ action: 'archive-preview-get', generation: f.state.generation, urls: [f.image.src] });
  assert.equal(old.previews.length, 1);
  const next = await f.captured.send('start');
  await waitForArchive(f.archive, next.generation, f.image.src);
  const empty = await f.archive.review({ action: 'archive-preview-get', generation: next.generation, urls: [f.image.src] });
  assert.equal(empty.previews.length, 0);
  const stale = await f.archive.review({ action: 'archive-preview-put', generation: f.state.generation,
    url: f.image.src, previewVersion: old.previewVersion, dataUrl: old.previews[0].dataUrl });
  assert.match(stale.error, /Capture changed/);
});

test('cancelled export retains thumbnails; successful export clears only thumbnails and prevents stale repopulation', async () => {
  const f = await cachedPopupFixture();
  const before = await f.archive.review({ action: 'archive-preview-get', generation: f.state.generation, urls: [f.image.src] });
  const review = await reviewFixture({ capture: f.source, archive: message => f.archive.review(message) }); await review.idle();
  review.context.browser.downloads.download = async () => { throw new Error('Save cancelled'); };
  review.ids.get('export').onclick(); await review.idle();
  assert.match(review.ids.get('status').textContent, /cancelled/);
  assert.equal((await f.archive.review({ action: 'archive-preview-get', generation: f.state.generation, urls: [f.image.src] })).previews.length, 1);
  let output;
  review.context.URL.createObjectURL = blob => { output = blob; return 'blob:export'; };
  review.context.browser.downloads.download = async () => { review.saved.push(output); return 7; };
  review.ids.get('export').onclick(); await review.idle();
  assert.equal(review.saved.length, 1);
  const after = await f.archive.review({ action: 'archive-preview-get', generation: f.state.generation, urls: [f.image.src] });
  assert.equal(after.previews.length, 0);
  assert.ok(after.previewVersion > before.previewVersion);
  assert.match((await f.archive.review({ action: 'archive-preview-put', generation: f.state.generation,
    url: f.image.src, previewVersion: before.previewVersion, dataUrl: before.previews[0].dataUrl })).error, /cleared/);
  const bytes = await f.archive.review({ action: 'archive-request', command: 'blob-data', generation: f.state.generation, url: f.image.src });
  assert.deepEqual(Buffer.from(bytes.base64, 'base64'), Buffer.from(f.captured.data));
  const zip = await JSZip.loadAsync(await review.saved[0].arrayBuffer());
  assert.deepEqual(await zip.file('0001.jpg').async('uint8array'), f.captured.data);
});

test('thumbnail cache rejects non-PNG data without affecting saved capture bytes', async () => {
  const f = await cachedPopupFixture();
  const result = await f.archive.review({ action: 'archive-preview-put', generation: f.state.generation,
    url: f.image.src, previewVersion: 0, dataUrl: 'data:text/html;base64,PHNjcmlwdD4=' });
  assert.match(result.error, /Invalid thumbnail/);
  const capture = await f.archive.review({ action: 'archive-request', command: 'status' });
  assert.equal(capture.savedCount, 1);
});

function navigationFixture() {
  const { IDBFactory } = require('fake-indexeddb');
  const listeners = [];
  let updated, current, pending, currentUrl = '', granted = true, injections = 0;
  const dispatch = (message, sender) => {
    for (const listener of listeners) { const result = listener(structuredClone(message), sender); if (result !== undefined) return result; }
    return Promise.resolve({ error: 'No handler in fixture' });
  };
  const browser = {
    runtime: { id: 'extension', getURL: path => 'moz-extension://fixture/' + path,
      onMessage: { addListener(fn) { listeners.push(fn); } }, onStartup: { addListener() {} } },
    tabs: { onUpdated: { addListener(fn) { updated = fn; } },
      get: async id => ({ id, url: currentUrl }),
      sendMessage: async (_, message) => { if (!current) throw new Error('Old document was unloaded'); return current.send(message.action, message); } },
    permissions: { contains: async ({ origins }) => granted && origins[0] === 'https://www.scan-manga.com/*' },
    scripting: { executeScript: async details => {
      assert.deepEqual(Array.from(details.files), ['imageInfo.js','navigationScope.js','content.js']); injections++; current = pending; return [];
    } },
  };
  const context = vm.createContext({ browser, indexedDB: new IDBFactory(), Uint8Array, atob, btoa, URL,
    crypto: require('node:crypto').webcrypto });
  for (const file of ['imageInfo.js','captureStore.js','navigationScope.js','navigation.js']) vm.runInContext(fs.readFileSync('dist/'+file,'utf8'), context);
  const uiSender = { id: 'extension', url: 'moz-extension://fixture/popup.html', tab: { id: 9 } };
  function reader(url, page, count = 2) {
    const f = scanMangaFixture(count);
    f.context.location.href = url;
    f.page(page, 0, 'blob:https://www.scan-manga.com/image-'+page+'-'+url.split('?').at(-1));
    f.context.browser.runtime.sendMessage = message => dispatch(message, { id: 'extension', frameId: 0,
      tab: { id: 1 }, url: f.context.location.href });
    return f;
  }
  return { context, reader, injections: () => injections, grant: value => { granted = value; },
    attach(source) { current = source; pending = source; currentUrl = source.context.location.href; },
    ui: message => dispatch({ tabId: 1, ...message }, uiSender),
    review: message => dispatch({ tabId: 1, ...message }, uiSender),
    async navigate(url, source) { currentUrl = url; current = undefined; pending = source; updated(1, { status: 'complete' }); await context.resumeAfterNavigation(1); },
    async completed() { updated(1, { status: 'complete' }); await context.resumeAfterNavigation(1); },
  };
}

const navigationChapter = 'https://www.scan-manga.com/lecture-en-ligne/Example-Chapitre-1-FR_100.html';

async function enabledNavigationFixture(includeNextChapters = false) {
  const f = navigationFixture();
  const first = f.reader(navigationChapter+'?page=1', 1);
  f.attach(first);
  const state = await first.send('start');
  await waitForArchive(f, state.generation, state.entries[0].url);
  assert.equal((await f.ui({ action: 'navigation-control', enabled: true, generation: state.generation, autoPixels: true, includeNextChapters })).ok, true);
  return { ...f, first, generation: state.generation };
}

test('automatic continuation reinjects after a same-chapter navigation without popup interaction and retains all captured pages', async () => {
  const f = await enabledNavigationFixture();
  const next = f.reader(navigationChapter+'?page=2', 2);
  await f.navigate(next.context.location.href, next);
  const state = await next.send('status');
  assert.equal(state.capturing, true);
  assert.equal(state.generation, f.generation);
  assert.equal(state.entries.length, 2);
  assert.equal(state.missing, 0);
  assert.equal(f.injections(), 1);
  await waitForArchive(f, f.generation, state.entries[1].url);
  const previous = await next.send('blob-data', { generation: f.generation, url: state.entries[0].url });
  assert.equal(previous.error, undefined);
  await f.completed();
  assert.equal(f.injections(), 1); // Repeated events do not clear/restart a live capture.
  assert.equal((await next.send('status')).entries.length, 2);
});

test('Stop disables automatic continuation durably, including stopping an archived capture', async () => {
  const f = await enabledNavigationFixture();
  await f.first.send('stop');
  assert.equal((await f.ui({ action: 'navigation-status' })).autoResume.enabled, false);
  const next = f.reader(navigationChapter+'?page=2', 2);
  await f.navigate(next.context.location.href, next);
  assert.equal(f.injections(), 0);
  const second = await enabledNavigationFixture();
  await second.ui({ action: 'archive-request', command: 'stop' });
  await second.navigate(navigationChapter+'?page=2', second.reader(navigationChapter+'?page=2',2));
  assert.equal(second.injections(), 0);
});

test('automatic continuation waits for human verification/reader readiness and then resumes without solving or navigating anything', async () => {
  const f = await enabledNavigationFixture();
  const next = f.reader(navigationChapter+'?page=2', 2);
  next.document.challenge = {};
  await f.navigate(next.context.location.href, next);
  assert.equal((await next.send('status')).capturing, false);
  assert.equal((await f.ui({ action: 'archive-request', command: 'status' })).entries.length, 1);
  assert.match((await f.ui({ action: 'navigation-status' })).autoResume.pauseReason, /manual verification/);
  next.document.challenge = null;
  next.events.mutation();
  await waitForArchive(f, f.generation, next.document.images[0].src);
  assert.equal((await next.send('status')).capturing, true);
  assert.equal((await next.send('status')).entries.length, 2);
});

test('automatic continuation does not collect another chapter/site, and permission revocation is reported', async () => {
  const f = await enabledNavigationFixture();
  const other = navigationChapter.replace('_100.html','_200.html');
  await f.navigate(other, f.reader(other, 1));
  assert.equal(f.injections(), 0);
  assert.match((await f.ui({ action: 'navigation-status' })).autoResume.pauseReason, /Outside/);
  const blocked = await enabledNavigationFixture();
  blocked.grant(false);
  await blocked.navigate(navigationChapter+'?page=2', blocked.reader(navigationChapter+'?page=2', 2));
  assert.equal(blocked.injections(), 0);
  assert.match((await blocked.ui({ action: 'navigation-status' })).autoResume.pauseReason, /no longer granted/);
});

test('same-document chapter changes stop observation before collecting the next chapter', async () => {
  const f = await enabledNavigationFixture();
  f.first.context.location.href = navigationChapter.replace('_100.html','_200.html');
  f.first.page(2,0,'blob:https://www.scan-manga.com/unrelated');
  const state = await f.first.send('images');
  assert.equal(state.capturing, false);
  assert.equal(state.entries.length, 1);
  assert.match(state.captureNotice, /chapter boundary/);
});

test('automatic next chapters retain distinct page-one slots, chapter order and missing counts', async () => {
  const f = await enabledNavigationFixture(true);
  const second = f.first.page(2,0,'blob:https://www.scan-manga.com/first-chapter-second-page');
  await f.first.send('images'); await waitForArchive(f,f.generation,second.src);
  const nextUrl = navigationChapter.replace('_100.html','_200.html');
  const next = f.reader(nextUrl,1);
  next.page(2,0,'blob:https://www.scan-manga.com/second-chapter-second-page');
  await f.navigate(nextUrl,next);
  const state = await next.send('status');
  assert.equal(state.capturing,true);
  assert.equal(state.generation,f.generation);
  assert.equal(state.entries.length,4);
  assert.equal(state.entries[0].readerPage,1);
  assert.equal(state.entries[2].readerPage,1);
  assert.equal(state.entries[0].sourceUrl.includes('_100.html'),true);
  assert.equal(state.entries[2].sourceUrl.includes('_200.html'),true);
  assert.deepEqual(Array.from(state.entries,page=>page.order),[0,1,2,3]);
  assert.equal(state.missing,0);
});

test('same-document next-chapter transition ignores leftover old nodes and captures the new chapter',async()=>{
  const f=await enabledNavigationFixture(true);
  f.first.page(2,0,'blob:https://www.scan-manga.com/first-two');
  await f.first.send('images');
  f.first.context.location.href=navigationChapter.replace('_100.html','_200.html');
  f.first.document.reader.dataset.nbpage='1';
  const interim=await f.first.send('images');
  assert.equal(interim.capturing,true);assert.equal(interim.entries.length,2);assert.equal(interim.missing,1);
  f.first.page(1,0,'blob:https://www.scan-manga.com/new-chapter-first-page');
  const complete=await f.first.send('images');
  assert.equal(complete.entries.length,3);assert.equal(complete.missing,0);
  assert.equal(complete.entries[2].url,'blob:https://www.scan-manga.com/new-chapter-first-page');
});

test('popup Start requests only this site and enables next-chapter continuation; Stop and the checkbox control it',async()=>{
  const nav=navigationFixture();const source=nav.reader(navigationChapter,1);nav.attach(source);
  const f=await reviewFixture({popup:true,automaticNavigation:true,capture:source,archive:message=>nav.ui(message),thumbnailCanvas:true});
  await f.idle();
  await f.ids.get('start').onclick();await f.idle();
  assert.deepEqual(Array.from(f.permissions[0].origins),['https://www.scan-manga.com/*']);
  const policy=(await nav.ui({action:'navigation-status'})).autoResume;
  assert.equal(policy.enabled,true);assert.equal(policy.includeNextChapters,true);
  const generation=(await source.send('status')).generation;
  await f.ids.get('stop').onclick();await f.idle();
  assert.equal(f.ids.get('auto-continue').checked,false);
  const checkbox=f.ids.get('auto-continue');checkbox.checked=true;
  await checkbox.onchange();await f.idle();
  assert.equal((await source.send('status')).generation,generation);
  assert.equal((await source.send('status')).capturing,true);
});

test('denying site access starts current-document capture but leaves automatic continuation off',async()=>{
  const nav=navigationFixture();const source=nav.reader(navigationChapter,1);nav.attach(source);nav.grant(false);
  const f=await reviewFixture({popup:true,automaticNavigation:true,permission:false,capture:source,archive:message=>nav.ui(message)});
  await f.idle();await f.ids.get('start').onclick();await f.idle();
  assert.equal((await source.send('status')).capturing,true);
  assert.equal((await nav.ui({action:'navigation-status'})).autoResume,undefined);
  assert.equal(f.ids.get('auto-continue').checked,false);
  assert.match(f.ids.get('status').textContent,/site access was not granted/);
});

test('file statistics use actual selected file bytes, report partial coverage and ignore exclusions', () => {
  const f=exporterFixture({});
  const summary=f.context.imageFileSummary([
    {selected:true,fileType:'jpg',byteLength:1024},
    {selected:true,fileType:'png',byteLength:3072},
    {selected:true,url:'https://test/not-a-reliable-extension.jpg'},
    {selected:false,fileType:'png',byteLength:100000000},
  ]);
  assert.match(summary,/JPEG × 1, PNG × 1/);
  assert.match(summary,/Average file size: 2.0 KiB/);
  assert.match(summary,/Measured: 2\/3/);
  assert.equal(f.context.imageFileInfo({bytes:Uint8Array.from([255,216,255,0]),fileType:'png',byteLength:999}).fileType,'jpg');
});

test('popup statistics read source metadata from the cache without loading originals or counting thumbnail PNG bytes',async()=>{
  const f=await cachedPopupFixture();
  const reads=f.fullReads();
  const popup=await reviewFixture({...f.options,imageOptions:true});await popup.idle();
  popup.ids.get('show-image-info').checked=true;popup.ids.get('show-image-info').onchange();
  assert.equal(popup.ids.get('image-info').hidden,false);
  assert.match(popup.ids.get('image-info').textContent,/JPEG × 1/);
  assert.match(popup.ids.get('image-info').textContent,/Average file size: 4 B/);
  assert.equal(f.fullReads(),reads);
});

test('JPEG 97 / 4:4:4 export keeps dimensions, composites on white and re-encodes JPEGs without changing sources',async()=>{
  const f=mergerFixture({sizes:[[17,19],[23,11]]});
  const png=new Uint8Array(f.png);
  const jpeg=Uint8Array.from([255,216,255,17,18,19,20]);
  const pages=[{url:'png',bytes:png},{url:'jpeg',bytes:jpeg}];
  const result=await f.context.exportArchive(pages,'JPEG chapter',()=>{},{convertToJpeg:true});
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.jpg','0002.jpg']);
  const first=await zip.file('0001.jpg').async('uint8array');
  const second=await zip.file('0002.jpg').async('uint8array');
  const codec=require('jpeg-js');
  for(const [bytes,width,height] of [[first,17,19],[second,23,11]]) {
    f.context.assertJpeg444(bytes,width,height);
    const decoded=codec.decode(bytes,{useTArray:true});
    assert.equal(decoded.width,width);assert.equal(decoded.height,height);
    const expected=codec.encode({width,height,data:new Uint8Array(width*height*4).fill(255)},97).data;
    assert.deepEqual(Buffer.from(bytes),expected); // Quality 97, not a Canvas-dependent fraction.
  }
  assert.notDeepEqual(second,jpeg);
  assert.deepEqual(png,f.png);
  assert.equal(pages[0].bytes,png);
  assert.deepEqual(f.draws,[['white',0,0,17,19],[0,0,17,19],['white',0,0,23,11],[0,0,23,11]]);
  assert.equal(f.closed.length,2);assert.equal(f.workerClosed.length,2);
  assert.equal(result.totalBytes,first.length+second.length);
});

test('JPEG conversion failures abort the CBZ and release decoding resources',async()=>{
  for(const options of [{decodeError:true},{noContext:true},{pixelError:true},{sizes:[[40000,100]]}]) {
    const f=mergerFixture(options);
    await assert.rejects(f.context.exportArchive([{url:'png',bytes:f.png}],'bad',()=>{},{convertToJpeg:true}));
    assert.equal(f.saved.length,0);
    if(!options.decodeError)assert.equal(f.closed.length,1);
  }
});

test('review JPEG option exports the fixed 97/4:4:4 profile and reports actual exported file sizes',async()=>{
  const f=await reviewFixture({imageOptions:true,sizes:[[17,19]],pages:[{url:'png',bytes:Uint8Array.from([137,80,78,71,13,10,26,10,42])}]});
  f.ids.get('show-image-info').checked=true;f.ids.get('show-image-info').onchange();
  assert.match(f.ids.get('image-info').textContent,/PNG × 1/);
  f.ids.get('convert-jpeg').checked=true;f.ids.get('convert-jpeg').onchange();
  let archive;
  f.context.URL.createObjectURL=blob=>{archive=blob;return 'blob:export';};
  f.context.browser.downloads.download=async()=>{f.saved.push(archive);return 7;};
  f.ids.get('export').onclick();await f.idle();
  assert.equal(f.saved.length,1);
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  assert.deepEqual(Object.keys(zip.files),['0001.jpg']);
  f.context.assertJpeg444(await zip.file('0001.jpg').async('uint8array'),17,19);
  assert.match(f.ids.get('image-info').textContent,/Last successful export: JPEG/);
  assert.match(f.ids.get('image-info').textContent,/PNG × 1/); // Source data was not replaced.
});

test('measuring remote files validates signatures, requests host permission and updates partial statistics',async()=>{
  const f=await reviewFixture({imageOptions:true,pages:[{url:'https://test/image.png',bytes:undefined}]});
  f.context.fetch=async()=>({ok:true,arrayBuffer:async()=>Uint8Array.from([255,216,255,23]).buffer});
  f.ids.get('show-image-info').checked=true;f.ids.get('show-image-info').onchange();
  assert.match(f.ids.get('image-info').textContent,/unknown/);
  f.ids.get('measure-files').onclick();await f.idle();
  assert.deepEqual(Array.from(f.permissions[0].origins),['https://test/*']);
  assert.match(f.ids.get('image-info').textContent,/JPEG × 1/); // Actual type wins over URL suffix.
  assert.match(f.ids.get('image-info').textContent,/Measured: 1\/1/);
});

test('the packaged JPEG worker emits real quality-97 4:4:4 JPEGs under extension CSP',async()=>{
  const f=exporterFixture({});
  const width=17,height=19;
  const pixels=new Uint8ClampedArray(width*height*4);
  for(let i=0;i<pixels.length;i+=4){pixels[i]=i%256;pixels[i+1]=(i*3)%256;pixels[i+2]=255-(i%256);pixels[i+3]=255;}
  const expectedPixels=new Uint8Array(pixels);
  const bytes=await f.context.encodeJpeg97(width,height,pixels);
  assert.equal(pixels.byteLength,0); // Transfer avoids retaining a duplicate RGBA buffer.
  const expected=require('jpeg-js').encode({width,height,data:expectedPixels},97).data;
  assert.deepEqual(Buffer.from(bytes),expected);
  const frame=Buffer.from(bytes).indexOf(Buffer.from([255,192]));
  assert.ok(frame>0);
  assert.deepEqual([bytes[frame+11],bytes[frame+14],bytes[frame+17]],[0x11,0x11,0x11]);
  const bad=new Uint8Array(bytes);bad[frame+11]=0x22;
  assert.throws(()=>f.context.assertJpeg444(bad,width,height),/4:4:4/);
  assert.throws(()=>f.context.assertJpeg444(bytes,width+1,height),/dimensions/);
  assert.equal(f.workerClosed.length,1);
});

test('worker errors abort JPEG export, terminate the worker and leave captured bytes untouched',async()=>{
  const f=mergerFixture({sizes:[[17,19]]});
  let terminated=0;
  f.context.Worker=class {
    postMessage(){queueMicrotask(()=>this.onmessage({data:{error:'Encoder unavailable'}}));}
    terminate(){terminated++;}
  };
  const original=new Uint8Array(f.png);
  await assert.rejects(f.context.exportArchive([{url:'png',bytes:original}],'bad',()=>{},{convertToJpeg:true}),/Encoder unavailable/);
  assert.equal(f.saved.length,0);assert.equal(terminated,1);assert.equal(f.closed.length,1);
  assert.deepEqual(original,f.png);
});

function fakeNativeConnector(f, failure) {
  const calls=[],connections=[],closed=[];
  f.context.browser.permissions={...f.context.browser.permissions,contains:async()=>true};
  f.context.browser.runtime.connectNative=name=>{
    assert.equal(name,'webtoon_to_cbz.imagemagick');connections.push(name);
    let receive,disconnect,input,width,height,offset=0,output;
    const port={onMessage:{addListener(fn){receive=fn;}},onDisconnect:{addListener(fn){disconnect=fn;}},
      disconnect(){closed.push(true);},
      postMessage(message){
        calls.push(message.action);
        queueMicrotask(()=>{
          if(failure==='missing'){port.error={message:'No native host installed'};disconnect();return;}
          let reply={id:message.id,ok:true};
          if(message.action==='ping')Object.assign(reply,{protocol:1,quality:97,sampling:'4:4:4',version:'ImageMagick 7 test'});
          if(message.action==='begin'){width=message.width;height=message.height;input=Buffer.alloc(width*height*4);}
          if(message.action==='write'){
            assert.equal(message.offset,offset);const data=Buffer.from(message.base64,'base64');data.copy(input,offset);offset+=data.length;
          }
          if(message.action==='encode'){
            assert.equal(offset,input.length);output=require('jpeg-js').encode({width,height,data:input},97).data;
            if(failure==='sampling'){const frame=output.indexOf(Buffer.from([255,192]));output[frame+11]=0x22;}
            reply.total=output.length;
          }
          if(message.action==='read')Object.assign(reply,{offset:message.offset,total:output.length,
            base64:output.subarray(message.offset,message.offset+256*1024).toString('base64')});
          receive(reply);
        });
      },
    };
    return port;
  };
  return{calls,connections,closed};
}

test('ImageMagick mode transfers bounded pixels, validates JPEG output and avoids the built-in worker',async()=>{
  const f=mergerFixture({sizes:[[17,19]]});const native=fakeNativeConnector(f);
  const result=await f.context.exportArchive([{url:'png',bytes:f.png}],'native',()=>{},{convertToJpeg:true,jpegEngine:'imagemagick'});
  assert.deepEqual(Array.from(result.encoders),['ImageMagick']);
  assert.equal(f.workerCalls.length,0);assert.equal(native.connections.length,1);assert.equal(native.closed.length,1);
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  f.context.assertJpeg444(await zip.file('0001.jpg').async('uint8array'),17,19);
  assert.deepEqual(native.calls,['ping','begin','write','encode','read']);
});

test('Automatic mode falls back once per export if the native host is absent; forced mode fails explicitly',async()=>{
  const f=mergerFixture({sizes:[[17,19],[17,19]]});const native=fakeNativeConnector(f,'missing');
  const reports=[];
  const result=await f.context.exportArchive([{url:'a',bytes:f.png},{url:'b',bytes:f.png}],'fallback',text=>reports.push(text),{convertToJpeg:true,jpegEngine:'auto'});
  assert.deepEqual(Array.from(result.encoders),['Built-in']);
  assert.equal(native.connections.length,1);assert.equal(f.workerCalls.length,2);
  assert.ok(reports.some(text=>text.includes('using the built-in')));
  const forced=mergerFixture({sizes:[[17,19]]});fakeNativeConnector(forced,'missing');
  await assert.rejects(forced.context.exportArchive([{url:'a',bytes:forced.png}],'bad',()=>{},{convertToJpeg:true,jpegEngine:'imagemagick'}),/No native host/);
  assert.equal(forced.saved.length,0);assert.equal(forced.workerCalls.length,0);
});

test('native sampling mismatch triggers Automatic fallback and cannot silently create non-4:4:4 JPEGs',async()=>{
  const f=mergerFixture({sizes:[[17,19]]});fakeNativeConnector(f,'sampling');
  const result=await f.context.exportArchive([{url:'a',bytes:f.png}],'safe',()=>{},{convertToJpeg:true,jpegEngine:'auto'});
  assert.deepEqual(Array.from(result.encoders),['Built-in']);
  const zip=await JSZip.loadAsync(await f.saved[0].arrayBuffer());
  f.context.assertJpeg444(await zip.file('0001.jpg').async('uint8array'),17,19);
});

test('review can check the native connector and deliberately keep using the built-in mode',async()=>{
  const f=await reviewFixture({imageOptions:true,nativeOptions:true,sizes:[[17,19]],pages:[{url:'png',bytes:Uint8Array.from([137,80,78,71,13,10,26,10,42])}]});
  const native=fakeNativeConnector(f);
  await f.ids.get('check-imagemagick').onclick();
  assert.deepEqual(Array.from(f.permissions[0].permissions),['nativeMessaging']);
  assert.match(f.ids.get('jpeg-engine-status').textContent,/Available: ImageMagick/);
  f.ids.get('convert-jpeg').checked=true;f.ids.get('convert-jpeg').onchange();
  assert.equal(f.ids.get('jpeg-engine').disabled,false);f.ids.get('jpeg-engine').value='builtin';
  let archive;f.context.URL.createObjectURL=blob=>{archive=blob;return 'blob:out';};
  f.context.browser.downloads.download=async()=>{f.saved.push(archive);return 7;};
  f.ids.get('export').onclick();await f.idle();
  assert.equal(f.saved.length,1);assert.equal(native.connections.length,1);assert.equal(f.workerCalls.length,1);
});
