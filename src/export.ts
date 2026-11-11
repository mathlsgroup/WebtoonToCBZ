declare const JSZip: new () => {
  file(name: string, data: Uint8Array): void;
  generateAsync(options: { type: 'blob'; compression: 'STORE' }): Promise<Blob>;
};

type ImageExportOptions = { convertToJpeg?: boolean; jpegEngine?: JpegEngine };

async function jpegImageBytes(bytes: Uint8Array,engine: JpegEngine='builtin',nativeState: {unavailable?:boolean}={},
  report:(message:string)=>void=()=>{},used:(encoder:string)=>void=()=>{}): Promise<Uint8Array> {
  imageExtension(bytes);
  let bitmap: ImageBitmap | undefined = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  let canvas: HTMLCanvasElement | undefined;
  try {
    const { width, height } = bitmap;
    if (!width || !height || width > 32767 || height > 32767 || width * height > 64 * 1024 * 1024) {
      throw new Error('JPEG conversion exceeds the Canvas safety limit (32767 pixels per side, 64 megapixels).');
    }
    canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('JPEG Canvas allocation failed.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, width, height).data;
    // Release decoded resources before transferring RGBA pixels to the worker.
    bitmap.close(); bitmap = undefined; canvas.width = 0; canvas.height = 0; canvas = undefined;
    const result=await encodeChosenJpeg(width,height,pixels,engine,nativeState,report);
    used(result.encoder);return result.bytes;
  } finally { bitmap?.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
}

function archiveFilename(input: string): string {
  let name = input.trim().replace(/\.cbz$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '').slice(0, 180).replace(/[. ]+$/g, '');
  if (!name) name = 'chapter';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return name + '.cbz';
}

async function fetchImageBytes(url: string): Promise<Uint8Array> {
  if (url.startsWith('blob:')) throw new Error('Captured blob bytes unavailable. Refresh the review or recapture the visible page.');
  const response = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + '. No archive exported.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  try { imageExtension(bytes); }
  catch { throw new Error('Unsupported or invalid data (JPEG, PNG, GIF, WebP or AVIF required).'); }
  return bytes;
}

async function exportArchive(urls: (string | { url: string; bytes?: Uint8Array })[], title: string, report: (message: string) => void,
  options: ImageExportOptions = {}): Promise<{ imageCount: number; totalBytes: number; formats: string[]; encoders: string[] }> {
  const zip = new JSZip();
  let totalBytes = 0;
  const formats = new Set<string>();
  const encoders = new Set<string>();
  const nativeState: {unavailable?:boolean}={};
  for (const [index, page] of urls.entries()) {
    report('Fetching image ' + (index + 1) + '/' + urls.length + '... Keep this review tab open.');
    let bytes: Uint8Array;
    try {
      bytes = typeof page === 'string' ? await fetchImageBytes(page) : page.bytes ?? await fetchImageBytes(page.url);
    } catch (error) { throw new Error('Image ' + (index + 1) + ': ' + String(error) + ' No archive exported.'); }
    let extension: string;
    try { extension = imageExtension(bytes); }
    catch { throw new Error('Image ' + (index + 1) + ' has unsupported or invalid data. No archive exported.'); }
    if (options.convertToJpeg) {
      report('Preparing JPEG image ' + (index + 1) + '/' + urls.length + '...');
      try { bytes = await jpegImageBytes(bytes,options.jpegEngine ?? 'builtin',nativeState,report,encoder=>encoders.add(encoder)); }
      catch (error) { throw new Error('Image ' + (index + 1) + ': JPEG conversion failed: ' + String(error) + '. No archive exported.'); }
      extension = 'jpg';
    }
    totalBytes += bytes.length; formats.add(extension);
    zip.file(String(index + 1).padStart(4, '0') + '.' + extension, bytes);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const filename = archiveFilename(title);
    const id = await browser.downloads.download({ url: objectUrl, filename, saveAs: true });
    report('Archive submitted for saving. Waiting for download completion...');
    await new Promise<void>((resolve, reject) => {
      const changed = (delta: { id: number; state?: { current: string } }) => {
        if (delta.id !== id || !delta.state) return;
        if (delta.state.current === 'complete') { cleanup(); resolve(); }
        if (delta.state.current === 'interrupted') { cleanup(); reject(new Error('Download interrupted. Archive was not saved.')); }
      };
      const cleanup = () => browser.downloads.onChanged.removeListener(changed);
      browser.downloads.onChanged.addListener(changed);
      // Cover completion between downloads.download() and listener registration.
      void browser.downloads.search({ id }).then((items: { state: string }[]) => {
        if (items[0]?.state) changed({ id, state: { current: items[0].state } });
      }).catch((error: unknown) => { cleanup(); reject(error); });
    });
    report('Saved ' + filename + ' (' + urls.length + ' images).');
    return { imageCount: urls.length, totalBytes, formats: [...formats], encoders: [...encoders] };
  } finally { URL.revokeObjectURL(objectUrl); }
}
