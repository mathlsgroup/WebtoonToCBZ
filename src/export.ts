declare const JSZip: new () => {
  file(name: string, data: Uint8Array): void;
  generateAsync(options: { type: 'blob'; compression: 'STORE' }): Promise<Blob>;
};

// Check file signatures rather than trusting URL extensions or HTTP headers.
function imageExtension(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if ([137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) return 'png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(4, 8) === 'ftyp') {
    const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (boxSize >= 16 && boxSize <= bytes.length) {
      for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
        if (offset === 12) continue; // Minor version is not a brand.
        if (['avif', 'avis'].includes(ascii(offset, offset + 4))) return 'avif';
      }
    }
  }
  throw new Error('Unsupported or invalid image data (JPEG, PNG, GIF, WebP or AVIF required).');
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

async function exportArchive(urls: (string | { url: string; bytes?: Uint8Array })[], title: string, report: (message: string) => void): Promise<void> {
  const zip = new JSZip();
  for (const [index, page] of urls.entries()) {
    report('Fetching image ' + (index + 1) + '/' + urls.length + '... Keep this review tab open.');
    let bytes: Uint8Array;
    try {
      bytes = typeof page === 'string' ? await fetchImageBytes(page) : page.bytes ?? await fetchImageBytes(page.url);
    } catch (error) { throw new Error('Image ' + (index + 1) + ': ' + String(error) + ' No archive exported.'); }
    let extension: string;
    try { extension = imageExtension(bytes); }
    catch { throw new Error('Image ' + (index + 1) + ' has unsupported or invalid data. No archive exported.'); }
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
  } finally { URL.revokeObjectURL(objectUrl); }
}
