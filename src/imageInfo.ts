type ImageFileInfo = { fileType: string; byteLength: number };

// Read signatures, never URL suffixes. Indexed reads avoid Firefox Xray species.
function imageExtension(bytes: Uint8Array): string {
  const ascii = (start: number, end: number) => {
    let value = '';
    for (let index = start; index < Math.min(end, bytes.length); index++) value += String.fromCharCode(bytes[index]);
    return value;
  };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if ([137,80,78,71,13,10,26,10].every((value, i) => bytes[i] === value)) return 'png';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (bytes.length >= 16 && ascii(4, 8) === 'ftyp') {
    const boxSize = bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3];
    if (boxSize >= 16 && boxSize <= bytes.length) for (let offset = 8; offset + 4 <= boxSize; offset += 4) {
      if (offset !== 12 && ['avif', 'avis'].includes(ascii(offset, offset + 4))) return 'avif';
    }
  }
  throw new Error('Unsupported or invalid image data (JPEG, PNG, GIF, WebP or AVIF required).');
}

function imageFileInfo(page: { bytes?: Uint8Array; fileType?: string; byteLength?: number }): ImageFileInfo | undefined {
  try {
    if (page.bytes) return { fileType: imageExtension(page.bytes), byteLength: page.bytes.length };
    if (['jpg','png','webp','avif','gif'].includes(page.fileType || '') && Number.isSafeInteger(page.byteLength) && page.byteLength! > 0) {
      return { fileType: page.fileType!, byteLength: page.byteLength! };
    }
  } catch { /* Unreadable data remains unknown; export reports its validation error. */ }
  return undefined;
}

function imageByteLabel(bytes: number): string {
  return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(2) + ' MiB'
    : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KiB' : Math.round(bytes) + ' B';
}

function imageTypeLabel(type: string): string { return type === 'jpg' ? 'JPEG' : type.toUpperCase(); }

function imageFileSummary(pages: { selected: boolean; bytes?: Uint8Array; fileType?: string; byteLength?: number }[]): string {
  const selected = pages.filter(page => page.selected);
  const known = selected.map(imageFileInfo).filter((info): info is ImageFileInfo => !!info);
  if (!selected.length) return 'No images selected.';
  if (!known.length) return 'Format and average size unknown: no selected image files measured.';
  const formats = new Map<string, number>();
  let total = 0;
  for (const info of known) { formats.set(info.fileType, (formats.get(info.fileType) || 0) + 1); total += info.byteLength; }
  return [...formats].map(([type, count]) => imageTypeLabel(type) + ' × ' + count).join(', ')
    + '. Average file size: ' + imageByteLabel(total / known.length) + '. Total: ' + imageByteLabel(total)
    + '. Measured: ' + known.length + '/' + selected.length + ' selected images.';
}
