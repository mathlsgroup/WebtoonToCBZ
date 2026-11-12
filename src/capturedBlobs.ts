type CapturedBlobChunk = { generation?: string; offset?: number; total?: number; base64?: string; error?: string };

async function readPreparedJpeg(tabId:number,generation:string,url:string,engine:JpegEngine):Promise<{bytes:Uint8Array;encoder:string}|undefined>{
  let bytes:Uint8Array|undefined;let offset=0;let encoder='';
  do {
    const chunk=await browser.runtime.sendMessage({action:'processing-jpeg',tabId,generation,url,engine,offset});
    if(!chunk||chunk.miss)return undefined;
    if(chunk.error)throw new Error(chunk.error);
    if(chunk.generation!==generation||chunk.offset!==offset||!Number.isSafeInteger(chunk.total)||chunk.total<1||chunk.total>128*1024*1024
      ||typeof chunk.base64!=='string'||chunk.base64.length>350000)throw new Error('Invalid prepared JPEG transfer.');
    bytes??=new Uint8Array(chunk.total);
    const binary=atob(chunk.base64);
    if(chunk.total!==bytes.length||binary.length!==Math.min(256*1024,bytes.length-offset))throw new Error('Incomplete prepared JPEG.');
    for(let i=0;i<binary.length;i++)bytes[offset+i]=binary.charCodeAt(i);
    offset+=binary.length;encoder=chunk.encoder;
  }while(offset<bytes.length);
  return {bytes,encoder};
}

// Firefox messages carry bounded base64 chunks; source object URLs never need to
// be opened from an extension origin or granted HTTP host permissions.
async function readCapturedBlob(tabId: number, generation: string, url: string): Promise<Uint8Array> {
  let bytes: Uint8Array | undefined;
  let offset = 0;
  do {
    let chunk: CapturedBlobChunk | undefined;
    let sourceError: unknown;
    try { chunk = await browser.tabs.sendMessage(tabId, { action: 'blob-data', generation, url, offset }); }
    catch (error) { sourceError = error; }
    if (!chunk || chunk.error) {
      try {
        const stored = await browser.runtime?.sendMessage?.({ action: 'archive-request', command: 'blob-data', tabId, generation, url, offset });
        if (stored && (!stored.error || !chunk || chunk.error?.includes('Image was not captured'))) chunk = stored;
      } catch { /* Preserve the more specific source error below. */ }
    }
    if (!chunk && sourceError) throw sourceError;
    if (!chunk || typeof chunk !== 'object') throw new Error('Source capture is outdated. Reload the chapter and start capture again.');
    if (chunk.error) throw new Error(chunk.error);
    if (chunk.generation !== generation || chunk.offset !== offset || !Number.isSafeInteger(chunk.total)
      || chunk.total! < 1 || chunk.total! > 64 * 1024 * 1024 || typeof chunk.base64 !== 'string'
      || chunk.base64.length > 350000) throw new Error('Invalid or stale captured image data. Refresh the review.');
    if (!bytes) bytes = new Uint8Array(chunk.total!);
    if (chunk.total !== bytes.length) throw new Error('Captured image size changed during transfer.');
    const binary = atob(chunk.base64);
    const expected = Math.min(256 * 1024, bytes.length - offset);
    if (binary.length !== expected) throw new Error('Incomplete captured image transfer. Refresh the review.');
    for (let index = 0; index < binary.length; index++) bytes[offset + index] = binary.charCodeAt(index);
    offset += binary.length;
  } while (offset < bytes.length);
  imageExtension(bytes);
  return bytes;
}

// This is a derived display asset only. Export/merge always uses full image bytes.
async function createCapturedThumbnail(bytes: Uint8Array): Promise<string> {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  let canvas: HTMLCanvasElement | undefined;
  try {
    const scale = Math.min(1, 140 / bitmap.width, 180 / bitmap.height);
    canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Thumbnail Canvas allocation failed.');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > 256 * 1024) throw new Error('Thumbnail exceeds the cache limit.');
    return dataUrl;
  } finally {
    bitmap.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
