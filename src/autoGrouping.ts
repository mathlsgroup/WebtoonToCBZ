type AutoPageSuggestion = PageSuggestion & { selected: boolean };
type AutoGroupingResult = { ratio: number; suggestions: AutoPageSuggestion[] };

// Analyze metadata only. No image is deleted, converted, or changed by this planner.
function suggestPagesAutomatically(pages: ReviewPage[], options: {
  ratio?: number; tolerancePercent: number; minimumWidth?: number;
}): AutoGroupingResult {
  const { tolerancePercent, minimumWidth } = options;
  if (!Number.isFinite(tolerancePercent) || tolerancePercent < 0 || tolerancePercent > 20) {
    throw new Error('Enter a ratio tolerance between 0 and 20 percent.');
  }
  if (minimumWidth !== undefined && (!Number.isSafeInteger(minimumWidth) || minimumWidth < 1)) {
    throw new Error('Enter a positive whole minimum width, or leave it blank.');
  }
  if (options.ratio !== undefined && (!Number.isFinite(options.ratio) || options.ratio <= 1)) {
    throw new Error('Enter a portrait height/width ratio greater than 1, or leave it blank for automatic estimation.');
  }
  const valid = (page: ReviewPage): boolean => Number.isSafeInteger(page.width) && page.width > 0
    && Number.isSafeInteger(page.height) && page.height > 0;
  const tooNarrow = (page: ReviewPage): boolean => minimumWidth !== undefined && valid(page) && page.width < minimumWidth;
  const references = pages.filter(page => page.selected && !page.keepSeparate && !tooNarrow(page) && valid(page));
  const edges = new Map(references.map(page => [page.url, {
    width: page.width, height: page.height, topWhite: false, bottomWhite: false,
  }]));
  const ratio = options.ratio ?? referencePageRatio(references, edges);
  if (ratio === undefined) {
    throw new Error('No reliable portrait ratio found. Keep at least two similar complete portrait pages included, or enter a reference height/width ratio. Nothing was changed.');
  }
  const lower = ratio * (1 - tolerancePercent / 100);
  const upper = ratio * (1 + tolerancePercent / 100);
  const fits = (value: number): boolean => value >= lower - 1e-9 && value <= upper + 1e-9;
  const whole = (page: ReviewPage): boolean => !!page.sources || !!page.keepSeparate
    || (valid(page) && fits(page.height / page.width));
  const suggestions: AutoPageSuggestion[] = pages.map(page => ({
    page, selected: page.selected, note: page.selected ? '' : page.groupingNote ?? 'Previously excluded; unchanged.',
  }));
  const active = pages.flatMap((page, index) => page.selected ? [index] : []);
  let number = 1;
  let cursor = 0;
  while (cursor < active.length) {
    const index = active[cursor], first = pages[index], suggestion = suggestions[index];
    // Explicitly restored exceptions and existing merges are protected from reclassification.
    if (first.keepSeparate || first.sources || !valid(first)) {
      suggestion.pageNumber = number++;
      suggestion.note = first.keepSeparate ? 'Exception: kept as a separate page.'
        : first.sources ? 'Existing merged page kept separate.' : 'Unknown dimensions: retained for manual review.';
      cursor++; continue;
    }
    if (!tooNarrow(first) && whole(first)) {
      suggestion.pageNumber = number++;
      suggestion.note = 'Complete page: ratio matches the chapter reference.';
      cursor++; continue;
    }
    let bestEnd = cursor;
    let bestMembers: number[] = [];
    let bestRatio = Infinity;
    if (!tooNarrow(first) && first.height / first.width < lower) {
      let height = first.height, minWidth = first.width, maxWidth = first.width;
      const members = [index];
      for (let next = cursor + 1; next < active.length; next++) {
        const member = active[next], candidate = pages[member];
        if (candidate.keepSeparate || candidate.sources || !valid(candidate)) break;
        if (tooNarrow(candidate)) continue;
        if (whole(candidate)) break;
        // Smaller incompatible previews may be interleaved with real strips.
        // A larger width starts a different sequence; never jump across it.
        if (candidate.width < maxWidth * 0.95) continue;
        if (Math.min(minWidth, candidate.width) / Math.max(maxWidth, candidate.width) < 0.95) break;
        minWidth = Math.min(minWidth, candidate.width); maxWidth = Math.max(maxWidth, candidate.width);
        height += candidate.height;
        members.push(member);
        const combined = height / maxWidth;
        if (height > 32767 || maxWidth > 32767 || height * maxWidth > 64 * 1024 * 1024 || combined > upper + 1e-9) break;
        if (fits(combined) && Math.abs(combined - ratio) < Math.abs(bestRatio - ratio)) {
          bestEnd = next; bestMembers = [...members]; bestRatio = combined;
        }
      }
    }
    if (bestMembers.length > 1) {
      const members = new Set(bestMembers);
      for (let position = cursor; position <= bestEnd; position++) {
        const member = active[position], target = suggestions[member];
        target.selected = members.has(member);
        if (target.selected) {
          target.pageNumber = number;
          target.note = 'Auto group: height/width ' + bestRatio.toFixed(4) + ', reference ' + ratio.toFixed(4) + '. Check boundaries.';
        } else target.note = 'Auto excluded: narrower preview between strips. Review for exceptions.';
      }
      number++; cursor = bestEnd + 1;
    } else {
      suggestion.selected = false;
      suggestion.note = tooNarrow(first) ? 'Auto excluded: width below the chosen minimum.'
        : 'Auto excluded: no complete page or strip group matches the reference ratio. Check for a double page or missing strips.';
      cursor++;
    }
  }
  return { ratio, suggestions };
}
