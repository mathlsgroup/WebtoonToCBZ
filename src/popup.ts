(() => {
  type Entry = ReviewPage;
  type State = { capturing: boolean; generation: string; title: string; entries: Entry[]; missing: number; archived?: boolean; archiveError?: string; captureNotice?: string; pendingSaves?: number; savedCount?: number; unsavedCount?: number };
  const statusElement = document.getElementById('status')!;
  const list = document.getElementById('list')!;
  const titleInput = document.getElementById('title') as HTMLInputElement;
  const exportButton = document.getElementById('export') as HTMLButtonElement;
  const review = new URLSearchParams(location.search).has('tab');
  let tabId: number;
  let sourceUrl = '';
  const automaticOption = document.getElementById('auto-continue') as HTMLInputElement | null;
  let entries: Entry[] = [];
  let generation = '';
  let busy = false;
  let missing = 0;
  let archivedMode = false;
  let previewCacheVersion: number | undefined;
  let previewCacheWarning = '';
  const mergeSelected = new Set<string>();
  const mergeButton = document.getElementById('merge') as HTMLButtonElement | null;
  const undoButton = document.getElementById('undo') as HTMLButtonElement | null;
  const numberedMergeButton = document.getElementById('merge-numbered') as HTMLButtonElement | null;
  const detectButton = document.getElementById('detect') as HTMLButtonElement | null;
  const hideExcluded = document.getElementById('hide-excluded') as HTMLInputElement | null;
  const heightButton = document.getElementById('detect-height') as HTMLButtonElement | null;
  const targetHeightInput = document.getElementById('target-height') as HTMLInputElement | null;
  const heightToleranceInput = document.getElementById('height-tolerance') as HTMLInputElement | null;
  const minimumWidthInput = document.getElementById('minimum-width') as HTMLInputElement | null;
  const excludeNarrowButton = document.getElementById('exclude-narrow') as HTMLButtonElement | null;
  const autoButton = document.getElementById('auto-analyze') as HTMLButtonElement | null;
  const autoRatioInput = document.getElementById('auto-ratio') as HTMLInputElement | null;
  const autoToleranceInput = document.getElementById('auto-tolerance') as HTMLInputElement | null;
  const reviewExcludedButton = document.getElementById('review-excluded') as HTMLButtonElement | null;
  let excludedOnly = false;
  const objectUrls = new Set<string>();
  const mergeHistory: string[] = [];
  function ensurePageNumbers(): void {
    let next = entries.reduce((max, page) => Number.isSafeInteger(page.pageNumber)
      ? Math.max(max, page.pageNumber!) : max, 0) + 1;
    for (const page of entries) if (page.selected && page.pageNumber === undefined) page.pageNumber = next++;
  }
  function updateSelection(): void {
    if (!mergeButton || !undoButton) return;
    let message = 'Select at least two consecutive included pages with the Merge checkboxes.';
    let valid = false;
    try { const pages = mergeSelection(entries, mergeSelected); valid = true; message = pages.length + ' consecutive pages selected.'; }
    catch (error) { if (mergeSelected.size) message = String(error); }
    mergeButton.disabled = busy || !valid;
    undoButton.disabled = busy || !entries.some(page => page.sources);
    document.getElementById('selection')!.textContent = entries.filter(page => page.selected).length + ' included, '
      + entries.filter(page => !page.selected).length + ' excluded. ' + message;
    try {
      const groups = numberedPageGroups(entries);
      numberedMergeButton!.disabled = busy || !groups.length;
      document.getElementById('numbering')!.textContent = groups.length
        ? groups.length + ' numbered group(s) ready to merge. Check the assignments first.'
        : 'Edit page numbers or use Suggest page numbers to prepare groups.';
    } catch (error) {
      numberedMergeButton!.disabled = true;
      document.getElementById('numbering')!.textContent = String(error);
    }
    detectButton!.disabled = busy || !entries.some(page => page.selected);
    heightButton!.disabled = busy || !entries.some(page => page.selected);
    autoButton!.disabled = busy || !entries.some(page => page.selected);
    reviewExcludedButton!.disabled = busy;
    reviewExcludedButton!.textContent = excludedOnly ? 'Back to pages'
      : 'Review excluded (' + entries.filter(page => !page.selected).length + ')';
    const counts = new Map<number, number>();
    for (const page of entries) if (page.selected && page.pageNumber !== undefined) {
      counts.set(page.pageNumber, (counts.get(page.pageNumber) ?? 0) + 1);
    }
    Array.from(list.children).forEach((row, index) => {
      row.classList.toggle('numbered-group', entries[index].selected && (counts.get(entries[index].pageNumber!) ?? 0) > 1);
    });
  }
  function syncOrder(): Promise<State> {
    return send('reorder', { urls: entries.flatMap(originalPages).map(page => page.url) });
  }
  function undo(page: Entry): void {
    entries = undoMergedPage(entries, page);
    mergeSelected.delete(page.url);
    URL.revokeObjectURL(page.url); objectUrls.delete(page.url);
    render();
    void safe(async () => { await syncOrder(); });
  }
  window.addEventListener('unload', () => { objectUrls.forEach(url => URL.revokeObjectURL(url)); });

  function setStatus(value: string): void { statusElement.textContent = value; }
  async function send(action: string, extra: object = {}): Promise<State> {
    if (action === 'start') archivedMode = false;
    let live: State | undefined;
    if (!archivedMode || action === 'start') {
      try { live = await browser.tabs.sendMessage(tabId, { action, ...extra }); }
      catch { /* Navigation can destroy the source script; use the saved capture. */ }
      if (live && (live.entries.length || live.capturing || action === 'start')) return live;
    }
    try {
      const stored = await browser.runtime?.sendMessage?.({ action: 'archive-request', command: action, tabId, ...extra });
      if (stored && !stored.error) { archivedMode = true; return stored; }
    } catch { /* Report the original source failure if no saved capture exists. */ }
    if (live) return live;
    throw new Error('Capture unavailable: the source tab was closed or navigated and no saved capture is available.');
  }
  async function safe(action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { setStatus(String(error)); }
  }
  function unavailableBlob(pages: Entry[]): string | undefined {
    const missing = pages.filter(page => page.url.startsWith('blob:') && !page.bytes && (review || !page.previewUrl));
    return missing.find(page => page.captureError)?.captureError
      ?? (missing.length ? 'Captured blob bytes unavailable. Refresh the review.' : undefined);
  }
  async function loadBlobPreviews(): Promise<State | undefined> {
    const pages = entries.flatMap(originalPages).filter(page => page.url.startsWith('blob:') && !page.bytes && (review || !page.previewUrl));
    if (!pages.length) return;
    const previousBusy = busy;
    busy = true; render();
    try {
      if (!review && browser.runtime?.sendMessage) {
        try {
          const cached = await browser.runtime.sendMessage({ action: 'archive-preview-get', tabId, generation, urls: pages.map(page => page.url) });
          if (cached?.error) throw new Error(cached.error);
          if (cached?.generation !== generation || !Number.isSafeInteger(cached.previewVersion) || !Array.isArray(cached.previews)) {
            throw new Error('Invalid thumbnail cache response.');
          }
          previewCacheVersion = cached.previewVersion;
          previewCacheWarning = '';
          for (const thumbnail of cached.previews as { url: string; dataUrl: string }[]) {
            const page = pages.find(page => page.url === thumbnail.url);
            if (page && typeof thumbnail.dataUrl === 'string' && thumbnail.dataUrl.startsWith('data:image/png;base64,')
              && thumbnail.dataUrl.length <= 256 * 1024) { page.previewUrl = thumbnail.dataUrl; page.captureError = undefined; }
          }
          render();
        } catch (error) { previewCacheVersion = undefined; previewCacheWarning = String(error); }
      }
      const uncached = pages.filter(page => review || !page.previewUrl);
      for (const [index, page] of uncached.entries()) {
        setStatus('Reading captured local image ' + (index + 1) + '/' + uncached.length + '...');
        try {
          const bytes = await readCapturedBlob(tabId, generation, page.url);
          const extension = imageExtension(bytes);
          const preview = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: extension === 'jpg' ? 'image/jpeg' : 'image/' + extension }));
          page.bytes = bytes; page.previewUrl = preview; page.captureError = undefined;
          objectUrls.add(preview);
          render(); // Show each successful preview without waiting for the chapter.
          if (!review && previewCacheVersion !== undefined) {
            try {
              const thumbnail = await createCapturedThumbnail(bytes);
              const stored = await browser.runtime.sendMessage({ action: 'archive-preview-put', tabId, generation,
                url: page.url, dataUrl: thumbnail, previewVersion: previewCacheVersion });
              if (!stored?.ok) throw new Error(stored?.error || 'Thumbnail save was not confirmed.');
              page.previewUrl = thumbnail;
              page.bytes = undefined; // Popup needs only the thumbnail; originals stay archived.
              URL.revokeObjectURL(preview); objectUrls.delete(preview);
            } catch (error) { previewCacheWarning = String(error); }
          }
        } catch (error) { page.captureError = String(error); }
        render();
      }
      // Automatic PNG fallback may finish after the initial snapshot was sent.
      // Refresh metadata so successful pixel captures are never labelled original.
      const current = await send('status');
      if (current.generation !== generation) throw new Error('Capture changed. Refresh the review.');
      for (const page of pages) {
        const entry = current.entries.find(entry => entry.url === page.url);
        if (entry?.reencoded) page.reencoded = true;
        if (entry?.saveState) { page.saveState = entry.saveState; page.saveError = entry.saveError; }
      }
      return current;
    } finally {
      busy = previousBusy;
      if (!busy) for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
    }
  }
  async function verifyCapture(): Promise<void> {
    const state = await send('status');
    if (state.generation !== generation) {
      await refresh(); throw new Error('Capture changed. Review the new list before continuing.');
    }
  }
  async function persistInclusion(page: Entry, selected: boolean): Promise<void> {
    for (const source of originalPages(page)) {
      const state = await send('select', { url: source.url, selected });
      if (state.generation !== generation) {
        await refresh(); throw new Error('Capture changed. Review the new list before continuing.');
      }
    }
  }
  function restoreExcludedPage(page: Entry): void {
    if (busy) return;
    busy = true; render();
    void safe(async () => {
      try {
        await verifyCapture(); await persistInclusion(page, true);
        includeReviewPage(page, true);
        page.keepSeparate = true; page.pageNumber = undefined;
        page.groupingNote = 'Exception: manually restored as a separate page. Protected during automatic analysis.';
        setStatus('Page restored. Use Back to pages to review it.');
      } finally {
        busy = false;
        for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
        render();
      }
    });
  }
  function runReviewTask(pages: Entry[], message: string, task: (verify: () => Promise<void>) => Promise<void>): void {
    if (busy) return;
    const unavailable = unavailableBlob(pages);
    if (unavailable) { setStatus(unavailable); return; }
    const origins = [...new Set(pages.filter(page => !page.bytes && /^https?:/.test(page.url)).map(page => new URL(page.url).origin + '/*'))];
    // Host access must be requested in the click handler, before the first await.
    const permission = origins.length ? browser.permissions.request({ origins }) : Promise.resolve(true);
    busy = true; render(); setStatus(message);
    void safe(async () => {
      const verify = async (): Promise<void> => {
        const state = await send('status');
        if (state.generation !== generation) {
          await refresh(); throw new Error('Capture changed. Review the new list before continuing.');
        }
      };
      try {
        if (!await permission) throw new Error('Image host access was not granted.');
        const state = await send('stop');
        if (state.generation !== generation) {
          await refresh(); throw new Error('Capture changed. Review the new list before continuing.');
        }
        await task(verify);
      } finally {
        busy = false;
        for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
        render();
      }
    });
  }
  function mergeGroups(groups: Entry[][]): void {
    runReviewTask(groups.flat(), 'Merging images. Keep this review tab open...', async verify => {
      const created: Entry[] = [];
      let committed = false;
      try {
        let result = entries;
        for (const [index, sources] of groups.entries()) {
          setStatus('Merging group ' + (index + 1) + '/' + groups.length + '...');
          const merged = await mergeImagesVertically(sources);
          created.push(merged);
          result = replaceMergedPages(result, sources, merged);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        await verify();
        entries = result;
        for (const page of created) { objectUrls.add(page.url); mergeHistory.push(page.url); }
        committed = true; mergeSelected.clear();
        setStatus('Merged ' + groups.length + ' group(s). Check Preview; Undo merge restores the sources.');
      } finally {
        // Failed batches leave every row intact and release provisional images.
        if (!committed) created.forEach(page => URL.revokeObjectURL(page.url));
      }
    });
  }
  function render(): void {
    if (review) ensurePageNumbers();
    list.replaceChildren();
    entries.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'entry' + (mergeSelected.has(item.url) ? ' merge-selected' : '');
      row.hidden = excludedOnly ? item.selected : !!hideExcluded?.checked && !item.selected;
      const check = document.createElement('input');
      check.type = 'checkbox'; check.checked = item.selected;
      check.setAttribute('aria-label', 'Include page ' + (index + 1));
      check.onchange = () => {
        if (!check.checked) mergeSelected.delete(item.url);
        includeReviewPage(item, check.checked); render();
        void safe(async () => { for (const source of originalPages(item)) { source.selected = item.selected; await send('select', { url: source.url, selected: item.selected }); } });
      };
      const preview = document.createElement('img');
      if (item.previewUrl || !item.url.startsWith('blob:')) preview.src = item.previewUrl ?? item.url;
      preview.alt = item.captureError ? 'Preview unavailable' : item.url.startsWith('blob:') && !item.previewUrl ? 'Loading capture...' : 'Page preview';
      preview.loading = 'lazy';
      const caption = document.createElement('span');
      caption.textContent = (index + 1) + ' · ' + item.width + '×' + item.height;
      row.append(check, preview, caption);
      if (!review) {
        const note = document.createElement('small'); note.className = 'grouping-note';
        note.textContent = item.captureError || (item.saveState === 'saved' ? 'Saved locally.'
          : item.saveError || (item.url.startsWith('blob:') ? 'Saving locally...' : ''));
        caption.append(document.createElement('br'), note);
        preview.onerror = () => {
          note.textContent = item.captureError || 'Image preview could not be loaded. Use Refresh to retry.';
          if (item.previewUrl?.startsWith('data:')) {
            item.previewUrl = undefined;
            void browser.runtime?.sendMessage?.({ action: 'archive-preview-delete', tabId, generation,
              url: item.url, previewVersion: previewCacheVersion }).catch(() => {});
          }
        };
      }
      if (review) {
        const numberLabel = document.createElement('label'); numberLabel.className = 'page-number';
        const number = document.createElement('input');
        number.type = 'number'; number.min = '1'; number.step = '1';
        number.value = item.pageNumber === undefined ? '' : String(item.pageNumber);
        number.disabled = busy || !item.selected;
        number.setAttribute('aria-label', 'Page number for image ' + (index + 1));
        number.oninput = () => {
          item.pageNumber = number.valueAsNumber; item.groupingNote = 'Manual assignment';
          note.textContent = item.groupingNote; updateSelection();
        };
        numberLabel.append('Page number', number); row.append(numberLabel);
        const note = document.createElement('small'); note.className = 'grouping-note';
        note.textContent = [item.captureError, item.reencoded ? 'PNG re-encoded from displayed pixels; original file bytes not retained.' : '',
          item.saveState === 'saved' ? 'Saved locally.' : item.saveState === 'pending' ? 'Saving locally: wait before leaving the document.' : item.saveError,
          item.groupingNote].filter(Boolean).join(' '); caption.append(document.createElement('br'), note);
        if (item.captureError && item.url.startsWith('blob:') && !item.bytes) {
          const pixels = document.createElement('button');
          pixels.textContent = 'Use displayed pixels (PNG)'; pixels.disabled = busy;
          pixels.onclick = () => {
            if (busy) return;
            busy = true; render();
            void safe(async () => {
              try {
                await verifyCapture();
                const result = await browser.tabs.sendMessage(tabId, {
                  action: 'capture-displayed-pixels', generation, url: item.url,
                });
                if (result?.error) throw new Error(result.error);
                item.reencoded = Boolean(result?.reencoded);
                await loadBlobPreviews();
                if (!item.bytes) throw new Error(item.captureError || 'Displayed image remains unavailable.');
                setStatus(item.reencoded ? 'Captured displayed pixels as PNG. This page is re-encoded; inspect its preview before exporting.' : 'Original image bytes recovered.');
              } finally { busy = false; render(); }
            });
          };
          caption.append(pixels);
        }
        const selectLabel = document.createElement('label');
        const select = document.createElement('input'); select.type = 'checkbox';
        select.checked = mergeSelected.has(item.url); select.disabled = busy;
        select.setAttribute('aria-label', 'Select page ' + (index + 1) + ' for merging');
        select.onchange = () => {
          if (select.checked) mergeSelected.add(item.url); else mergeSelected.delete(item.url);
          row.classList.toggle('merge-selected', select.checked); updateSelection();
        };
        selectLabel.append(select, 'Merge'); row.append(selectLabel);
        const enlarge = document.createElement('button'); enlarge.textContent = 'Preview';
        enlarge.onclick = () => {
          const dialog = document.getElementById('large-preview') as HTMLDialogElement;
          dialog.querySelector('img')!.src = item.previewUrl ?? item.url; dialog.showModal();
        };
        row.append(enlarge);
        if (!item.selected) {
          const restorePage = document.createElement('button'); restorePage.textContent = 'Restore as page';
          restorePage.disabled = busy; restorePage.onclick = () => restoreExcludedPage(item); row.append(restorePage);
        }
        if (item.sources) {
          const restore = document.createElement('button'); restore.textContent = 'Undo merge';
          restore.disabled = busy; restore.onclick = () => undo(item); row.append(restore);
        }
        for (const [label, offset] of [['Up', -1], ['Down', 1]] as const) {
          let target = index + offset;
          while (target >= 0 && target < entries.length
            && (excludedOnly ? entries[target].selected : hideExcluded?.checked && !entries[target].selected)) target += offset;
          const button = document.createElement('button');
          button.textContent = label;
          button.disabled = target < 0 || target >= entries.length;
          button.onclick = () => {
            [entries[index], entries[target]] = [entries[target], entries[index]];
            render();
            void safe(async () => { await syncOrder(); });
          };
          row.append(button);
        }
      }
      list.append(row);
    });
    if (busy) for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = true;
    exportButton.disabled = busy || entries.length === 0;
    updateSelection();
  }
  async function refresh(action = 'images'): Promise<void> {
    let state = await send(action);
    const byUrl = new Map(state.entries.map(entry => [entry.url, entry]));
    if (generation === state.generation) {
      const known = new Set(entries.flatMap(originalPages).map(page => page.url));
      for (const page of entries.flatMap(originalPages)) {
        if (byUrl.get(page.url)?.reencoded) page.reencoded = true;
        const entry = byUrl.get(page.url);
        if (entry?.saveState) { page.saveState = entry.saveState; page.saveError = entry.saveError; }
      }
      for (const page of entries) {
        if (!page.sources) page.selected = byUrl.get(page.url)?.selected ?? page.selected;
      }
      entries.push(...state.entries.filter(page => !known.has(page.url)));
    } else {
      objectUrls.forEach(url => URL.revokeObjectURL(url)); objectUrls.clear();
      mergeSelected.clear(); mergeHistory.length = 0;
      excludedOnly = false;
      if (review) document.getElementById('auto-summary')!.textContent = 'Automatic analysis proposes all groups and sets aside nonmatching images. Check exclusions before merging.';
      entries = state.entries;
    }
    generation = state.generation;
    missing = state.missing;
    if (state.title) titleInput.value = state.title;
    else if (titleInput.value) await send('title', { title: titleInput.value });
    const latest = await loadBlobPreviews();
    if (latest) { state = latest; missing = latest.missing; }
    let automatic: { enabled: boolean; pauseReason?: string } | undefined;
    if (automaticOption && browser.runtime?.sendMessage) {
      const navigation = await browser.runtime.sendMessage({ action: 'navigation-status', tabId });
      automatic = navigation?.autoResume;
      if (automatic) automaticOption.checked = automatic.enabled;
      else if (state.entries.length) automaticOption.checked = false;
    }
    render();
    setStatus((state.archived ? 'Saved capture (source page changed). ' : state.capturing ? 'Capturing. ' : 'Stopped. ') + entries.length
      + ' images. Check order and exclude unwanted images.'
      + (missing ? ' WARNING: ' + missing + ' chapter/viewed image(s) missing, unread or not loaded. Continue reading with capture active.' : '')
      + (unavailableBlob(entries) ? ' WARNING: some local image bytes are unavailable; see row errors.' : '')
      + (state.pendingSaves ? ' Saving local image data; wait before navigating.' : '')
      + (state.savedCount !== undefined ? ' Saved locally: ' + state.savedCount + '. Not yet saved: ' + (state.unsavedCount ?? 0) + '.' : '')
      + (state.archiveError ? ' WARNING: local backup failed: ' + state.archiveError : ''));
    if (state.captureNotice) setStatus(statusElement.textContent + ' ' + state.captureNotice);
    if (automatic?.enabled) setStatus(statusElement.textContent + (automatic.pauseReason
      ? ' Automatic continuation paused: ' + automatic.pauseReason : ' Automatic continuation on.'));
    if (previewCacheWarning) setStatus(statusElement.textContent + ' Thumbnail cache unavailable; previews may reload.');
  }
  function automaticPermission(enabled: boolean): Promise<boolean> {
    if (!enabled) return Promise.resolve(true);
    if (!sourceUrl) return Promise.resolve(false);
    // Must run directly in the Start/checkbox gesture, before awaiting any API.
    return browser.permissions.request({ origins: [new URL(sourceUrl).origin + '/*'] });
  }
  async function controlAutomatic(enabled: boolean, state: State): Promise<void> {
    const option = document.getElementById('auto-pixels') as HTMLInputElement | null;
    const result = await browser.runtime.sendMessage({ action: 'navigation-control', tabId, enabled,
      generation: state.generation, autoPixels: option?.checked ?? false, includeNextChapters: true });
    if (result?.error) throw new Error(result.error);
    if (enabled) archivedMode = false;
  }
  document.getElementById('start')!.onclick = () => {
    if (busy) return;
    const enabled = automaticOption?.checked ?? false;
    const permission = automaticPermission(enabled);
    return safe(async () => {
      const granted = await permission;
      archivedMode = false;
      const option = document.getElementById('auto-pixels') as HTMLInputElement | null;
      const state = await send('start', { autoPixels: option?.checked ?? false });
      if (enabled && granted) await controlAutomatic(true, state);
      if (enabled && !granted && automaticOption) automaticOption.checked = false;
      await refresh();
      if (enabled && !granted) setStatus(statusElement.textContent + ' Automatic continuation off: site access was not granted.');
    });
  };
  if (automaticOption) automaticOption.onchange = () => {
    if (busy) return;
    const enabled = automaticOption.checked;
    const permission = automaticPermission(enabled);
    return safe(async () => {
      if (!await permission) { automaticOption.checked = false; throw new Error('Site access was not granted. Automatic continuation remains off.'); }
      const state = await send('status');
      if (enabled && state.pendingSaves && !state.capturing) throw new Error('Wait for local saving to finish.');
      await controlAutomatic(enabled, state);
      await refresh();
    });
  };
  document.getElementById('stop')!.onclick = () => safe(async () => { if (!busy) await refresh('stop'); });
  document.getElementById('refresh')!.onclick = () => safe(async () => { if (!busy) await refresh(); });
  titleInput.oninput = () => { void safe(async () => { await send('title', { title: titleInput.value }); }); };

  if (review) {
    hideExcluded!.onchange = () => { if (!busy) { excludedOnly = false; render(); } };
    reviewExcludedButton!.onclick = () => { if (!busy) { excludedOnly = !excludedOnly; render(); } };
    autoButton!.onclick = () => {
      if (busy) return;
      let plan: AutoGroupingResult;
      try {
        plan = suggestPagesAutomatically(entries, {
          ratio: autoRatioInput!.value?.trim() ? autoRatioInput!.valueAsNumber : undefined,
          tolerancePercent: autoToleranceInput!.valueAsNumber,
          minimumWidth: minimumWidthInput!.value?.trim() ? minimumWidthInput!.valueAsNumber : undefined,
        });
      } catch (error) {
        setStatus(String(error)); document.getElementById('auto-summary')!.textContent = String(error); return;
      }
      busy = true; render(); setStatus('Applying automatic analysis...');
      void safe(async () => {
        try {
          await verifyCapture();
          for (const suggestion of plan.suggestions) {
            if (suggestion.selected !== suggestion.page.selected) await persistInclusion(suggestion.page, suggestion.selected);
          }
          await verifyCapture();
          for (const suggestion of plan.suggestions) {
            includeReviewPage(suggestion.page, suggestion.selected);
            suggestion.page.pageNumber = suggestion.pageNumber;
            suggestion.page.groupingNote = suggestion.note;
          }
          mergeSelected.clear(); excludedOnly = false; hideExcluded!.checked = true;
          const groups = numberedPageGroups(entries);
          const excluded = entries.filter(page => !page.selected).length;
          const message = 'Reference height/width ' + plan.ratio.toFixed(4) + ': ' + groups.length
            + ' group(s) ready to merge, ' + excluded + ' excluded image(s). Review excluded images, then Merge numbered pages.';
          setStatus(message); document.getElementById('auto-summary')!.textContent = message;
        } finally {
          busy = false;
          for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
          render();
        }
      });
    };
    excludeNarrowButton!.onclick = () => {
      if (busy) return;
      const minimum = minimumWidthInput!.valueAsNumber;
      if (!Number.isSafeInteger(minimum) || minimum < 1) {
        setStatus('Enter a positive whole minimum width in pixels.'); return;
      }
      const affected = entries.filter(page => page.selected && Number.isFinite(page.width) && page.width > 0 && page.width < minimum);
      busy = true; render();
      void safe(async () => {
        try {
          const state = await send('status');
          if (state.generation !== generation) {
            await refresh(); throw new Error('Capture changed. Review the new list before excluding images.');
          }
          for (const page of affected) {
            for (const source of originalPages(page)) {
              const updated = await send('select', { url: source.url, selected: false });
              if (updated.generation !== generation) {
                await refresh(); throw new Error('Capture changed. Review the new list before excluding images.');
              }
            }
            includeReviewPage(page, false); mergeSelected.delete(page.url);
          }
          setStatus(affected.length + ' image(s) narrower than ' + minimum + ' px excluded. '
            + 'Use Hide excluded images to hide them. Re-enable individual images with their inclusion checkbox.');
        } finally {
          busy = false;
          for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
          render();
        }
      });
    };
    heightButton!.onclick = () => {
      if (busy) return;
      try {
        const target = targetHeightInput!.valueAsNumber;
        const tolerance = heightToleranceInput!.valueAsNumber;
        const suggestions = suggestPagesByHeight(entries, target, tolerance);
        for (const suggestion of suggestions) {
          suggestion.page.pageNumber = suggestion.pageNumber;
          suggestion.page.groupingNote = suggestion.note;
        }
        render();
        const groups = numberedPageGroups(entries);
        setStatus(groups.length + ' group(s) suggested near ' + target + ' px (tolerance ' + tolerance + '%) using captured dimensions. '
          + 'Check the groups, then click Merge numbered pages. Unmatched images remain separate.');
      } catch (error) { setStatus(String(error)); }
    };
    document.getElementById('close-preview')!.onclick = () => (document.getElementById('large-preview') as HTMLDialogElement).close();
    undoButton!.onclick = () => {
      const page = [...mergeHistory].reverse().map(url => entries.find(entry => entry.url === url)).find(entry => entry?.sources);
      if (page && !busy) undo(page);
    };
    detectButton!.onclick = () => {
      const pages = entries.filter(page => page.selected);
      runReviewTask(pages, 'Analyzing image borders. Keep this review tab open...', async verify => {
        const edges = new Map<string, PageEdges>();
        const failures = new Map<string, string>();
        for (const [index, page] of pages.entries()) {
          const message = 'Analyzing image ' + (index + 1) + '/' + pages.length + '...';
          setStatus(message); document.getElementById('numbering')!.textContent = message;
          try { edges.set(page.url, await inspectPageEdges(page)); }
          catch (error) { failures.set(page.url, 'Analysis failed: ' + String(error) + '. Check manually.'); }
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        await verify();
        for (const suggestion of suggestPageNumbers(entries, edges)) {
          suggestion.page.pageNumber = suggestion.pageNumber;
          suggestion.page.groupingNote = failures.get(suggestion.page.url) ?? suggestion.note;
        }
        setStatus('Page numbers suggested. Review and correct them, then click Merge numbered pages.'
          + (failures.size ? ' ' + failures.size + ' image(s) could not be analyzed and were kept separate.' : ''));
      });
    };
    numberedMergeButton!.onclick = () => {
      if (busy) return;
      try {
        const groups = numberedPageGroups(entries);
        if (!groups.length) { setStatus('Give consecutive images the same page number first.'); return; }
        mergeGroups(groups);
      } catch (error) { setStatus(String(error)); }
    };
    mergeButton!.onclick = () => {
      if (busy) return;
      let sources: Entry[];
      try { sources = mergeSelection(entries, mergeSelected); }
      catch (error) { setStatus(String(error)); return; }
      mergeGroups([sources]);
    };
  }

  exportButton.onclick = () => {
    if (busy) return;
    if (!review) {
      void safe(async () => {
        await browser.tabs.create({ url: browser.runtime.getURL('review.html') + '?tab=' + tabId });
      });
      return;
    }
    const selected = entries.filter(entry => entry.selected);
    if (!selected.length) { setStatus('Select at least one image.'); return; }
    const unavailable = unavailableBlob(selected);
    if (unavailable) { setStatus(unavailable); return; }
    try {
      if (numberedPageGroups(entries).length) {
        setStatus('Use Merge numbered pages before exporting, or assign different numbers to keep images separate.'); return;
      }
    } catch (error) { setStatus(String(error)); return; }
    // Request only image origins, directly inside the user gesture.
    const origins = [...new Set(selected.filter(page => !page.bytes && /^https?:/.test(page.url)).map(page => new URL(page.url).origin + '/*'))];
    busy = true;
    for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = true;
    const permission = origins.length ? browser.permissions.request({ origins }) : Promise.resolve(true);
    void safe(async () => {
      try {
        if (!await permission) throw new Error('Image host access was not granted.');
        const state = await send('stop');
        if (state.generation !== generation) {
          await refresh();
          throw new Error('Capture changed. Review the new list before exporting.');
        }
        missing = state.missing;
        if (missing) throw new Error(missing + ' chapter/viewed image(s) missing, unread or not loaded. Keep capture active while reading every chapter page, then refresh the review.');
        if (state.entries.some(entry => !entries.flatMap(originalPages).some(old => old.url === entry.url))) {
          await refresh();
          throw new Error('New images were found. Review them before exporting.');
        }
        await exportArchive(selected, titleInput.value, setStatus);
        // Clear only derived thumbnails, only after Firefox confirms the download.
        // Preserve captured originals and review edits for undo/re-export.
        if (browser.runtime?.sendMessage) {
          const savedMessage = statusElement.textContent;
          try {
            const cleared = await browser.runtime.sendMessage({ action: 'archive-preview-clear', tabId, generation });
            if (cleared?.error) throw new Error(cleared.error);
          } catch { setStatus(savedMessage + ' Thumbnail cache could not be cleared.'); }
        }
      } finally {
        busy = false;
        for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input')) control.disabled = false;
        render();
      }
    });
  };

  void safe(async () => {
    if (review) {
      tabId = Number(new URLSearchParams(location.search).get('tab'));
      if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid source tab.');
      document.getElementById('start')!.hidden = true;
      exportButton.textContent = 'Export selected images to CBZ';
    } else {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined || !/^https?:/.test(tab.url || '')) throw new Error('Open an HTTP(S) chapter tab first.');
      tabId = tab.id;
      sourceUrl = tab.url;
      await browser.scripting.executeScript({ target: { tabId }, files: ['navigationScope.js', 'content.js'] });
      titleInput.value = new URL(tab.url).pathname.split('/').filter(Boolean).slice(-2).join(' - ') || 'chapter';
    }
    await refresh('status');
  });
})();
