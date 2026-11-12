type JpegEngine = 'auto' | 'builtin' | 'imagemagick';
type NativeReply = { id?: number; ok?: boolean; error?: string; protocol?: number; quality?: number; sampling?: string;
  version?: string; offset?: number; total?: number; base64?: string };

function imageMagickConnection() {
  const port = browser.runtime.connectNative('webtoon_to_cbz.imagemagick');
  let sequence = 0;
  const pending = new Map<number, { resolve(value: NativeReply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  port.onMessage.addListener((reply: NativeReply) => {
    const request = pending.get(reply.id!);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(reply.id!);
    if (reply.error) request.reject(new Error(reply.error)); else request.resolve(reply);
  });
  port.onDisconnect.addListener(() => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error(port.error?.message || 'ImageMagick connector disconnected.')); }
    pending.clear();
  });
  return {
    request(action: string, fields: object = {}): Promise<NativeReply> {
      const id = ++sequence;
      return new Promise((resolve,reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('ImageMagick connector timed out.')); },action === 'encode' ? 125000 : 15000);
        pending.set(id,{resolve,reject,timer});
        try { port.postMessage({id,action,...fields}); }
        catch(error) { clearTimeout(timer);pending.delete(id);reject(error); }
      });
    },
    close() {
      for(const request of pending.values()){clearTimeout(request.timer);request.reject(new Error('ImageMagick connection closed.'));}
      pending.clear();port.disconnect();
    },
  };
}

async function imageMagickPermission(): Promise<void> {
  if (!await browser.permissions?.contains?.({permissions:['nativeMessaging']})) {
    throw new Error('Click Check ImageMagick to grant access to the local connector.');
  }
}

function validateImageMagick(reply: NativeReply): void {
  if (!reply.ok || reply.protocol !== 1 || reply.quality !== 97 || reply.sampling !== '4:4:4') {
    throw new Error('Incompatible ImageMagick connector. Run the installer from this project.');
  }
}

async function probeImageMagick(): Promise<string> {
  await imageMagickPermission();
  const connection = imageMagickConnection();
  try { const reply=await connection.request('ping');validateImageMagick(reply);return reply.version || 'ImageMagick 7'; }
  finally { connection.close(); }
}

async function encodeImageMagick(width: number, height: number, pixels: Uint8ClampedArray,signal?:AbortSignal): Promise<Uint8Array> {
  await imageMagickPermission();
  if(signal?.aborted)throw new Error('JPEG encoding cancelled.');
  const connection = imageMagickConnection();
  const cancel=()=>connection.close();signal?.addEventListener('abort',cancel,{once:true});
  const chunkSize = 256 * 1024;
  try {
    validateImageMagick(await connection.request('ping'));
    if (!(await connection.request('begin',{width,height})).ok) throw new Error('ImageMagick could not begin conversion.');
    for(let offset=0;offset<pixels.length;offset+=chunkSize) {
      let binary='';
      for(let start=offset;start<Math.min(offset+chunkSize,pixels.length);start+=8192) {
        binary+=String.fromCharCode(...pixels.subarray(start,Math.min(start+8192,offset+chunkSize,pixels.length)));
      }
      if(!(await connection.request('write',{offset,base64:btoa(binary)})).ok)throw new Error('ImageMagick pixel transfer failed.');
    }
    const encoded=await connection.request('encode');
    if(!encoded.ok || !Number.isSafeInteger(encoded.total) || encoded.total!<1 || encoded.total!>128*1024*1024)throw new Error('Invalid ImageMagick output size.');
    const bytes=new Uint8Array(encoded.total!);
    for(let offset=0;offset<bytes.length;offset+=chunkSize) {
      const reply=await connection.request('read',{offset});
      if(reply.offset!==offset || reply.total!==bytes.length || typeof reply.base64!=='string' || reply.base64.length>350000)throw new Error('Invalid ImageMagick output chunk.');
      const binary=atob(reply.base64);
      if(binary.length!==Math.min(chunkSize,bytes.length-offset))throw new Error('Incomplete ImageMagick output.');
      for(let i=0;i<binary.length;i++)bytes[offset+i]=binary.charCodeAt(i);
    }
    assertJpeg444(bytes,width,height);
    return bytes;
  } finally { signal?.removeEventListener('abort',cancel);connection.close(); }
}

async function encodeChosenJpeg(width: number,height: number,pixels: Uint8ClampedArray,engine: JpegEngine,
  nativeState: { unavailable?: boolean },report: (message:string)=>void,signal?:AbortSignal):Promise<{bytes:Uint8Array;encoder:string}> {
  if(!['auto','builtin','imagemagick'].includes(engine))throw new Error('Unknown JPEG encoder.');
  if(engine!=='builtin' && !nativeState.unavailable) {
    try { report('Encoding JPEG 97 / 4:4:4 with ImageMagick...');return {bytes:await encodeImageMagick(width,height,pixels,signal),encoder:'ImageMagick'}; }
    catch(error) {
      if(signal?.aborted)throw error;
      if(engine==='imagemagick')throw error;
      nativeState.unavailable=true;
      report('ImageMagick unavailable; using the built-in JPEG 97 / 4:4:4 encoder.');
    }
  }
  return {bytes:await encodeJpeg97(width,height,pixels,signal),encoder:'Built-in'};
}
