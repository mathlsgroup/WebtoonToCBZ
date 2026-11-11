type ReviewPage = {
  url: string; order: number; width: number; height: number; selected: boolean;
  bytes?: Uint8Array; sources?: ReviewPage[];
  pageNumber?: number; groupingNote?: string;
};

function originalPages(page: ReviewPage): ReviewPage[] {
  return page.sources ? page.sources.flatMap(originalPages) : [page];
}

function includeReviewPage(page: ReviewPage, selected: boolean): void {
  page.selected = selected;
  page.sources?.forEach(source => includeReviewPage(source, selected));
}

function mergeSelection(pages: ReviewPage[], selected: Set<string>): ReviewPage[] {
  const indices = pages.flatMap((page, index) => selected.has(page.url) ? [index] : []);
  if (indices.length < 2 || indices.length !== selected.size
    || indices.some((index, offset) => index !== indices[0] + offset)) {
    throw new Error('Select at least two consecutive pages to merge.');
  }
  const result = indices.map(index => pages[index]);
  if (result.some(page => !page.selected)) throw new Error('Include all selected pages before merging.');
  return result;
}

function replaceMergedPages(pages: ReviewPage[], sources: ReviewPage[], merged: ReviewPage): ReviewPage[] {
  const index = pages.indexOf(sources[0]);
  if (index < 0 || sources.some((page, offset) => pages[index + offset] !== page)) {
    throw new Error('Page order changed. Select the pages again.');
  }
  return [...pages.slice(0, index), merged, ...pages.slice(index + sources.length)];
}

function undoMergedPage(pages: ReviewPage[], page: ReviewPage): ReviewPage[] {
  return pages.flatMap(current => current === page && page.sources ? page.sources : [current]);
}

async function mergeImagesVertically(sources: ReviewPage[]): Promise<ReviewPage> {
  if (sources.length < 2) throw new Error('Select at least two consecutive pages to merge.');
  const decoded: ImageBitmap[] = [];
  let canvas: HTMLCanvasElement | undefined;
  try {
    const formats: string[] = [];
    for (const source of sources) {
      const bytes = source.bytes ?? await fetchImageBytes(source.url);
      const extension = imageExtension(bytes);
      // Cache original bytes for undo and subsequent export without re-encoding.
      source.bytes = bytes;
      formats.push(extension);
      decoded.push(await createImageBitmap(new Blob([new Uint8Array(bytes)], {
        type: extension === 'jpg' ? 'image/jpeg' : 'image/' + extension,
      })));
    }
    const width = Math.max(...decoded.map(image => image.width));
    const height = decoded.reduce((sum, image) => sum + image.height, 0);
    // Conservative allocation budget; never scale or silently truncate strips.
    if (!width || !height || width > 32767 || height > 32767 || width * height > 64 * 1024 * 1024) {
      throw new Error('Merged image exceeds the canvas safety limit (32767 pixels per side, 64 megapixels). Merge fewer strips.');
    }
    canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas memory allocation failed.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
    let y = 0;
    for (const image of decoded) {
      context.drawImage(image, Math.floor((width - image.width) / 2), y);
      y += image.height;
    }
    const type = formats.every(format => format === 'jpg') ? 'image/jpeg' : 'image/png';
    const blob = await new Promise<Blob>((resolve, reject) => canvas!.toBlob(
      value => value ? resolve(value) : reject(new Error('Image encoding failed. Try merging fewer strips.')), type, 0.95));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (imageExtension(bytes) !== (type === 'image/jpeg' ? 'jpg' : 'png')) throw new Error('Unexpected canvas output format.');
    return { url: URL.createObjectURL(blob), order: sources[0].order, width, height,
      selected: true, bytes, sources, pageNumber: sources[0].pageNumber };
  } catch (error) {
    throw new Error('Merge failed: ' + (error instanceof Error ? error.message : String(error)));
  } finally {
    decoded.forEach(image => image.close());
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
