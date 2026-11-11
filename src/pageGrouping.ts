type PageEdges = { width: number; height: number; topWhite: boolean; bottomWhite: boolean };
type PageSuggestion = { page: ReviewPage; pageNumber?: number; note: string };

// A border may be slightly gray or have a few JPEG artifacts. Inspect native pixels.
function hasWhiteEdge(pixels: Uint8ClampedArray, width: number): boolean {
  if (width < 1 || pixels.length < width * 4) return false;
  for (let row = 0; row < Math.floor(pixels.length / (width * 4)); row++) {
    let white = 0;
    for (let x = 0; x < width; x++) {
      const offset = (row * width + x) * 4;
      const alpha = pixels[offset + 3] / 255;
      if ([0, 1, 2].every(channel => pixels[offset + channel] * alpha + 255 * (1 - alpha) >= 245)) white++;
    }
    if (white / width >= 0.98) return true;
  }
  return false;
}

async function inspectPageEdges(page: ReviewPage): Promise<PageEdges> {
  const bytes = page.bytes ?? await fetchImageBytes(page.url);
  imageExtension(bytes);
  page.bytes = bytes;
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
  let canvas: HTMLCanvasElement | undefined;
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width > 32767) throw new Error('Image dimensions exceed the edge analysis limit.');
    // Only two thin bands are allocated, even for a very tall chapter image.
    const rows = Math.min(3, bitmap.height);
    canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = rows * 2;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not allocate the edge analysis canvas.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, bitmap.width, rows, 0, 0, bitmap.width, rows);
    context.drawImage(bitmap, 0, bitmap.height - rows, bitmap.width, rows, 0, rows, bitmap.width, rows);
    return {
      width: bitmap.width, height: bitmap.height,
      topWhite: hasWhiteEdge(context.getImageData(0, 0, bitmap.width, rows).data, bitmap.width),
      bottomWhite: hasWhiteEdge(context.getImageData(0, rows, bitmap.width, rows).data, bitmap.width),
    };
  } finally {
    bitmap.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}

// Suggestions only: never merge or mutate pages during boundary detection.
function suggestPageNumbers(pages: ReviewPage[], edges: Map<string, PageEdges>): PageSuggestion[] {
  const result: PageSuggestion[] = [];
  let number = 1;
  let index = 0;
  while (index < pages.length) {
    const page = pages[index];
    if (!page.selected) {
      result.push({ page, note: 'Excluded' }); index++; continue;
    }
    const first = edges.get(page.url);
    let end = index;
    if (first && first.width > first.height && first.topWhite && !first.bottomWhite && !page.sources) {
      let height = first.height;
      let minWidth = first.width, maxWidth = first.width;
      for (let next = index + 1; next < pages.length; next++) {
        const candidate = pages[next], edge = edges.get(candidate.url);
        // Portrait pages, exclusions and new starts are hard boundaries.
        if (!candidate.selected || candidate.sources || !edge || edge.width <= edge.height || edge.topWhite) break;
        minWidth = Math.min(minWidth, edge.width); maxWidth = Math.max(maxWidth, edge.width);
        if (minWidth / maxWidth < 0.95) break;
        height += edge.height;
        if (edge.bottomWhite) {
          if (height > maxWidth) end = next;
          break;
        }
      }
    }
    const note = end > index ? 'Suggested group: white top/bottom borders and combined portrait ratio. Verify before merging.'
      : !first ? 'Analysis unavailable. Kept separate; check manually.'
      : page.sources || first.height > first.width ? 'Portrait page kept separate.'
      : 'Uncertain landscape image: no complete strip group found. Kept separate.';
    for (let member = index; member <= end; member++) {
      result.push({ page: pages[member], pageNumber: number, note });
    }
    number++; index = end + 1;
  }
  return result;
}

function numberedPageGroups(pages: ReviewPage[]): ReviewPage[][] {
  const groups = new Map<number, { page: ReviewPage; index: number }[]>();
  pages.forEach((page, index) => {
    if (!page.selected) return;
    const number = page.pageNumber;
    if (number === undefined || !Number.isSafeInteger(number) || number < 1) {
      throw new Error('Enter a positive whole page number for every included image.');
    }
    const group = groups.get(number) ?? [];
    group.push({ page, index }); groups.set(number, group);
  });
  const result: ReviewPage[][] = [];
  for (const [number, group] of groups) {
    if (group.some((entry, offset) => entry.index !== group[0].index + offset)) {
      throw new Error('Page ' + number + ': images with the same number must be consecutive (no excluded image between them).');
    }
    if (group.length > 1) result.push(group.map(entry => entry.page));
  }
  return result;
}
