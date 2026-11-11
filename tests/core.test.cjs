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
      }; },
      toBlob(callback, type, quality) {
        draws.push([type,quality]);
        callback(options.noBlob ? null : new Blob([type === 'image/jpeg' ? jpg : png]));
      },
    }; } },
  });
  vm.runInContext(fs.readFileSync('dist/imageMerger.js','utf8'),f.context);
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
  for(const id of ['status','list','title','export','merge','undo','merge-numbered','detect','selection','numbering','start','stop','refresh','close-preview','hide-excluded','target-height','detect-height','height-tolerance']) {
    ids.set(id,new Element(['title','hide-excluded','target-height','height-tolerance'].includes(id)?'input':id==='status'||id==='list'||id==='selection'||id==='numbering'?'div':'button'));
  }
  ids.get('height-tolerance').valueAsNumber=1;
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
  const revoked=[], permissions=[];
  let objectId=0;
  Object.assign(f.context,{
    URL:class extends URL {
      static createObjectURL(){return 'blob:review/'+(++objectId);}
      static revokeObjectURL(url){revoked.push(url);}
    },
    URLSearchParams,location:{search:'?tab=1'},window:{addEventListener(){}},setTimeout,
  });
  const createCanvas=f.context.document.createElement;
  f.context.document={
    getElementById:id=>ids.get(id),
    createElement:tag=>tag==='canvas'?createCanvas():new Element(tag),
    querySelectorAll:()=>controls(),
  };
  f.context.browser.permissions={request:async request=>{permissions.push(request);return options.permission!==false;}};
  f.context.browser.tabs={sendMessage:async (_,message)=>{
    if(message.action==='select') source.find(page=>page.url===message.url).selected=message.selected;
    return {capturing:false,generation:'fixture',entries:source.map(page=>({...page})),missing:0,title:'Chapter'};
  }};
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
      if(!ids.get('detect').disabled)return;
    }
    throw new Error('Review operation did not finish');
  };
  return {...f,ids,rows,numbers,setNumbers,idle,revoked,permissions};
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
  const denied=await reviewFixture({permission:false});
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
