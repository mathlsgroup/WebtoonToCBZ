// Check the actual encoded frame, rather than relying on an encoder setting.
function assertJpeg444(bytes: Uint8Array, width: number, height: number): void {
  if (imageExtension(bytes) !== 'jpg') throw new Error('Encoder did not return JPEG data.');
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 255) break;
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if (marker === 0xc0) {
      if (length !== 17 || bytes[offset + 2] !== 8 || bytes[offset + 7] !== 3
        || bytes[offset + 3] * 256 + bytes[offset + 4] !== height
        || bytes[offset + 5] * 256 + bytes[offset + 6] !== width
        || [9,12,15].some(index => bytes[offset + index] !== 0x11)) {
        throw new Error('JPEG output must retain native dimensions and use 4:4:4 sampling.');
      }
      return;
    }
    offset += length;
  }
  throw new Error('JPEG output has no valid 4:4:4 baseline frame.');
}

async function encodeJpeg97(width: number, height: number, pixels: Uint8ClampedArray,signal?:AbortSignal): Promise<Uint8Array> {
  if(signal?.aborted)throw new Error('JPEG encoding cancelled.');
  const worker = new Worker(browser.runtime.getURL('jpegWorker.js'));
  let cancel:()=>void=()=>{};
  try {
    const bytes = await new Promise<Uint8Array>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('JPEG encoding exceeded the two-minute per-image limit.')), 120000);
      cancel=()=>{clearTimeout(timeout);reject(new Error('JPEG encoding cancelled.'));};
      signal?.addEventListener('abort',cancel,{once:true});
      worker.onmessage = (event: MessageEvent<{ bytes?: ArrayBuffer; error?: string }>) => {
        clearTimeout(timeout);
        if (event.data?.error) reject(new Error(event.data.error));
        else if (event.data?.bytes) resolve(new Uint8Array(event.data.bytes));
        else reject(new Error('Invalid JPEG worker response.'));
      };
      worker.onerror = () => { clearTimeout(timeout); reject(new Error('The local JPEG worker failed.')); };
      try { worker.postMessage({ width, height, pixels: pixels.buffer }, [pixels.buffer as ArrayBuffer]); }
      catch (error) { clearTimeout(timeout); reject(error); }
    });
    assertJpeg444(bytes, width, height);
    return bytes;
  } finally { signal?.removeEventListener('abort',cancel);worker.terminate(); }
}
