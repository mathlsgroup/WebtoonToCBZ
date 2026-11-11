declare const JPEGEncoder: new (quality: number) => {
  encode(frame: { width: number; height: number; data: Uint8Array }, quality: number): Uint8Array;
};

(() => {
  const worker = globalThis as unknown as {
    importScripts(url: string): void;
    onmessage: (event: MessageEvent<{ width: number; height: number; pixels: ArrayBuffer }>) => void;
    postMessage(message: object, transfer?: ArrayBuffer[]): void;
  };
  // jpeg-js 0.4.4 encodes all Y/Cb/Cr components at 1x1 sampling (4:4:4).
  // Its unmodified encoder and license are bundled locally; no decoder is loaded.
  worker.importScripts('jpeg-encoder.js');
  worker.onmessage = event => {
    try {
      const { width, height, pixels } = event.data;
      if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
        || width > 32767 || height > 32767 || width * height > 64 * 1024 * 1024
        || pixels.byteLength !== width * height * 4) throw new Error('Invalid JPEG pixel payload.');
      const bytes = new JPEGEncoder(97).encode({ width, height, data: new Uint8Array(pixels) }, 97);
      worker.postMessage({ bytes: bytes.buffer }, [bytes.buffer as ArrayBuffer]);
    } catch (error) { worker.postMessage({ error: 'JPEG 97 / 4:4:4 encoding failed: ' + String(error) }); }
  };
})();
