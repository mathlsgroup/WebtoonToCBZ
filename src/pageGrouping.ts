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

// Use full included portrait pages only; proposed strips never validate themselves.
function referencePageRatio(pages: ReviewPage[], edges: Map<string, PageEdges>): number | undefined {
  const ratios = pages.filter(page => page.selected).flatMap(page => {
    const edge = edges.get(page.url);
    return edge && edge.width > 0 && edge.height > edge.width ? [edge.height / edge.width] : [];
  }).sort((a, b) => a - b);
  if (ratios.length < 2) return undefined;
  const middle = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 ? ratios[middle] : (ratios[middle - 1] + ratios[middle]) / 2;
  const matching = ratios.filter(ratio => Math.abs(ratio / median - 1) <= 0.20);
  return matching.length >= 2 && matching.length / ratios.length >= 2 / 3 ? median : undefined;
}

// Suggestions only: never merge or mutate pages during boundary detection.
function suggestPageNumbers(pages: ReviewPage[], edges: Map<string, PageEdges>): PageSuggestion[] {
  const result: PageSuggestion[] = [];
  const reference = referencePageRatio(pages, edges);
  let number = 1;
  let index = 0;
  while (index < pages.length) {
    const page = pages[index];
    if (!page.selected) {
      result.push({ page, note: 'Excluded' }); index++; continue;
    }
    const first = edges.get(page.url);
    let end = index;
    let rejection = '';
    if (first && first.width > first.height && first.topWhite && !first.bottomWhite && !page.sources) {
      let height = first.height;
      let minWidth = first.width, maxWidth = first.width;
      for (let next = index + 1; next < pages.length; next++) {
        const candidate = pages[next], edge = edges.get(candidate.url);
        if (!candidate.selected) continue;
        // Included portraits, failed analyses and new starts are hard boundaries.
        if (candidate.sources || !edge || edge.width <= edge.height || edge.topWhite) break;
        minWidth = Math.min(minWidth, edge.width); maxWidth = Math.max(maxWidth, edge.width);
        if (minWidth / maxWidth < 0.95) break;
        height += edge.height;
        if (edge.bottomWhite) {
          if (height > maxWidth) {
            if (reference === undefined) rejection = 'No consistent ratio reference: at least two similar included portrait pages are needed. Check manually.';
            else if (Math.abs((height / maxWidth) / reference - 1) > 0.20) rejection = 'Combined ratio differs from the chapter portrait pages by more than 20%. Kept separate.';
            else end = next;
          }
          break;
        }
      }
    }
    const note = end > index ? 'Suggested group: white borders and ratio within 20% of the chapter portrait pages. Verify before merging.'
      : rejection ? rejection
      : !first ? 'Analysis unavailable. Kept separate; check manually.'
      : page.sources || first.height > first.width ? 'Portrait page kept separate.'
      : 'Uncertain landscape image: no complete strip group found. Kept separate.';
    for (let member = index; member <= end; member++) {
      result.push(pages[member].selected ? { page: pages[member], pageNumber: number, note }
        : { page: pages[member], note: 'Excluded' });
    }
    number++; index = end + 1;
  }
  return result;
}

// Explicit fallback: group by a target height without relying on white borders
// or complete portrait reference pages. Never resize, crop, or consume partial groups.
function suggestPagesByHeight(pages: ReviewPage[], targetHeight: number, tolerancePercent = 1): PageSuggestion[] {
  if (!Number.isSafeInteger(targetHeight) || targetHeight < 1 || targetHeight > 32767) {
    throw new Error('Enter a whole target height between 1 and 32767 pixels.');
  }
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 10) {
    throw new Error('Enter a height tolerance between 0 and 10 percent.');
  }
  const tolerance = targetHeight * tolerancePercent / 100;
  const minimum = Math.ceil(targetHeight - tolerance - 1e-9);
  const maximum = Math.min(32767, Math.floor(targetHeight + tolerance + 1e-9));
  const validDimensions = (page: ReviewPage): boolean => Number.isSafeInteger(page.width)
    && page.width > 0 && Number.isSafeInteger(page.height) && page.height > 0;
  const result: PageSuggestion[] = [];
  let number = 1;
  let index = 0;
  while (index < pages.length) {
    const first = pages[index];
    if (!first.selected) { result.push({ page: first, note: 'Excluded' }); index++; continue; }
    let end = index;
    let bestHeight = first.height;
    if (!first.sources && validDimensions(first) && first.height < minimum) {
      let height = first.height;
      let minWidth = first.width, maxWidth = first.width;
      for (let next = index + 1; next < pages.length; next++) {
        const candidate = pages[next];
        if (!candidate.selected) continue;
        if (candidate.sources || !validDimensions(candidate)) break;
        minWidth = Math.min(minWidth, candidate.width); maxWidth = Math.max(maxWidth, candidate.width);
        if (minWidth / maxWidth < 0.95) break;
        height += candidate.height;
        if (height > maximum) break;
        if (height >= minimum && (end === index || Math.abs(height - targetHeight) < Math.abs(bestHeight - targetHeight))) {
          end = next; bestHeight = height;
        }
        if (height === targetHeight) break;
      }
    }
    const note = end > index ? 'Suggested group: total height ' + bestHeight + ' px (target ' + targetHeight
      + ' px, tolerance ' + tolerancePercent + '%). Verify alignment before merging.'
      : first.sources ? 'Already merged page kept separate.'
      : !validDimensions(first) ? 'Image dimensions unavailable. Kept separate; check manually.'
      : first.height >= minimum && first.height <= maximum ? 'Already at target height within tolerance (' + first.height + ' px). Kept separate.'
      : 'No group within ' + tolerancePercent + '% of ' + targetHeight + ' px found. Kept separate; check manually.';
    for (let member = index; member <= end; member++) {
      result.push(pages[member].selected ? { page: pages[member], pageNumber: number, note }
        : { page: pages[member], note: 'Excluded' });
    }
    // A failed candidate advances by one image, allowing later groups to resynchronize.
    number++; index = end + 1;
  }
  return result;
}

function numberedPageGroups(pages: ReviewPage[]): ReviewPage[][] {
  const groups = new Map<number, { page: ReviewPage; index: number }[]>();
  pages.filter(page => page.selected).forEach((page, index) => {
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
      throw new Error('Page ' + number + ': only excluded images may separate images with the same number. Included images must be consecutive.');
    }
    if (group.length > 1) result.push(group.map(entry => entry.page));
  }
  return result;
}
